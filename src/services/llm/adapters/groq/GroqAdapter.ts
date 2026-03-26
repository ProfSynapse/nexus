/**
 * Groq Adapter with true streaming support and Ultra-Fast Inference
 * Leverages Groq's high-performance LLM serving infrastructure
 * Uses Groq's OpenAI-compatible REST API with buffered SSE replay.
 */

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

interface GroqChatMessage {
  role: 'system' | 'user';
  content: string;
}

interface GroqToolCallDelta {
  id?: string;
  type?: 'function';
  function?: {
    name?: string;
    arguments?: string;
  };
  reasoning_details?: unknown[];
  thought_signature?: string;
}

interface GroqChoice {
  delta?: {
    content?: string | null;
    tool_calls?: GroqToolCallDelta[];
  };
  message?: {
    content?: string | null;
    tool_calls?: GroqToolCallDelta[];
  };
  finish_reason?: string | null;
}

/**
 * Extended Groq chunk type with x_groq metadata
 * x_groq contains timing information (queue_time, prompt_time, completion_time)
 */
interface GroqChatCompletionChunk {
  choices?: GroqChoice[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    queue_time?: number;
    prompt_time?: number;
    completion_time?: number;
  };
  x_groq?: {
    id?: string;
    error?: string;
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      total_tokens?: number;
    };
  };
}

type GroqUsageMetrics = NonNullable<GroqChatCompletionChunk['usage']>;
type GroqExtendedTokenUsage = TokenUsage & {
  queueTime?: number;
  promptTime?: number;
  completionTime?: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function isGroqChoice(value: unknown): value is GroqChoice {
  return isRecord(value);
}

function getFirstChoice(value: unknown): GroqChoice | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const choices = value['choices'];
  if (!isUnknownArray(choices) || choices.length === 0) {
    return undefined;
  }

  const [firstChoice] = choices;
  return isGroqChoice(firstChoice) ? firstChoice : undefined;
}

function getErrorToThrow(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export class GroqAdapter extends BaseAdapter {
  readonly name = 'groq';
  readonly baseUrl = 'https://api.groq.com/openai/v1';

  constructor(apiKey: string, model?: string) {
    super(apiKey, model || GROQ_DEFAULT_MODEL);
    this.initializeCache();
  }

  async generateUncached(prompt: string, options?: GenerateOptions): Promise<LLMResponse> {
    try {
      // Tool execution requires streaming - use generateStreamAsync instead
      if (options?.tools && options.tools.length > 0) {
        throw new Error('Tool execution requires streaming. Use generateStreamAsync() instead.');
      }

      // Use basic chat completions
      return await this.generateWithChatCompletions(prompt, options);
    } catch (error) {
      this.handleError(error, 'generation');
    }
  }

  /**
   * Generate streaming response using async generator
   * Uses unified stream processing with automatic tool call accumulation
   */
  async* generateStreamAsync(prompt: string, options?: GenerateOptions): AsyncGenerator<StreamChunk, void, unknown> {
    try {
      const nodeStream = await this.requestStream({
        url: `${this.baseUrl}/chat/completions`,
        operation: 'streaming generation',
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: options?.model || this.currentModel,
          messages: this.buildGroqMessages(prompt, options?.systemPrompt),
          temperature: options?.temperature,
          max_completion_tokens: options?.maxTokens,
          top_p: options?.topP,
          stop: options?.stopSequences,
          tools: options?.tools ? this.convertTools(options.tools) : undefined,
          response_format: options?.jsonMode ? { type: 'json_object' } : undefined,
          stream: true
        }),
        timeoutMs: 120_000
      });

      yield* this.processNodeStream(nodeStream, {
        debugLabel: 'Groq',
        extractContent: (chunk) => getFirstChoice(chunk)?.delta?.content ?? null,
        extractToolCalls: (chunk) => getFirstChoice(chunk)?.delta?.tool_calls ?? null,
        extractFinishReason: (chunk) => getFirstChoice(chunk)?.finish_reason ?? null,
        extractUsage: (chunk) => this.extractStreamUsage(chunk),
        accumulateToolCalls: true,
        toolCallThrottling: {
          initialYield: true,
          progressInterval: 50
        }
      });
    } catch (error) {
      console.error('[GroqAdapter] Streaming error:', error);
      throw getErrorToThrow(error);
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
      streamingMode: 'streaming' as const,
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
      messages: GroqChatMessage[];
      temperature?: number;
      max_completion_tokens?: number;
      top_p?: number;
      stop?: string[];
      response_format?: { type: 'json_object' };
      tools?: Array<{ type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }>;
    }

    const chatParams: ChatCompletionParams = {
      model,
      messages: this.buildGroqMessages(prompt, options?.systemPrompt),
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

    const response = await this.request<GroqChatCompletionChunk>({
      url: `${this.baseUrl}/chat/completions`,
      operation: 'generation',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(chatParams),
      timeoutMs: 60_000
    });
    this.assertOk(response, `Groq generation failed: HTTP ${response.status}`);
    const responseJson = response.json;
    const choice = getFirstChoice(responseJson);
    
    if (!choice) {
      throw new Error('No response from Groq');
    }
    
    let text = choice.message?.content ?? '';
    const usage = this.extractUsage(responseJson);
    const finishReason = this.mapFinishReason(choice.finish_reason ?? null);
    const toolCalls = this.extractToolCalls(choice.message);

    // If tools were provided and we got tool calls, we need to handle them
    // For now, just return the response as-is since tool execution is complex
    if (options?.tools && toolCalls.length > 0) {
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
  private buildGroqMessages(prompt: string, systemPrompt?: string): GroqChatMessage[] {
    return this.buildMessages(prompt, systemPrompt).map(message => ({
      role: message.role,
      content: message.content
    }));
  }

  private convertTools(tools: Tool[]): Array<{ type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }> {
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

  private extractToolCalls(message: unknown): GroqToolCallDelta[] {
    if (!isRecord(message) || !Array.isArray(message.tool_calls)) {
      return [];
    }

    return message.tool_calls.filter((toolCall): toolCall is GroqToolCallDelta => isRecord(toolCall));
  }

  private extractStreamUsage(chunk: unknown): GroqUsageMetrics | NonNullable<NonNullable<GroqChatCompletionChunk['x_groq']>['usage']> | null {
    if (!isRecord(chunk)) {
      return null;
    }

    const groqChunk = chunk as GroqChatCompletionChunk;
    return groqChunk.usage ?? groqChunk.x_groq?.usage ?? null;
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

  protected extractUsage(response: unknown): TokenUsage | undefined {
    if (!isRecord(response)) {
      return undefined;
    }

    const usage = (response as GroqChatCompletionChunk).usage;
    if (usage) {
      const extractedUsage: GroqExtendedTokenUsage = {
        promptTokens: usage.prompt_tokens || 0,
        completionTokens: usage.completion_tokens || 0,
        totalTokens: usage.total_tokens || 0,
        // Groq-specific extended metrics (queue_time, prompt_time, completion_time)
        // These are available directly on CompletionUsage from Groq SDK
        ...(usage.queue_time !== undefined && { queueTime: usage.queue_time }),
        ...(usage.prompt_time !== undefined && { promptTime: usage.prompt_time }),
        ...(usage.completion_time !== undefined && { completionTime: usage.completion_time })
      };

      return extractedUsage;
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
