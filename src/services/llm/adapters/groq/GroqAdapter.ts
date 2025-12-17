/**
 * Groq Adapter with true streaming support and Ultra-Fast Inference
 * Leverages Groq's high-performance LLM serving infrastructure
 * Uses OpenAI-compatible streaming API with extended usage metrics
 * Based on official Groq SDK streaming documentation
 */

import Groq from 'groq-sdk';
import type { ChatCompletion, ChatCompletionChunk, ChatCompletionMessageToolCall, ChatCompletionMessageParam } from 'groq-sdk/resources/chat/completions';
import type { CompletionUsage } from 'groq-sdk/resources/completions';
import { BaseAdapter } from '../BaseAdapter';
import {
  GenerateOptions,
  StreamChunk,
  LLMResponse,
  ModelInfo,
  ProviderCapabilities,
  ModelPricing,
  Tool,
  TokenUsage
} from '../types';
import { GROQ_MODELS, GROQ_DEFAULT_MODEL } from './GroqModels';
import { MCPToolExecution } from '../shared/ToolExecutionUtils';

/**
 * Extended Groq chunk type with x_groq metadata
 * x_groq contains timing information (queue_time, prompt_time, completion_time)
 */
interface GroqChatCompletionChunk extends ChatCompletionChunk {
  usage?: CompletionUsage;
  x_groq?: {
    id?: string;
    error?: string;
    usage?: CompletionUsage;
  };
}

export class GroqAdapter extends BaseAdapter {
  readonly name = 'groq';
  readonly baseUrl = 'https://api.groq.com/openai/v1';

  private client: Groq;

  constructor(apiKey: string, model?: string) {
    super(apiKey, model || GROQ_DEFAULT_MODEL);

    this.client = new Groq({
      apiKey: this.apiKey,
      dangerouslyAllowBrowser: true
    });
    this.initializeCache();
  }

  async generateUncached(prompt: string, options?: GenerateOptions): Promise<LLMResponse> {
    try {
      const model = options?.model || this.currentModel;
      
      // Tool execution requires streaming - use generateStreamAsync instead
      if (options?.tools && options.tools.length > 0) {
        throw new Error('Tool execution requires streaming. Use generateStreamAsync() instead.');
      }

      // Use basic chat completions
      return await this.generateWithChatCompletions(prompt, options);
    } catch (error) {
      throw this.handleError(error, 'generation');
    }
  }

  /**
   * Generate streaming response using async generator
   * Uses unified stream processing with automatic tool call accumulation
   */
  async* generateStreamAsync(prompt: string, options?: GenerateOptions): AsyncGenerator<StreamChunk, void, unknown> {
    try {
      const stream = await this.client.chat.completions.create({
        model: options?.model || this.currentModel,
        messages: this.buildMessages(prompt, options?.systemPrompt),
        temperature: options?.temperature,
        max_completion_tokens: options?.maxTokens,
        top_p: options?.topP,
        stop: options?.stopSequences,
        tools: options?.tools ? this.convertTools(options.tools) : undefined,
        response_format: options?.jsonMode ? { type: 'json_object' } : undefined,
        stream: true
      });

      // Use unified stream processing with automatic tool call accumulation
      yield* this.processStream(stream, {
        debugLabel: 'Groq',
        extractContent: (chunk) => chunk.choices[0]?.delta?.content || null,
        extractToolCalls: (chunk) => chunk.choices[0]?.delta?.tool_calls || null,
        extractFinishReason: (chunk) => chunk.choices[0]?.finish_reason || null,
        extractUsage: (chunk) => {
          // Groq has both standard usage and x_groq metadata
          const groqChunk = chunk as GroqChatCompletionChunk;
          if (groqChunk.usage || groqChunk.x_groq) {
            return {
              usage: groqChunk.usage,
              x_groq: groqChunk.x_groq
            };
          }
          return null;
        }
      });
    } catch (error) {
      console.error('[GroqAdapter] Streaming error:', error);
      throw error;
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    try {
      return GROQ_MODELS.map(model => ({
        id: model.apiName,
        name: model.name,
        contextWindow: model.contextWindow,
        maxOutputTokens: model.maxTokens,
        supportsJSON: model.capabilities.supportsJSON,
        supportsImages: model.capabilities.supportsImages,
        supportsFunctions: model.capabilities.supportsFunctions,
        supportsStreaming: model.capabilities.supportsStreaming,
        supportsThinking: false,
        costPer1kTokens: {
          input: model.inputCostPerMillion / 1000,
          output: model.outputCostPerMillion / 1000
        },
        pricing: {
          inputPerMillion: model.inputCostPerMillion,
          outputPerMillion: model.outputCostPerMillion,
          currency: 'USD',
          lastUpdated: new Date().toISOString()
        }
      }));
    } catch (error) {
      this.handleError(error, 'listing models');
      return [];
    }
  }

  getCapabilities(): ProviderCapabilities {
    const baseCapabilities = {
      supportsStreaming: true,
      supportsJSON: true,
      supportsImages: true,
      supportsFunctions: true,
      supportsThinking: false,
      maxContextWindow: 128000,
      supportedFeatures: [
        'messages',
        'function_calling',
        'vision',
        'streaming',
        'json_mode',
        'ultra_fast_inference',
        'extended_metrics'
      ]
    };

    return baseCapabilities;
  }

  /**
   * Generate using standard chat completions
   */
  private async generateWithChatCompletions(prompt: string, options?: GenerateOptions): Promise<LLMResponse> {
    const model = options?.model || this.currentModel;

    interface ChatCompletionParams {
      model: string;
      messages: ChatCompletionMessageParam[];
      temperature?: number;
      max_completion_tokens?: number;
      top_p?: number;
      stop?: string[];
      response_format?: { type: 'json_object' };
      tools?: Array<{ type: 'function'; function: { name: string; description: string; parameters: Record<string, any> } }>;
    }

    const chatParams: ChatCompletionParams = {
      model,
      // Safe cast: buildMessages creates objects compatible with ChatCompletionMessageParam
      messages: this.buildMessages(prompt, options?.systemPrompt) as ChatCompletionMessageParam[],
      temperature: options?.temperature,
      max_completion_tokens: options?.maxTokens,
      top_p: options?.topP,
      stop: options?.stopSequences,
      response_format: options?.jsonMode ? { type: 'json_object' } : undefined
    };

    // Add tools if provided
    if (options?.tools) {
      chatParams.tools = this.convertTools(options.tools);
    }

    const response = await this.client.chat.completions.create(chatParams);
    const choice = response.choices[0];
    
    if (!choice) {
      throw new Error('No response from Groq');
    }
    
    let text = choice.message?.content || '';
    const usage = this.extractUsage(response);
    const finishReason = this.mapFinishReason(choice.finish_reason);

    // If tools were provided and we got tool calls, we need to handle them
    // For now, just return the response as-is since tool execution is complex
    if (options?.tools && choice.message?.tool_calls && choice.message.tool_calls.length > 0) {
      text = text || '[AI requested tool calls but tool execution not available]';
    }

    return this.buildLLMResponse(
      text,
      model,
      usage,
      undefined,
      finishReason
    );
  }

  // Private methods
  private convertTools(tools: Tool[]): Array<{ type: 'function'; function: { name: string; description: string; parameters: Record<string, any> } }> {
    return tools.map(tool => {
      if (tool.type === 'function' && tool.function) {
        return {
          type: 'function' as const,
          function: {
            name: tool.function.name,
            description: tool.function.description,
            parameters: tool.function.parameters
          }
        };
      }
      // Fallback for malformed tools - should not happen with proper Tool type
      throw new Error(`Unsupported tool type: ${tool.type}`);
    });
  }

  private extractToolCalls(message: ChatCompletion['choices'][0]['message']): ChatCompletionMessageToolCall[] {
    return message?.tool_calls || [];
  }

  private mapFinishReason(reason: string | null): 'stop' | 'length' | 'tool_calls' | 'content_filter' {
    if (!reason) return 'stop';
    
    const reasonMap: Record<string, 'stop' | 'length' | 'tool_calls' | 'content_filter'> = {
      'stop': 'stop',
      'length': 'length',
      'tool_calls': 'tool_calls',
      'content_filter': 'content_filter'
    };
    return reasonMap[reason] || 'stop';
  }

  protected extractUsage(response: ChatCompletion | GroqChatCompletionChunk): TokenUsage | undefined {
    const usage = response?.usage;
    if (usage) {
      const groqResponse = response as GroqChatCompletionChunk;
      return {
        promptTokens: usage.prompt_tokens || 0,
        completionTokens: usage.completion_tokens || 0,
        totalTokens: usage.total_tokens || 0,
        // Groq-specific extended metrics (queue_time, prompt_time, completion_time)
        // These are available directly on CompletionUsage from Groq SDK
        ...(usage.queue_time !== undefined && { queueTime: usage.queue_time }),
        ...(usage.prompt_time !== undefined && { promptTime: usage.prompt_time }),
        ...(usage.completion_time !== undefined && { completionTime: usage.completion_time })
      } as TokenUsage & { queueTime?: number; promptTime?: number; completionTime?: number };
    }
    return undefined;
  }

  private getCostPer1kTokens(modelId: string): { input: number; output: number } | undefined {
    const model = GROQ_MODELS.find(m => m.apiName === modelId);
    if (!model) return undefined;
    
    return {
      input: model.inputCostPerMillion / 1000,
      output: model.outputCostPerMillion / 1000
    };
  }

  async getModelPricing(modelId: string): Promise<ModelPricing | null> {
    const costs = this.getCostPer1kTokens(modelId);
    if (!costs) return null;
    
    return {
      rateInputPerMillion: costs.input * 1000,
      rateOutputPerMillion: costs.output * 1000,
      currency: 'USD'
    };
  }
}