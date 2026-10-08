/**
 * Requesty AI Adapter with true streaming support
 * OpenAI-compatible streaming interface for 150+ models via router
 * Based on Requesty streaming documentation
 */

import { BRAND_NAME } from '../../../../constants/branding';
import { BaseAdapter } from '../BaseAdapter';
import {
  GenerateOptions,
  StreamChunk,
  LLMResponse,
  ModelInfo,
  ProviderCapabilities,
  ModelPricing,
  TokenUsage
} from '../types';
import { extractStreamErrorMessage } from '../../streaming/streamErrorFrames';
import { REQUESTY_MODELS, REQUESTY_DEFAULT_MODEL } from './RequestyModels';
import { mapOpenAiCompatFinishReason, buildMessagesWithConversationHistory } from '../shared/OpenAICompatHelpers';
import { staticModelToModelInfo, getStaticModelPricing } from '../shared/StaticModelHelpers';
import { TokenUsageExtractor } from '../../utils/TokenUsageExtractor';

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
  content?: string | RequestyContentPart[];
  reasoning_content?: string;
  toolCalls?: RequestyToolCall[];
}

interface RequestyContentPart {
  type?: string;
  text?: string;
  thinking?: Array<{ type?: string; text?: string }>;
  [key: string]: unknown;
}

interface RequestyChoice {
  message?: RequestyMessage;
  delta?: {
    content?: string | RequestyContentPart[];
    reasoning_content?: string;
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
    content?: string | RequestyContentPart[];
    reasoning_content?: string;
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

  private isLarge4Model(model: string): boolean {
    return model === 'mistral/mistral-large-4' || model === 'mistral-large-4';
  }

  private getReasoningEffort(model: string, options?: GenerateOptions): 'high' | 'none' | undefined {
    return this.isLarge4Model(model) ? (options?.enableThinking ? 'high' : 'none') : undefined;
  }

  protected generateCacheKey(prompt: string, options?: GenerateOptions): string {
    return `${super.generateCacheKey(prompt, options)}:reasoning=${this.getReasoningEffort(options?.model || this.currentModel, options) ?? 'default'}`;
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
      const assistantContent: RequestyContentPart[] = [];
      let sawTypedContent = false;
      let plainContent = '';
      let flatReasoning = '';
      let reasoningStarted = false;
      let reasoningClosed = false;
      const nodeStream = await this.requestStream({
        url: `${this.baseUrl}/chat/completions`,
        operation: 'streaming generation',
        method: 'POST',
        headers: {
          ...this.buildHeaders(),
          'Authorization': `Bearer ${this.apiKey}`,
          // Attribution only — these are header VALUES that show up in Requesty's
          // dashboard, not request targets. Nothing is ever fetched from the
          // referer. They read 'synaptic-lab-kit.com' / 'Synaptic Lab Kit' until
          // 2026-08-15: a paste from another project, pointing at a domain that
          // no longer resolves. Keep them in step with the OpenRouter adapters.
          'HTTP-Referer': 'https://synapticlabs.ai',
          'X-Title': BRAND_NAME
        },
        body: JSON.stringify({
          model,
          messages: buildMessagesWithConversationHistory(prompt, options),
          reasoning_effort: this.getReasoningEffort(model, options),
          temperature: options?.temperature,
          max_tokens: options?.maxTokens,
          response_format: options?.jsonMode ? { type: 'json_object' } : undefined,
          stop: options?.stopSequences,
          tools: options?.tools,
          stream: true
        }),
        timeoutMs: 120_000
      });

      const stream = this.processNodeStream(nodeStream, {
        debugLabel: 'Requesty',
        extractMetadata: (parsed) => {
          if (!this.isLarge4Model(model)) return null;
          const delta = (parsed as RequestySSEParsedEvent).choices?.[0]?.delta;
          const content = delta?.content;
          if (Array.isArray(content)) sawTypedContent = true;
          if (content && sawTypedContent) this.appendAssistantContent(assistantContent, content);
          if (delta?.reasoning_content) flatReasoning += delta.reasoning_content;
          if (!sawTypedContent && !flatReasoning) return null;
          return {
            thinking: this.extractThinkingText(assistantContent) || flatReasoning,
            ...(flatReasoning ? { reasoningContent: flatReasoning } : {}),
            ...(sawTypedContent ? { mistralAssistantContent: this.copyAssistantContent(assistantContent) } : {})
          };
        },
        extractContent: (parsed) => {
          const event = parsed as RequestySSEParsedEvent;
          return this.extractMessageContent(event.choices?.[0]?.delta?.content) || null;
        },
        extractReasoning: (parsed) => {
          if (!this.isLarge4Model(model)) return null;
          const delta = (parsed as RequestySSEParsedEvent).choices?.[0]?.delta;
          const thinking = this.extractThinkingText(delta?.content) || delta?.reasoning_content || '';
          const answer = this.extractMessageContent(delta?.content);
          if (thinking) reasoningStarted = true;
          const complete = Boolean(answer && reasoningStarted && !reasoningClosed);
          if (complete) reasoningClosed = true;
          return thinking || complete ? { text: thinking, complete } : null;
        },
        extractToolCalls: (parsed) => {
          const event = parsed as RequestySSEParsedEvent;
          return event.choices?.[0]?.delta?.tool_calls || null;
        },
        extractFinishReason: (parsed) => {
          const event = parsed as RequestySSEParsedEvent;
          return event.choices?.[0]?.finish_reason || null;
        },
        // The router is OpenAI-compatible and forwards upstream failures as an
        // {"error":{...}} frame over HTTP 200.
        extractError: (parsed) => extractStreamErrorMessage(parsed, 'Requesty streaming error'),
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
      for await (const chunk of stream) {
        if (this.isLarge4Model(model) && chunk.content) plainContent += chunk.content;
        if (this.isLarge4Model(model) && sawTypedContent && chunk.toolCallsReady && chunk.toolCalls?.length) {
          const snapshot = this.copyAssistantContent(assistantContent);
          chunk.toolCalls = chunk.toolCalls.map(call => ({ ...call, mistral_assistant_content: snapshot }));
        }
        if (this.isLarge4Model(model) && chunk.complete) {
          chunk.metadata = {
            ...chunk.metadata,
            mistralResponse: {
              content: sawTypedContent ? this.copyAssistantContent(assistantContent) : plainContent,
              toolCallIds: chunk.toolCalls?.map(call => call.id) ?? []
            }
          };
        }
        yield chunk;
      }
    } catch (error) {
      console.error('[RequestyAdapter] Streaming error:', error);
      throw error;
    }
  }

  listModels(): Promise<ModelInfo[]> {
    try {
      return Promise.resolve(REQUESTY_MODELS.map(model => ({
        ...staticModelToModelInfo(model),
        supportsThinking: this.isLarge4Model(model.apiName)
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
      supportsThinking: this.isLarge4Model(this.currentModel),
      maxContextWindow: Math.max(...REQUESTY_MODELS.map(model => model.contextWindow)),
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
    const requestBody: Record<string, unknown> = {
      model,
      messages: buildMessagesWithConversationHistory(prompt, options),
      reasoning_effort: this.getReasoningEffort(model, options),
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
        // See the note on the streaming request above: attribution headers, not
        // request targets.
        'HTTP-Referer': 'https://synapticlabs.ai',
        'X-Title': BRAND_NAME
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
    
    let text = this.extractMessageContent(choice.message?.content);
    const thinking = this.isLarge4Model(model)
      ? this.extractThinkingText(choice.message?.content) || choice.message?.reasoning_content || ''
      : '';
    const metadata = this.isLarge4Model(model) && (thinking || Array.isArray(choice.message?.content))
      ? {
        thinking,
        ...(choice.message?.reasoning_content ? { reasoningContent: choice.message.reasoning_content } : {}),
        ...(Array.isArray(choice.message?.content) ? { mistralAssistantContent: choice.message.content } : {})
      }
      : undefined;
    const usage = this.extractUsage(data);
    const finishReason = mapOpenAiCompatFinishReason(choice.finish_reason || null);

    // If tools were provided and we got tool calls, return placeholder text
    if (options?.tools && choice.message?.toolCalls && choice.message.toolCalls.length > 0) {
      text = text || '[AI requested tool calls but tool execution not available]';
    }

    return this.buildLLMResponse(
      text,
      model,
      usage,
      { provider: 'requesty', ...metadata },
      finishReason
    );
  }

  private extractMessageContent(content: RequestyMessage['content']): string {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content.filter(part => part.type === 'text').map(part => part.text ?? '').join('');
  }

  private extractThinkingText(content: RequestyMessage['content']): string {
    if (!Array.isArray(content)) return '';
    return content.filter(part => part.type === 'thinking')
      .flatMap(part => part.thinking ?? [])
      .filter(part => part.type === 'text')
      .map(part => part.text ?? '')
      .join('');
  }

  private appendAssistantContent(target: RequestyContentPart[], content: RequestyMessage['content']): void {
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

  private copyAssistantContent(content: RequestyContentPart[]): RequestyContentPart[] {
    return content.map(part => ({
      ...part,
      ...(part.thinking ? { thinking: part.thinking.map(item => ({ ...item })) } : {})
    }));
  }

  // Private methods
  private extractToolCalls(message: RequestyMessage | undefined): RequestyToolCall[] {
    return message?.toolCalls || [];
  }

  protected extractUsage(response: RequestyChatCompletionResponse): TokenUsage | undefined {
    const usage = response.usage;
    if (usage) {
      return TokenUsageExtractor.normalize(usage);
    }
    return undefined;
  }

  getModelPricing(modelId: string): Promise<ModelPricing | null> {
    return Promise.resolve(getStaticModelPricing(REQUESTY_MODELS, modelId));
  }
}
