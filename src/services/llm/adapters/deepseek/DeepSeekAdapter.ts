/**
 * DeepSeek Adapter
 *
 * DeepSeek exposes an OpenAI-compatible REST surface at
 * https://api.deepseek.com with Bearer-token auth. Notable differences from
 * upstream OpenAI:
 *   - Thinking mode is opt-in via the `thinking: { type, reasoning_effort }`
 *     request param (NOT the top-level `reasoning_effort` shape Groq uses).
 *   - Reasoning text is surfaced in `delta.reasoning_content` (streaming) or
 *     `message.reasoning_content` (non-streaming) and is mapped onto the
 *     unified StreamChunk.reasoning / LLMResponse.metadata.reasoning fields.
 *   - `frequency_penalty` and `presence_penalty` are NOT supported and must
 *     be stripped from outbound requests even when our shared GenerateOptions
 *     carries them.
 *
 * Mirrors the shape of GroqAdapter (closest sibling: OpenAI-compatible + SSE
 * via processNodeStream) intentionally. Do not consolidate into a generic
 * adapter — DeepSeek's thinking shape and reasoning_content surface are
 * provider-specific.
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
import type { SSEToolCall } from '../../streaming/SSEStreamProcessor';
import {
  DEEPSEEK_MODELS,
  DEEPSEEK_DEFAULT_MODEL,
  isDeepSeekThinkingModel,
  resolveDeepSeekApiModel
} from './DeepSeekModels';
import {
  buildBearerJsonHeaders,
  mapOpenAiCompatFinishReason,
  buildMessagesWithConversationHistory,
  convertFunctionTools
} from '../shared/OpenAICompatHelpers';
import { getStaticModelPricing } from '../shared/StaticModelHelpers';

interface DeepSeekChatCompletionUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
}

interface DeepSeekChatCompletionMessage {
  content?: string;
  reasoning_content?: string;
  tool_calls?: unknown[];
}

interface DeepSeekChatCompletionChoice {
  delta?: DeepSeekChatCompletionMessage & {
    content?: string;
    reasoning_content?: string;
    tool_calls?: unknown[];
  };
  message?: DeepSeekChatCompletionMessage;
  finish_reason?: string | null;
}

interface DeepSeekChatCompletionResponse {
  choices: DeepSeekChatCompletionChoice[];
  usage?: DeepSeekChatCompletionUsage;
}

type DeepSeekChatCompletionMessageParam = Record<string, unknown>;

function isDeepSeekChatCompletionResponse(parsed: unknown): parsed is DeepSeekChatCompletionResponse {
  if (!parsed || typeof parsed !== 'object') {
    return false;
  }
  return Array.isArray((parsed as Record<string, unknown>).choices);
}

/**
 * Map our unified ThinkingEffort ('low' | 'medium' | 'high') onto DeepSeek's
 * accepted reasoning_effort values ('high' | 'max'). DeepSeek does not have a
 * 'low' tier; we surface 'high' as the entry point and reserve 'max' for the
 * 'high' setting (which our UI treats as the most aggressive option).
 */
function mapDeepSeekReasoningEffort(effort: 'low' | 'medium' | 'high'): 'high' | 'max' {
  return effort === 'high' ? 'max' : 'high';
}

export class DeepSeekAdapter extends BaseAdapter {
  readonly name = 'deepseek';
  readonly baseUrl = 'https://api.deepseek.com';

  constructor(apiKey: string, model?: string) {
    super(apiKey, model || DEEPSEEK_DEFAULT_MODEL);
    this.initializeCache();
  }

  async generateUncached(prompt: string, options?: GenerateOptions): Promise<LLMResponse> {
    try {
      if (options?.tools && options.tools.length > 0) {
        throw new Error('Tool execution requires streaming. Use generateStreamAsync() instead.');
      }
      return await this.generateWithChatCompletions(prompt, options);
    } catch (error) {
      this.handleError(error, 'generation');
    }
  }

  async* generateStreamAsync(prompt: string, options?: GenerateOptions): AsyncGenerator<StreamChunk, void, unknown> {
    try {
      const requestBody = this.buildRequestBody(prompt, options, true);

      const nodeStream = await this.requestStream({
        url: `${this.baseUrl}/chat/completions`,
        operation: 'streaming generation',
        method: 'POST',
        headers: buildBearerJsonHeaders(this.apiKey),
        body: JSON.stringify(requestBody),
        timeoutMs: 120_000
      });

      yield* this.processNodeStream(nodeStream, {
        debugLabel: 'DeepSeek',
        extractContent: (chunk) => {
          if (!isDeepSeekChatCompletionResponse(chunk)) return null;
          return chunk.choices[0]?.delta?.content || null;
        },
        extractReasoning: (chunk) => {
          if (!isDeepSeekChatCompletionResponse(chunk)) return null;
          const reasoning = chunk.choices[0]?.delta?.reasoning_content;
          if (typeof reasoning === 'string' && reasoning.length > 0) {
            return { text: reasoning, complete: false };
          }
          return null;
        },
        extractToolCalls: (chunk) => {
          if (!isDeepSeekChatCompletionResponse(chunk)) return null;
          return (chunk.choices[0]?.delta?.tool_calls || null) as SSEToolCall[] | null;
        },
        extractFinishReason: (chunk) => {
          if (!isDeepSeekChatCompletionResponse(chunk)) return null;
          return chunk.choices[0]?.finish_reason ?? null;
        },
        extractUsage: (chunk) => {
          if (!chunk || typeof chunk !== 'object') return undefined;
          const usage = (chunk as unknown as DeepSeekChatCompletionResponse).usage;
          if (!usage) return undefined;
          return {
            prompt_tokens: usage.prompt_tokens,
            completion_tokens: usage.completion_tokens,
            total_tokens: usage.total_tokens
          };
        },
        accumulateToolCalls: true,
        toolCallThrottling: {
          initialYield: true,
          progressInterval: 50
        }
      });
    } catch (error) {
      console.error('[DeepSeekAdapter] Streaming error:', error);
      throw error;
    }
  }

  listModels(): Promise<ModelInfo[]> {
    try {
      return Promise.resolve(DEEPSEEK_MODELS.map(model => ({
        id: model.apiName,
        name: model.name,
        contextWindow: model.contextWindow,
        maxOutputTokens: model.maxTokens,
        supportsJSON: model.capabilities.supportsJSON,
        supportsImages: model.capabilities.supportsImages,
        supportsFunctions: model.capabilities.supportsFunctions,
        supportsStreaming: model.capabilities.supportsStreaming,
        supportsThinking: model.capabilities.supportsThinking,
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
    return {
      supportsStreaming: true,
      streamingMode: 'streaming',
      supportsJSON: true,
      supportsImages: false,
      supportsFunctions: true,
      supportsThinking: true,
      maxContextWindow: 1_000_000,
      supportedFeatures: [
        'messages',
        'function_calling',
        'streaming',
        'json_mode',
        'thinking_mode',
        'reasoning_content'
      ]
    };
  }

  getModelPricing(modelId: string): Promise<ModelPricing | null> {
    return Promise.resolve(getStaticModelPricing(DEEPSEEK_MODELS, modelId));
  }

  private async generateWithChatCompletions(prompt: string, options?: GenerateOptions): Promise<LLMResponse> {
    const requestBody = this.buildRequestBody(prompt, options, false);

    const response = await this.request<DeepSeekChatCompletionResponse>({
      url: `${this.baseUrl}/chat/completions`,
      operation: 'generation',
      method: 'POST',
      headers: buildBearerJsonHeaders(this.apiKey),
      body: JSON.stringify(requestBody),
      timeoutMs: 60_000
    });
    this.assertOk(response, `DeepSeek generation failed: HTTP ${response.status}`);

    const responseJson = response.json as DeepSeekChatCompletionResponse;
    const choice = responseJson.choices[0];
    if (!choice) {
      throw new Error('No response from DeepSeek');
    }

    const text = choice.message?.content || '';
    const reasoning = choice.message?.reasoning_content;
    const usage = this.extractUsage(responseJson);
    const finishReason = this.mapFinishReason(choice.finish_reason ?? null);

    const metadata: Record<string, unknown> = {};
    if (typeof reasoning === 'string' && reasoning.length > 0) {
      metadata.reasoning = reasoning;
    }

    const apiModel = resolveDeepSeekApiModel(options?.model || this.currentModel);
    return this.buildLLMResponse(
      text,
      // Surface the user-facing model id (preserving -thinking suffix) so
      // pricing/registry lookups still resolve correctly.
      options?.model || this.currentModel,
      usage,
      Object.keys(metadata).length > 0 ? metadata : undefined,
      finishReason
    ).then((built) => {
      // Store the wire-side model id for telemetry consumers that want it.
      if (built.metadata) {
        built.metadata.apiModel = apiModel;
      }
      return built;
    });
  }

  /**
   * Build the request body for /chat/completions. Centralized so streaming
   * and non-streaming paths share the exact same shape — including the
   * thinking-mode toggle and the explicit drop of frequency/presence
   * penalties.
   */
  private buildRequestBody(prompt: string, options: GenerateOptions | undefined, stream: boolean): Record<string, unknown> {
    const userModel = options?.model || this.currentModel;
    const apiModel = resolveDeepSeekApiModel(userModel);

    const body: Record<string, unknown> = {
      model: apiModel,
      messages: this.buildMessagesForRequest(prompt, options),
      temperature: options?.temperature,
      max_tokens: options?.maxTokens,
      top_p: options?.topP,
      stop: options?.stopSequences,
      response_format: options?.jsonMode ? { type: 'json_object' } : undefined,
      stream
    };

    if (options?.tools && options.tools.length > 0) {
      body.tools = this.convertTools(options.tools);
    }

    // Note: frequency_penalty and presence_penalty are intentionally NOT
    // forwarded to DeepSeek. The API removed support and including them
    // results in a 400 error response.

    const thinkingRequested = isDeepSeekThinkingModel(userModel) || options?.enableThinking === true;
    if (thinkingRequested) {
      const effort = options?.thinkingEffort || 'medium';
      body.thinking = {
        type: 'enabled',
        reasoning_effort: mapDeepSeekReasoningEffort(effort)
      };
    }

    // Strip undefined keys so we don't emit `"temperature": undefined`
    // through JSON.stringify (which silently drops them but pollutes diffs).
    for (const key of Object.keys(body)) {
      if (body[key] === undefined) {
        delete body[key];
      }
    }

    return body;
  }

  private convertTools(tools: Tool[]): Array<{ type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }> {
    return convertFunctionTools(tools);
  }

  private mapFinishReason(reason: string | null): 'stop' | 'length' | 'tool_calls' | 'content_filter' {
    return mapOpenAiCompatFinishReason(reason);
  }

  protected extractUsage(response: DeepSeekChatCompletionResponse): TokenUsage | undefined {
    const usage = response?.usage;
    if (!usage) return undefined;
    return {
      promptTokens: usage.prompt_tokens || 0,
      completionTokens: usage.completion_tokens || 0,
      totalTokens: usage.total_tokens || 0,
      ...(usage.prompt_cache_hit_tokens !== undefined && { cachedTokens: usage.prompt_cache_hit_tokens })
    };
  }

  private buildMessagesForRequest(prompt: string, options?: GenerateOptions): DeepSeekChatCompletionMessageParam[] {
    return buildMessagesWithConversationHistory(prompt, options);
  }
}
