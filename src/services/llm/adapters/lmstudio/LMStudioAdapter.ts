/**
 * LM Studio Adapter
 * Provides local LLM models via LM Studio's OpenAI-compatible API
 * Supports model auto-discovery, streaming, and function calling
 *
 * Uses the standard /v1/chat/completions API for reliable conversation handling.
 * Supports multiple tool calling formats (native tool_calls, [TOOL_CALLS], XML, etc.)
 * via ToolCallContentParser.
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
import { usesCustomToolFormat } from '../../../chat/builders/ContextBuilderFactory';

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
   * Generate response without caching using /v1/chat/completions
   * Uses Obsidian's requestUrl to bypass CORS
   */
  async generateUncached(prompt: string, options?: GenerateOptions): Promise<LLMResponse> {
    const model = options?.model || this.currentModel;

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

    const skipToolSchemas = LMStudioAdapter.usesToolCallsContentFormat(model);
    if (options?.tools && options.tools.length > 0 && !skipToolSchemas) {
      requestBody.tools = this.convertTools(options.tools);
    }

    if (options?.jsonMode) {
      requestBody.response_format = { type: 'json_object' };
    }

    Object.keys(requestBody).forEach(key => {
      if (requestBody[key] === undefined) {
        delete requestBody[key];
      }
    });

    const response = await requestUrl({
      url: `${this.serverUrl}/v1/chat/completions`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody)
    });

    if (response.status !== 200) {
      throw new LLMProviderError(
        `LM Studio API error: ${response.status} - ${response.text || 'Unknown error'}`,
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

    if (ToolCallContentParser.hasToolCallsFormat(content)) {
      const parsed = ToolCallContentParser.parse(content);
      if (parsed.hasToolCalls) {
        if (toolCalls.length === 0) {
          toolCalls = parsed.toolCalls;
        }
        content = parsed.cleanContent;
      }
    }

    const usage: TokenUsage = {
      promptTokens: data.usage?.prompt_tokens || 0,
      completionTokens: data.usage?.completion_tokens || 0,
      totalTokens: data.usage?.total_tokens || 0
    };

    return await this.buildLLMResponse(
      content,
      model,
      usage,
      { cached: false, model: data.model, id: data.id },
      toolCalls.length > 0 ? 'tool_calls' : this.mapFinishReason(choice.finish_reason),
      toolCalls
    );
  }

  /**
   * Generate streaming response using /v1/chat/completions
   * Supports multiple tool calling formats via ToolCallContentParser
   */
  async* generateStreamAsync(prompt: string, options?: GenerateOptions): AsyncGenerator<StreamChunk, void, unknown> {
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

    // Add tools if provided
    const skipToolSchemas = LMStudioAdapter.usesToolCallsContentFormat(model);
    if (options?.tools && options.tools.length > 0 && !skipToolSchemas) {
      requestBody.tools = this.convertTools(options.tools);
    }

    // Remove undefined values
    Object.keys(requestBody).forEach(key => {
      if (requestBody[key] === undefined) {
        delete requestBody[key];
      }
    });

    // Note: Using fetch() instead of requestUrl() because Obsidian's requestUrl()
    // does not support streaming responses (ReadableStream) needed for LLM streaming.
    const response = await fetch(`${this.serverUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new LLMProviderError(
        `LM Studio API error: ${response.status} - ${errorText}`,
        'streaming',
        'API_ERROR'
      );
    }

    let accumulatedContent = '';
    let hasToolCallsFormat = false;

    for await (const chunk of this.processSSEStream(response, {
      debugLabel: 'LM Studio (legacy)',
      extractContent: (parsed) => parsed.choices?.[0]?.delta?.content || null,
      extractToolCalls: (parsed) => parsed.choices?.[0]?.delta?.tool_calls || null,
      extractFinishReason: (parsed) => parsed.choices?.[0]?.finish_reason || null,
      extractUsage: (parsed) => parsed.usage,
      accumulateToolCalls: true
    })) {
      if (chunk.content) {
        accumulatedContent += chunk.content;
      }

      if (!hasToolCallsFormat && ToolCallContentParser.hasToolCallsFormat(accumulatedContent)) {
        hasToolCallsFormat = true;
      }

      if (hasToolCallsFormat) {
        if (chunk.complete) {
          const parsed = ToolCallContentParser.parse(accumulatedContent);
          yield {
            content: parsed.cleanContent,
            complete: true,
            toolCalls: parsed.hasToolCalls ? parsed.toolCalls : undefined,
            toolCallsReady: parsed.hasToolCalls,
            usage: chunk.usage
          };
        }
      } else {
        yield chunk;
      }
    }
  }

  /**
   * Convert tools to Responses API format
   */
  private convertToolsForResponsesApi(tools: any[]): any[] {
    return tools.map((tool) => {
      if (tool.function) {
        return {
          type: 'function',
          name: tool.function.name,
          description: tool.function.description,
          parameters: tool.function.parameters
        };
      }
      return tool;
    });
  }

  /**
   * Convert Chat Completions format messages to Responses API input
   *
   * Chat Completions format:
   * - { role: 'user', content: '...' }
   * - { role: 'assistant', content: '...', tool_calls: [...] }
   * - { role: 'tool', tool_call_id: '...', content: '...' }
   *
   * Responses API input:
   * - { role: 'user', content: '...' }
   * - { role: 'assistant', content: '...' } OR function_call items
   * - { type: 'function_call_output', call_id: '...', output: '...' }
   */
  private convertChatCompletionsToResponsesInput(messages: any[], systemPrompt?: string): any[] {
    const input: any[] = [];

    // Add system prompt first if provided
    if (systemPrompt) {
      input.push({ role: 'system', content: systemPrompt });
    }

    for (const msg of messages) {
      if (msg.role === 'user') {
        input.push({ role: 'user', content: msg.content || '' });
      } else if (msg.role === 'assistant') {
        if (msg.tool_calls && msg.tool_calls.length > 0) {
          // Add text content if present
          if (msg.content && msg.content.trim()) {
            input.push({ role: 'assistant', content: msg.content });
          }
          // Convert tool_calls to function_call items
          for (const tc of msg.tool_calls) {
            input.push({
              type: 'function_call',
              call_id: tc.id,
              name: tc.function?.name || '',
              arguments: tc.function?.arguments || '{}'
            });
          }
        } else {
          // Plain assistant message
          input.push({ role: 'assistant', content: msg.content || '' });
        }
      } else if (msg.role === 'tool') {
        // Convert tool result to function_call_output
        input.push({
          type: 'function_call_output',
          call_id: msg.tool_call_id,
          output: msg.content || '{}'
        });
      } else if (msg.role === 'system') {
        // System messages (shouldn't be here but handle gracefully)
        input.push({ role: 'system', content: msg.content || '' });
      }
    }

    return input;
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

      return data.data.map((model: { id: string; context_length?: number; max_tokens?: number }) => {
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
    return tools.map((tool) => {
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
   * Check if a model uses custom tool call format (<tool_call> or [TOOL_CALLS])
   * These are fine-tuned models that have internalized tool schemas and don't need
   * tool schemas passed via the API - they output tool calls as content.
   *
   * Delegates to centralized check in ContextBuilderFactory for consistency.
   */
  static usesToolCallsContentFormat(modelId: string): boolean {
    return usesCustomToolFormat(modelId);
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
