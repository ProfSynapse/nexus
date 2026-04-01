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
  ModelInfo,
  ProviderCapabilities,
  ModelPricing
} from '../types';
import { REQUESTY_MODELS, REQUESTY_DEFAULT_MODEL } from './RequestyModels';

/**
 * Requesty API response structure (OpenAI-compatible)
 */
interface RequestyToolCall {
  id?: string;
  type?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
  arguments?: string;
  name?: string;
  displayName?: string;
  technicalName?: string;
  result?: unknown;
  success?: boolean;
  error?: string;
}

interface RequestyMessage {
  content?: string;
  toolCalls?: RequestyToolCall[];
}

interface RequestyChoice {
  message?: RequestyMessage;
  delta?: {
    content?: string;
    tool_calls?: RequestyToolCall[];
  };
  finish_reason?: string;
}

interface RequestyUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

interface RequestyChatCompletionResponse {
  choices: RequestyChoice[];
  usage?: RequestyUsage;
}

type RequestySSEChoice = {
  delta?: {
    content?: string;
    tool_calls?: RequestyToolCall[];
  };
  finish_reason?: string;
};

type RequestySSEParsedEvent = {
  choices?: RequestySSEChoice[];
  usage?: RequestyUsage;
};

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
        extractContent: (parsed) => {
          const event = parsed as RequestySSEParsedEvent;
          return event.choices?.[0]?.delta?.content || null;
        },
        extractToolCalls: (parsed) => {
          const event = parsed as RequestySSEParsedEvent;
          return event.choices?.[0]?.delta?.tool_calls || null;
        },
        extractFinishReason: (parsed) => {
          const event = parsed as RequestySSEParsedEvent;
          return event.choices?.[0]?.finish_reason || null;
        },
        extractUsage: (parsed) => {
          const event = parsed as RequestySSEParsedEvent;
          return event.usage;
        },
        accumulateToolCalls: true,
        toolCallThrottling: {
          initialYield: true,
          progressInterval: 50
        }
      });
    } catch (error) {
      console.error('[RequestyAdapter] Streaming error:', error);
      throw error;
    }
  }

  listModels(): Promise<ModelInfo[]> {
    try {
      return Promise.resolve(REQUESTY_MODELS.map(model => ({
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
      })));
    } catch (error) {
      this.handleError(error, 'listing models');
      return Promise.resolve([]);
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
    const requestBody: Record<string, unknown> = {
      model: options?.model || this.currentModel,
      messages: this.buildMessages(prompt, options?.systemPrompt),
      temperature: options?.temperature,
      max_tokens: options?.maxTokens,
      response_format: options?.jsonMode ? { type: 'json_object' } : undefined,
      stop: options?.stopSequences
    };

    // Add tools if provided
    if (options?.tools) {
      requestBody.tools = options.tools;
    }

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

    const data = response.json;
    if (!data) {
      throw new Error('No response from Requesty');
    }
    const choice = data.choices[0];
    
    if (!choice) {
      throw new Error('No response from Requesty');
    }
    
    let text = choice.message?.content || '';
    const usage = this.extractUsage(data);
    const finishReason = this.mapFinishReason(choice.finish_reason || null);

    // If tools were provided and we got tool calls, return placeholder text
    if (options?.tools && choice.message?.toolCalls && choice.message.toolCalls.length > 0) {
      text = text || '[AI requested tool calls but tool execution not available]';
    }

    return this.buildLLMResponse(
      text,
      options?.model || this.currentModel,
      usage,
      { provider: 'requesty' },
      finishReason
    );
  }

  // Private methods
  private extractToolCalls(message: RequestyMessage | undefined): RequestyToolCall[] {
    return message?.toolCalls || [];
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

  protected extractUsage(response: RequestyChatCompletionResponse): { promptTokens: number; completionTokens: number; totalTokens: number } | undefined {
    const usage = response.usage;
    if (usage) {
      return {
        promptTokens: usage.prompt_tokens || 0,
        completionTokens: usage.completion_tokens || 0,
        totalTokens: usage.total_tokens || 0
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

  getModelPricing(modelId: string): Promise<ModelPricing | null> {
    const costs = this.getCostPer1kTokens(modelId);
    if (!costs) return Promise.resolve(null);

    return Promise.resolve({
      rateInputPerMillion: costs.input * 1000,
      rateOutputPerMillion: costs.output * 1000,
      currency: 'USD'
    });
  }
}
