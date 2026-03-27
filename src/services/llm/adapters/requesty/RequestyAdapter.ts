/**
 * Requesty AI Adapter with true streaming support
 * OpenAI-compatible streaming interface for 150+ models via router
 * Based on Requesty streaming documentation
 */

import { BaseAdapter } from '../BaseAdapter';
import {
  GenerateOptions,
  StreamChunk,
  LLMResponse,
  TokenUsage,
  ModelInfo,
  ProviderCapabilities,
  ModelPricing
} from '../types';
import { REQUESTY_MODELS, REQUESTY_DEFAULT_MODEL } from './RequestyModels';

/**
 * Requesty API response structure (OpenAI-compatible)
 */
interface RequestyToolFunction {
  name?: string;
  arguments?: string;
}

interface RequestyToolCallDelta {
  index?: number;
  id?: string;
  type?: string;
  function?: RequestyToolFunction;
}

interface RequestyMessagePayload {
  content?: string;
  tool_calls?: RequestyToolCallDelta[];
}

interface RequestyChoice {
  message?: RequestyMessagePayload;
  delta?: RequestyMessagePayload;
  finish_reason?: string;
}

interface RequestyUsagePayload {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

interface RequestyChatCompletionResponse {
  choices: RequestyChoice[];
  usage?: RequestyUsagePayload;
}

interface RequestyChatCompletionRequest {
  model: string;
  messages: ReturnType<BaseAdapter['buildMessages']>;
  temperature?: number;
  max_tokens?: number;
  response_format?: { type: 'json_object' };
  stop?: string[];
  tools?: GenerateOptions['tools'];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toOptionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function getRequestyToolCalls(source: RequestyMessagePayload | undefined): RequestyToolCallDelta[] {
  return source?.tool_calls ?? [];
}

function extractRequestyToolCalls(value: unknown): RequestyToolCallDelta[] | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const rawToolCalls = value.tool_calls ?? value.toolCalls;
  if (!Array.isArray(rawToolCalls)) {
    return undefined;
  }

  const toolCalls: RequestyToolCallDelta[] = [];
  for (const rawToolCall of rawToolCalls) {
    if (!isRecord(rawToolCall)) {
      continue;
    }

    const functionPayload = isRecord(rawToolCall.function)
      ? {
          name: typeof rawToolCall.function.name === 'string' ? rawToolCall.function.name : undefined,
          arguments: typeof rawToolCall.function.arguments === 'string' ? rawToolCall.function.arguments : undefined
        }
      : undefined;

    toolCalls.push({
      index: toOptionalNumber(rawToolCall.index),
      id: typeof rawToolCall.id === 'string' ? rawToolCall.id : undefined,
      type: typeof rawToolCall.type === 'string' ? rawToolCall.type : undefined,
      function: functionPayload
    });
  }

  return toolCalls;
}

function extractRequestyMessage(value: unknown): RequestyMessagePayload | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const content = typeof value.content === 'string' ? value.content : undefined;
  const toolCalls = extractRequestyToolCalls(value);

  if (content === undefined && toolCalls === undefined) {
    return undefined;
  }

  return {
    content,
    tool_calls: toolCalls
  };
}

function extractRequestyChoices(value: unknown): RequestyChoice[] {
  if (!isRecord(value) || !Array.isArray(value.choices)) {
    return [];
  }

  const choices: RequestyChoice[] = [];
  for (const rawChoice of value.choices) {
    if (!isRecord(rawChoice)) {
      continue;
    }

    choices.push({
      message: extractRequestyMessage(rawChoice.message),
      delta: extractRequestyMessage(rawChoice.delta),
      finish_reason: typeof rawChoice.finish_reason === 'string' ? rawChoice.finish_reason : undefined
    });
  }

  return choices;
}

function extractRequestyUsagePayload(value: unknown): RequestyUsagePayload | undefined {
  if (!isRecord(value) || !isRecord(value.usage)) {
    return undefined;
  }

  const usage = value.usage;
  return {
    prompt_tokens: toOptionalNumber(usage.prompt_tokens),
    completion_tokens: toOptionalNumber(usage.completion_tokens),
    total_tokens: toOptionalNumber(usage.total_tokens)
  };
}

function parseRequestyChatCompletionResponse(value: unknown): RequestyChatCompletionResponse {
  return {
    choices: extractRequestyChoices(value),
    usage: extractRequestyUsagePayload(value)
  };
}

export class RequestyAdapter extends BaseAdapter {
  readonly name = 'requesty';
  readonly baseUrl = 'https://router.requesty.ai/v1';

  constructor(apiKey: string, model?: string) {
    super(apiKey, model || REQUESTY_DEFAULT_MODEL);
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
          ...this.buildHeaders(),
          'Authorization': `Bearer ${this.apiKey}`,
          'HTTP-Referer': 'https://synaptic-lab-kit.com',
          'X-Title': 'Synaptic Lab Kit',
          'User-Agent': 'Synaptic-Lab-Kit/1.0.0'
        },
        body: JSON.stringify({
          model: options?.model || this.currentModel,
          messages: this.buildMessages(prompt, options?.systemPrompt),
          temperature: options?.temperature,
          max_tokens: options?.maxTokens,
          response_format: options?.jsonMode ? { type: 'json_object' } : undefined,
          stop: options?.stopSequences,
          tools: options?.tools,
          stream: true
        }),
        timeoutMs: 120_000
      });

      yield* this.processNodeStream(nodeStream, {
        debugLabel: 'Requesty',
        extractContent: (parsed) => extractRequestyChoices(parsed)[0]?.delta?.content ?? null,
        extractToolCalls: (parsed) => {
          const toolCalls = getRequestyToolCalls(extractRequestyChoices(parsed)[0]?.delta);
          return toolCalls.length > 0 ? toolCalls : null;
        },
        extractFinishReason: (parsed) => extractRequestyChoices(parsed)[0]?.finish_reason ?? null,
        extractUsage: (parsed) => extractRequestyUsagePayload(parsed) ?? null,
        accumulateToolCalls: true,
        toolCallThrottling: {
          initialYield: true,
          progressInterval: 50
        }
      });
    } catch (error) {
      console.error('[RequestyAdapter] Streaming error:', error);
        throw error instanceof Error ? error : new Error(String(error));
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    try {
      return REQUESTY_MODELS.map(model => ({
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
      maxContextWindow: 200000,
      supportedFeatures: [
        'messages',
        'function_calling',
        'vision',
        'streaming',
        'json_mode',
        'router_fallback'
      ]
    };

    return baseCapabilities;
  }

  /**
   * Generate using standard chat completions
   */
  private async generateWithChatCompletions(prompt: string, options?: GenerateOptions): Promise<LLMResponse> {
    const model = options?.model || this.currentModel;

    const requestBody: RequestyChatCompletionRequest = {
      model,
      messages: this.buildMessages(prompt, options?.systemPrompt),
      temperature: options?.temperature,
      max_tokens: options?.maxTokens,
      response_format: options?.jsonMode ? { type: 'json_object' } : undefined,
      stop: options?.stopSequences,
      ...(options?.tools ? { tools: options.tools } : {})
    };

    const response = await this.request<RequestyChatCompletionResponse>({
      url: `${this.baseUrl}/chat/completions`,
      operation: 'generation',
      method: 'POST',
      headers: {
        ...this.buildHeaders(),
        'Authorization': `Bearer ${this.apiKey}`,
        'HTTP-Referer': 'https://synaptic-lab-kit.com',
        'X-Title': 'Synaptic Lab Kit',
        'User-Agent': 'Synaptic-Lab-Kit/1.0.0'
      },
      body: JSON.stringify(requestBody),
      timeoutMs: 60_000
    });

    this.assertOk(response, `Requesty generation failed: HTTP ${response.status}`);

    const data = parseRequestyChatCompletionResponse(response.json);
    const choice = data.choices[0];

    if (!choice) {
      throw new Error('No response from Requesty');
    }

    let text = choice.message?.content ?? '';
    const usage = this.extractUsage(data);
    const finishReason = this.mapFinishReason(choice.finish_reason ?? null);

    // If tools were provided and we got tool calls, return placeholder text
    if (options?.tools && getRequestyToolCalls(choice.message).length > 0) {
      text = text || '[AI requested tool calls but tool execution not available]';
    }

    return this.buildLLMResponse(
      text,
      model,
      usage,
      { provider: 'requesty' },
      finishReason
    );
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
    const usage = extractRequestyUsagePayload(response);
    if (usage) {
      return {
        promptTokens: usage.prompt_tokens ?? 0,
        completionTokens: usage.completion_tokens ?? 0,
        totalTokens: usage.total_tokens ?? 0
      };
    }

    return undefined;
  }

  private getCostPer1kTokens(modelId: string): { input: number; output: number } | undefined {
    const model = REQUESTY_MODELS.find(m => m.apiName === modelId);
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
