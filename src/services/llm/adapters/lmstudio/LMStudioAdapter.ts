/**
 * LM Studio Adapter
 * Provides local LLM models via LM Studio's OpenAI-compatible API
 * Supports model auto-discovery, streaming, and function calling
 *
 * Special support for fine-tuned models that use [TOOL_CALLS] content format
 * (e.g., Nexus tools SFT models) which embed tool calls in message content
 * rather than using the standard tool_calls array.
 */

import { requestUrl } from 'obsidian';
import { BaseAdapter } from '../BaseAdapter';
import {
  GenerateOptions,
  StreamChunk,
  LLMResponse,
  ModelInfo,
  ProviderCapabilities,
  ModelPricing,
  TokenUsage,
  LLMProviderError
} from '../types';
import { ToolCallContentParser } from './ToolCallContentParser';

export class LMStudioAdapter extends BaseAdapter {
  readonly name = 'lmstudio';
  readonly baseUrl: string;

  private serverUrl: string;

  constructor(serverUrl: string) {
    // LM Studio doesn't need an API key - set requiresApiKey to false
    super('', '', serverUrl, false);

    this.serverUrl = serverUrl;
    this.baseUrl = serverUrl;

    this.initializeCache();
  }

  /**
   * Generate response without caching using OpenAI-compatible chat completions API
   * Uses Obsidian's requestUrl to bypass CORS
   */
  async generateUncached(prompt: string, options?: GenerateOptions): Promise<LLMResponse> {
    try {
      const model = options?.model || this.currentModel;

      // Check for pre-built conversation history (tool continuations)
      let messages: any[];
      if (options?.conversationHistory && options.conversationHistory.length > 0) {
        messages = options.conversationHistory;
      } else {
        messages = this.buildMessages(prompt, options?.systemPrompt);
      }

      const requestBody: any = {
        model: model,
        messages: messages,
        stream: false,
        temperature: options?.temperature,
        max_tokens: options?.maxTokens,
        top_p: options?.topP,
        frequency_penalty: options?.frequencyPenalty,
        presence_penalty: options?.presencePenalty,
        stop: options?.stopSequences
      };

      // Add tools if provided (function calling support)
      // Skip for fine-tuned models that have internalized tool schemas (saves context window)
      const skipToolSchemas = LMStudioAdapter.usesToolCallsContentFormat(model);
      if (options?.tools && options.tools.length > 0 && !skipToolSchemas) {
        requestBody.tools = this.convertTools(options.tools);
      }

      // Add JSON mode if requested
      if (options?.jsonMode) {
        requestBody.response_format = { type: 'json_object' };
      }

      // Remove undefined values
      Object.keys(requestBody).forEach(key => {
        if (requestBody[key] === undefined) {
          delete requestBody[key];
        }
      });

      // Use Obsidian's requestUrl to bypass CORS
      const response = await requestUrl({
        url: `${this.serverUrl}/v1/chat/completions`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody)
      });

      if (response.status !== 200) {
        const errorText = response.text || 'Unknown error';
        throw new LLMProviderError(
          `LM Studio API error: ${response.status} - ${errorText}`,
          'generation',
          'API_ERROR'
        );
      }

      const data = response.json;

      if (!data.choices || !data.choices[0]) {
        throw new LLMProviderError(
          'Invalid response format from LM Studio API: missing choices',
          'generation',
          'INVALID_RESPONSE'
        );
      }

      const choice = data.choices[0];
      let content = choice.message?.content || '';
      let toolCalls = choice.message?.tool_calls || [];

      // Check for [TOOL_CALLS] format in content (used by fine-tuned models like Nexus)
      // This format embeds tool calls in the content rather than tool_calls array
      if (ToolCallContentParser.hasToolCallsFormat(content)) {
        const parsed = ToolCallContentParser.parse(content);

        if (parsed.hasToolCalls) {
          // Use parsed tool calls if standard tool_calls is empty
          if (toolCalls.length === 0) {
            toolCalls = parsed.toolCalls;
          }
          // Clean the content (remove [TOOL_CALLS] JSON)
          content = parsed.cleanContent;
        }
      }

      // Extract usage information
      const usage: TokenUsage = {
        promptTokens: data.usage?.prompt_tokens || 0,
        completionTokens: data.usage?.completion_tokens || 0,
        totalTokens: data.usage?.total_tokens || 0
      };

      const finishReason = this.mapFinishReason(choice.finish_reason);
      const metadata = {
        cached: false,
        model: data.model,
        id: data.id,
        created: data.created
      };

      return await this.buildLLMResponse(
        content,
        model,
        usage,
        metadata,
        // If we have tool calls, report tool_calls as finish reason
        toolCalls.length > 0 ? 'tool_calls' : finishReason,
        toolCalls
      );
    } catch (error) {
      if (error instanceof LLMProviderError) {
        throw error;
      }
      throw new LLMProviderError(
        `LM Studio generation failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'generation',
        'NETWORK_ERROR'
      );
    }
  }

  /**
   * Generate streaming response using async generator
   * Falls back to non-streaming if CORS is blocked
   *
   * Supports [TOOL_CALLS] content format from fine-tuned models
   */
  async* generateStreamAsync(prompt: string, options?: GenerateOptions): AsyncGenerator<StreamChunk, void, unknown> {
    try {
      const model = options?.model || this.currentModel;

      // Check for pre-built conversation history (tool continuations)
      let messages: any[];
      if (options?.conversationHistory && options.conversationHistory.length > 0) {
        messages = options.conversationHistory;
      } else {
        messages = this.buildMessages(prompt, options?.systemPrompt);
      }

      const requestBody: any = {
        model: model,
        messages: messages,
        stream: true,
        temperature: options?.temperature,
        max_tokens: options?.maxTokens,
        top_p: options?.topP,
        frequency_penalty: options?.frequencyPenalty,
        presence_penalty: options?.presencePenalty,
        stop: options?.stopSequences
      };

      // Add tools if provided (function calling support)
      // Skip for fine-tuned models that have internalized tool schemas (saves context window)
      const skipToolSchemas = LMStudioAdapter.usesToolCallsContentFormat(model);
      if (options?.tools && options.tools.length > 0 && !skipToolSchemas) {
        requestBody.tools = this.convertTools(options.tools);
      }

      // Add JSON mode if requested
      if (options?.jsonMode) {
        requestBody.response_format = { type: 'json_object' };
      }

      // Remove undefined values
      Object.keys(requestBody).forEach(key => {
        if (requestBody[key] === undefined) {
          delete requestBody[key];
        }
      });

      const response = await fetch(`${this.serverUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody)
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new LLMProviderError(
          `LM Studio API error: ${response.status} ${response.statusText} - ${errorText}`,
          'streaming',
          'API_ERROR'
        );
      }

      // Use existing SSE stream processor with post-processing for [TOOL_CALLS] format
      // The [TOOL_CALLS] content format embeds tool calls in message content rather
      // than using the standard tool_calls array - we detect and parse at completion
      let accumulatedContent = '';
      let pendingChunks: StreamChunk[] = [];
      let hasToolCallsFormat = false;

      // Process SSE stream using existing infrastructure
      for await (const chunk of this.processSSEStream(response, {
        debugLabel: 'LM Studio',
        extractContent: (parsed) => parsed.choices?.[0]?.delta?.content || null,
        extractToolCalls: (parsed) => parsed.choices?.[0]?.delta?.tool_calls || null,
        extractFinishReason: (parsed) => parsed.choices?.[0]?.finish_reason || null,
        extractUsage: (parsed) => parsed.usage,
        accumulateToolCalls: true,
        toolCallThrottling: {
          initialYield: true,
          progressInterval: 50
        }
      })) {
        // Accumulate content for [TOOL_CALLS] detection
        if (chunk.content) {
          accumulatedContent += chunk.content;
        }

        // Check for [TOOL_CALLS] format early in stream
        if (!hasToolCallsFormat && ToolCallContentParser.hasToolCallsFormat(accumulatedContent)) {
          hasToolCallsFormat = true;
        }

        // If [TOOL_CALLS] detected, buffer chunks and transform at end
        // This prevents showing raw JSON to the user
        if (hasToolCallsFormat) {
          if (!chunk.complete) {
            // Buffer chunks silently - UI has its own thinking indicator
            pendingChunks.push(chunk);
          } else {
            // Stream complete - parse [TOOL_CALLS] and yield transformed result
            const parsed = ToolCallContentParser.parse(accumulatedContent);

            if (parsed.hasToolCalls) {
              yield {
                content: parsed.cleanContent,
                complete: true,
                toolCalls: parsed.toolCalls,
                toolCallsReady: true,
                usage: chunk.usage
              };
            } else {
              // Parsing failed - yield original chunk
              console.warn('[LMStudioAdapter] [TOOL_CALLS] parsing failed, yielding raw content');
              yield chunk;
            }
          }
        } else {
          // Standard response - yield as-is (existing tool call handling applies)
          yield chunk;
        }
      }

    } catch (error) {
      console.error('[LMStudioAdapter] Streaming error:', error);

      // Check if it's a CORS error - fall back to non-streaming
      if (error instanceof TypeError && error.message.includes('Failed to fetch')) {
        console.warn('[LMStudioAdapter] CORS blocked - falling back to non-streaming mode');
        console.warn('[LMStudioAdapter] To enable streaming, configure LM Studio to allow CORS from app://obsidian.md');

        // Fall back to non-streaming (which also handles [TOOL_CALLS])
        const result = await this.generateUncached(prompt, options);
        yield {
          content: result.text || '',
          complete: true,
          toolCalls: result.toolCalls,
          toolCallsReady: result.toolCalls && result.toolCalls.length > 0,
          usage: result.usage,
          metadata: result.metadata
        };
        return;
      }

      if (error instanceof LLMProviderError) {
        throw error;
      }
      throw new LLMProviderError(
        `LM Studio streaming failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'streaming',
        'NETWORK_ERROR'
      );
    }
  }

  /**
   * List available models by querying LM Studio's /v1/models endpoint
   * Discovers loaded models dynamically
   */
  async listModels(): Promise<ModelInfo[]> {
    try {
      // Use Obsidian's requestUrl to bypass CORS
      const response = await requestUrl({
        url: `${this.serverUrl}/v1/models`,
        method: 'GET'
      });

      if (response.status !== 200) {
        // Server returned error - silently return empty (server may not be ready)
        return [];
      }

      const data = response.json;

      if (!data.data || !Array.isArray(data.data)) {
        // Unexpected response format - silently return empty
        return [];
      }

      return data.data.map((model: any) => {
        const modelId = model.id;
        const isVisionModel = this.detectVisionSupport(modelId);
        const supportsTools = this.detectToolSupport(modelId);

        return {
          id: modelId,
          name: modelId,
          contextWindow: model.context_length || 4096,
          maxOutputTokens: model.max_tokens || 2048,
          supportsJSON: true, // Most models support JSON mode
          supportsImages: isVisionModel,
          supportsFunctions: supportsTools,
          supportsStreaming: true,
          supportsThinking: false,
          pricing: {
            inputPerMillion: 0, // Local models are free
            outputPerMillion: 0,
            currency: 'USD',
            lastUpdated: new Date().toISOString()
          }
        };
      });
    } catch {
      // Server not reachable - silently return empty (app probably not running)
      return [];
    }
  }

  getCapabilities(): ProviderCapabilities {
    return {
      supportsStreaming: true,
      supportsJSON: true, // Most models support JSON mode
      supportsImages: false, // Depends on specific model
      supportsFunctions: true, // Many models support function calling via OpenAI-compatible API
      supportsThinking: false,
      maxContextWindow: 128000, // Varies by model, reasonable default
      supportedFeatures: ['streaming', 'function_calling', 'json_mode', 'local', 'privacy']
    };
  }

  async getModelPricing(modelId: string): Promise<ModelPricing | null> {
    // Local models are free - zero rates
    const pricing: ModelPricing = {
      rateInputPerMillion: 0,
      rateOutputPerMillion: 0,
      currency: 'USD'
    };

    return pricing;
  }

  async isAvailable(): Promise<boolean> {
    try {
      const response = await requestUrl({
        url: `${this.serverUrl}/v1/models`,
        method: 'GET'
      });
      return response.status === 200;
    } catch (error) {
      return false;
    }
  }

  /**
   * Convert tools from Chat Completions format to ensure compatibility
   * Handles both flat and nested tool formats
   */
  private convertTools(tools: any[]): any[] {
    return tools.map((tool: any) => {
      // If already in flat format {type, name, description, parameters}, return as-is
      if (tool.name && !tool.function) {
        return tool;
      }

      // If in nested format {type, function: {name, description, parameters}}, flatten it
      if (tool.function) {
        return {
          type: 'function',
          function: {
            name: tool.function.name,
            description: tool.function.description,
            parameters: tool.function.parameters
          }
        };
      }

      return tool;
    });
  }

  /**
   * Detect if a model supports vision based on name patterns
   */
  private detectVisionSupport(modelId: string): boolean {
    const visionKeywords = ['vision', 'llava', 'bakllava', 'cogvlm', 'yi-vl', 'moondream'];
    const lowerModelId = modelId.toLowerCase();
    return visionKeywords.some(keyword => lowerModelId.includes(keyword));
  }

  /**
   * Detect if a model supports tool/function calling based on name patterns
   * Many newer models support function calling
   *
   * Note: Models with "nexus" or "tools" in the name likely use [TOOL_CALLS] format
   * which is automatically parsed by this adapter
   */
  private detectToolSupport(modelId: string): boolean {
    const toolSupportedKeywords = [
      'gpt', 'mistral', 'mixtral', 'hermes', 'nous', 'qwen',
      'deepseek', 'dolphin', 'functionary', 'gorilla',
      // Fine-tuned models that use [TOOL_CALLS] format
      'nexus', 'tools-sft', 'tool-calling'
    ];
    const lowerModelId = modelId.toLowerCase();
    return toolSupportedKeywords.some(keyword => lowerModelId.includes(keyword));
  }

  /**
   * Check if a model uses the [TOOL_CALLS] content format
   * These are typically fine-tuned models that have internalized tool schemas
   */
  static usesToolCallsContentFormat(modelId: string): boolean {
    // Include legacy identifiers for backward compatibility with older fine-tunes
    const contentFormatKeywords = ['nexus', 'tools-sft', 'claudesidian'];
    const lowerModelId = modelId.toLowerCase();
    return contentFormatKeywords.some(keyword => lowerModelId.includes(keyword));
  }

  /**
   * Map OpenAI finish reasons to our standard types
   */
  private mapFinishReason(reason: string | undefined): 'stop' | 'length' | 'tool_calls' | 'content_filter' {
    if (!reason) return 'stop';

    switch (reason) {
      case 'stop':
        return 'stop';
      case 'length':
      case 'max_tokens':
        return 'length';
      case 'tool_calls':
      case 'function_call':
        return 'tool_calls';
      case 'content_filter':
        return 'content_filter';
      default:
        return 'stop';
    }
  }

  protected buildMessages(prompt: string, systemPrompt?: string): any[] {
    const messages = [];

    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
    }

    messages.push({ role: 'user', content: prompt });

    return messages;
  }

  protected handleError(error: any, operation: string): never {
    if (error instanceof LLMProviderError) {
      throw error;
    }

    let message = `LM Studio ${operation} failed`;
    let code = 'UNKNOWN_ERROR';

    if (error?.message) {
      message += `: ${error.message}`;
    }

    if (error?.code === 'ECONNREFUSED') {
      message = 'Cannot connect to LM Studio server. Make sure LM Studio is running and the server is started.';
      code = 'CONNECTION_REFUSED';
    } else if (error?.code === 'ENOTFOUND') {
      message = 'LM Studio server not found. Check the URL configuration.';
      code = 'SERVER_NOT_FOUND';
    }

    throw new LLMProviderError(message, this.name, code, error);
  }
}
