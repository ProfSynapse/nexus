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
import { extractStreamErrorMessage } from '../../streaming/streamErrorFrames';
import { MISTRAL_MODELS, MISTRAL_DEFAULT_MODEL } from './MistralModels';
import {
  buildBearerJsonHeaders,
  buildMessagesWithConversationHistory
} from '../shared/OpenAICompatHelpers';
import { staticModelToModelInfo, getStaticModelPricing } from '../shared/StaticModelHelpers';
import { TokenUsageExtractor } from '../../utils/TokenUsageExtractor';

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
  thinking?: Array<{ type?: string; text?: string }>;
  [key: string]: unknown;
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
      content?: string | MistralMessageContentPart[];
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

  private isLarge4Model(model: string): boolean {
    return model === 'mistral-large-4' || model === 'mistral-large-4-0';
  }

  private getReasoningEffort(model: string, options?: GenerateOptions): 'high' | 'none' | undefined {
    return this.isLarge4Model(model) ? (options?.enableThinking ? 'high' : 'none') : undefined;
  }

  protected generateCacheKey(prompt: string, options?: GenerateOptions): string {
    const key = super.generateCacheKey(prompt, options);
    const model = options?.model || this.currentModel;
    if (!this.isLarge4Model(model)) return key;
    return `${key}:reasoning=${this.getReasoningEffort(model, options)}`;
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
      const model = options?.model || this.currentModel;
      const assistantContent: MistralMessageContentPart[] = [];
      let sawTypedContent = false;
      let plainContent = '';
      let reasoningStarted = false;
      let reasoningClosed = false;
      const nodeStream = await this.requestStream({
        url: `${this.baseUrl}/v1/chat/completions`,
        operation: 'streaming generation',
        method: 'POST',
        headers: buildBearerJsonHeaders(this.apiKey),
        body: JSON.stringify({
          model,
          messages: buildMessagesWithConversationHistory(prompt, options),
          reasoning_effort: this.getReasoningEffort(model, options),
          temperature: options?.temperature,
          max_tokens: options?.maxTokens,
          top_p: options?.topP,
          stop: options?.stopSequences,
          tools: options?.tools ? this.convertTools(options.tools) : undefined,
          stream: true
        }),
        timeoutMs: 120_000
      });

      for await (const chunk of this.processNodeStream(nodeStream, {
        debugLabel: 'Mistral',
        extractMetadata: (chunk) => {
          if (!this.isLarge4Model(model)) return null;
          const content = (chunk as MistralStreamChunk).choices?.[0]?.delta?.content;
          if (!content) return null;
          if (Array.isArray(content)) sawTypedContent = true;
          this.appendAssistantContent(assistantContent, content);
          return {
            thinking: this.extractThinkingText(assistantContent),
            mistralAssistantContent: assistantContent.map(part => ({ ...part }))
          };
        },
        extractContent: (chunk) => this.extractMessageContent((chunk as MistralStreamChunk).choices?.[0]?.delta?.content) || null,
        extractReasoning: (chunk) => {
          if (!this.isLarge4Model(model)) return null;
          const content = (chunk as MistralStreamChunk).choices?.[0]?.delta?.content;
          const thinking = this.extractThinkingText(content);
          const answer = this.extractMessageContent(content);
          if (thinking) reasoningStarted = true;
          const complete = Boolean(answer && reasoningStarted && !reasoningClosed);
          if (complete) reasoningClosed = true;
          return thinking || complete ? { text: thinking, complete } : null;
        },
        extractToolCalls: (chunk) => (chunk as MistralStreamChunk).choices?.[0]?.delta?.tool_calls || null,
        extractFinishReason: (chunk) => (chunk as MistralStreamChunk).choices?.[0]?.finish_reason || null,
        // Mistral reports failures both as {"error":{...}} and as its own
        // {"object":"error","message":"..."} body -- the shared extractor covers both.
        extractError: (chunk) => extractStreamErrorMessage(chunk, 'Mistral streaming error'),
        extractUsage: (chunk) => (chunk as MistralStreamChunk).usage,
        accumulateToolCalls: true,
        toolCallThrottling: {
          initialYield: true,
          progressInterval: 50
        }
      })) {
        if (this.isLarge4Model(model) && chunk.content) plainContent += chunk.content;
        if (this.isLarge4Model(model) && chunk.toolCalls && assistantContent.length > 0) {
          const content = assistantContent.map(part => ({ ...part }));
          chunk.toolCalls = chunk.toolCalls.map(call => ({
            ...call,
            mistral_assistant_content: content
          }));
        }
        if (this.isLarge4Model(model) && chunk.complete) {
          chunk.metadata = {
            ...chunk.metadata,
            mistralResponse: {
              content: sawTypedContent ? assistantContent.map(part => ({ ...part })) : plainContent,
              toolCallIds: chunk.toolCalls?.map(call => call.id) ?? []
            }
          };
        }
        yield chunk;
      }
    } catch (error) {
      console.error('[MistralAdapter] Streaming error:', error);
      throw error;
    }
  }

  listModels(): Promise<ModelInfo[]> {
    try {
      return Promise.resolve(MISTRAL_MODELS.map(model => ({
        ...staticModelToModelInfo(model),
        supportsThinking: model.capabilities.supportsThinking ?? false
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
      supportsThinking: true,
      maxContextWindow: Math.max(...MISTRAL_MODELS.map(model => model.contextWindow)),
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
      reasoning_effort: this.getReasoningEffort(model, options),
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
    const thinking = this.extractThinkingText(choice.message?.content);
    const metadata = thinking || Array.isArray(choice.message?.content)
      ? { thinking, mistralAssistantContent: choice.message?.content }
      : undefined;
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
      metadata,
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

  private extractThinkingText(content: MistralMessage['content']): string {
    if (!Array.isArray(content)) return '';
    return content
      .filter(chunk => chunk.type === 'thinking')
      .flatMap(chunk => chunk.thinking ?? [])
      .filter(chunk => chunk.type === 'text')
      .map(chunk => chunk.text ?? '')
      .join('');
  }

  private appendAssistantContent(target: MistralMessageContentPart[], content: MistralMessage['content']): void {
    const parts = typeof content === 'string' ? [{ type: 'text', text: content }] : content ?? [];
    for (const part of parts) {
      const previous = target[target.length - 1];
      if (part.type === 'text' && previous?.type === 'text') {
        previous.text = (previous.text ?? '') + (part.text ?? '');
      } else if (part.type === 'thinking' && previous?.type === 'thinking') {
        previous.thinking = [...(previous.thinking ?? []), ...(part.thinking ?? [])];
      } else {
        target.push({ ...part });
      }
    }
  }

  protected extractUsage(response: MistralChatResponse): TokenUsage | undefined {
    const usage = response.usage;
    if (usage) {
      return TokenUsageExtractor.normalize(usage);
    }
    return undefined;
  }

  getModelPricing(modelId: string): Promise<ModelPricing | null> {
    return Promise.resolve(getStaticModelPricing(MISTRAL_MODELS, modelId));
  }
}
