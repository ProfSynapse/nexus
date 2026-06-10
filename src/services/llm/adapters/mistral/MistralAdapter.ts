/**
 * Mistral AI Adapter with true streaming support
 * Implements Mistral's REST API directly over requestUrl.
 */

import { BaseAdapter } from '../BaseAdapter';
import {
  GenerateOptions, 
  StreamChunk, 
  LLMResponse, 
  ModelInfo, 
  ProviderCapabilities,
  ModelPricing,
  TokenUsage,
} from '../types';
import { MISTRAL_MODELS, MISTRAL_DEFAULT_MODEL } from './MistralModels';
import {
  buildBearerJsonHeaders,
  buildMessagesWithConversationHistory
} from '../shared/OpenAICompatHelpers';
import { staticModelToModelInfo, getStaticModelPricing } from '../shared/StaticModelHelpers';

interface MistralToolDefinition {
  type?: string;
  name?: string;
  description?: string;
  parameters?: Record<string, unknown>;
  input_schema?: Record<string, unknown>;
  function?: {
    name?: string;
    description?: string;
    parameters?: Record<string, unknown>;
    input_schema?: Record<string, unknown>;
  };
}

type MistralToolInput = {
  type?: string;
  name?: string;
  description?: string;
  parameters?: Record<string, unknown>;
  input_schema?: Record<string, unknown>;
  function?: {
    name?: string;
    description?: string;
    parameters?: Record<string, unknown>;
    input_schema?: Record<string, unknown>;
  };
};

interface MistralMessageContentPart {
  type?: string;
  text?: string;
}

interface MistralMessage {
  content?: string | MistralMessageContentPart[];
  toolCalls?: Array<Record<string, unknown>>;
  tool_calls?: Array<Record<string, unknown>>;
}

interface MistralChoice {
  message?: MistralMessage;
  finish_reason?: string;
  finishReason?: string;
}

interface MistralChatResponse {
  choices: MistralChoice[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

type MistralStreamChunk = {
  choices?: Array<{
    delta?: {
      content?: string;
      tool_calls?: Array<Record<string, unknown>>;
    };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
};

export class MistralAdapter extends BaseAdapter {
  readonly name = 'mistral';
  readonly baseUrl = 'https://api.mistral.ai';

  constructor(apiKey: string, model?: string) {
    super(apiKey, model || MISTRAL_DEFAULT_MODEL);
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
        url: `${this.baseUrl}/v1/chat/completions`,
        operation: 'streaming generation',
        method: 'POST',
        headers: buildBearerJsonHeaders(this.apiKey),
        body: JSON.stringify({
          model: options?.model || this.currentModel,
          messages: buildMessagesWithConversationHistory(prompt, options),
          temperature: options?.temperature,
          max_tokens: options?.maxTokens,
          top_p: options?.topP,
          stop: options?.stopSequences,
          tools: options?.tools ? this.convertTools(options.tools) : undefined,
          stream: true
        }),
        timeoutMs: 120_000
      });

      yield* this.processNodeStream(nodeStream, {
        debugLabel: 'Mistral',
        extractContent: (chunk) => (chunk as MistralStreamChunk).choices?.[0]?.delta?.content || null,
        extractToolCalls: (chunk) => (chunk as MistralStreamChunk).choices?.[0]?.delta?.tool_calls || null,
        extractFinishReason: (chunk) => (chunk as MistralStreamChunk).choices?.[0]?.finish_reason || null,
        extractUsage: (chunk) => (chunk as MistralStreamChunk).usage,
        accumulateToolCalls: true,
        toolCallThrottling: {
          initialYield: true,
          progressInterval: 50
        }
      });
    } catch (error) {
      console.error('[MistralAdapter] Streaming error:', error);
      throw error;
    }
  }

  listModels(): Promise<ModelInfo[]> {
    try {
      return Promise.resolve(MISTRAL_MODELS.map(model => ({
        ...staticModelToModelInfo(model),
        supportsThinking: false
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
      maxContextWindow: 128000,
      supportedFeatures: [
        'messages',
        'function_calling',
        'streaming',
        'json_mode'
      ]
    };

    return baseCapabilities;
  }

  /**
   * Generate using standard chat completions
   */
  private async generateWithChatCompletions(prompt: string, options?: GenerateOptions): Promise<LLMResponse> {
    const model = options?.model || this.currentModel;

    // Build request body with snake_case keys matching the Mistral REST API
    const requestBody: Record<string, unknown> = {
      model,
      messages: options?.conversationHistory && options.conversationHistory.length > 0
        ? options.conversationHistory
        : this.buildMessages(prompt, options?.systemPrompt),
      temperature: options?.temperature,
      max_tokens: options?.maxTokens,
      top_p: options?.topP,
      stop: options?.stopSequences
    };

    // Add tools if provided
    if (options?.tools) {
      requestBody.tools = this.convertTools(options.tools);
    }

    const response = await this.request<MistralChatResponse>({
      url: `${this.baseUrl}/v1/chat/completions`,
      operation: 'generation',
      method: 'POST',
      headers: buildBearerJsonHeaders(this.apiKey),
      body: JSON.stringify(requestBody),
      timeoutMs: 60_000
    });
    this.assertOk(response, `Mistral generation failed: HTTP ${response.status}`);
    const responseJson = response.json;
    if (!responseJson) {
      throw new Error('No response from Mistral');
    }
    if (!responseJson.choices || responseJson.choices.length === 0) {
      throw new Error('No response from Mistral');
    }
    const choice = responseJson.choices[0];
    
    if (!choice) {
      throw new Error('No response from Mistral');
    }
    
    let text = this.extractMessageContent(choice.message?.content) || '';
    const usage = this.extractUsage(responseJson);
    const finishReason = choice.finish_reason || choice.finishReason || 'stop';
    const toolCalls = choice.message?.toolCalls || choice.message?.tool_calls || [];

    // If tools were provided and we got tool calls, return placeholder text
    if (options?.tools && toolCalls.length > 0) {
      text = text || '[AI requested tool calls but tool execution not available]';
    }

    return this.buildLLMResponse(
      text,
      model,
      usage,
      undefined,
      finishReason as 'stop' | 'length' | 'tool_calls' | 'content_filter'
    );
  }

  // Private methods
  private convertTools(tools: MistralToolInput[]): MistralToolDefinition[] {
    return tools.map(tool => {
      if (tool.type === 'function') {
        // Handle both nested (Chat Completions) and flat (Responses API) formats
        const toolDef = tool.function || tool;
        return {
          type: 'function',
          function: {
            name: toolDef.name,
            description: toolDef.description,
            parameters: toolDef.parameters || toolDef.input_schema
          }
        };
      }
      return tool;
    });
  }

  private extractMessageContent(content: MistralMessage['content']): string {
    if (typeof content === 'string') {
      return content;
    }
    if (Array.isArray(content)) {
      return content
        .filter(chunk => chunk.type === 'text')
        .map(chunk => chunk.text || '')
        .join('');
    }
    return '';
  }

  protected extractUsage(response: MistralChatResponse): TokenUsage | undefined {
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

  getModelPricing(modelId: string): Promise<ModelPricing | null> {
    return Promise.resolve(getStaticModelPricing(MISTRAL_MODELS, modelId));
  }
}
