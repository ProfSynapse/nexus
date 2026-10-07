import type { LLMProviderConfig } from '../../../../types';
import { BaseAdapter } from '../BaseAdapter';
import { LLMProviderError, type GenerateOptions, type LLMResponse, type ModelInfo, type ModelPricing, type ProviderCapabilities, type StreamChunk } from '../types';
import { buildMessagesWithConversationHistory, convertFunctionTools } from '../shared/OpenAICompatHelpers';
import {
  buildOpenAICompatibleModels, isOpenAICompatibleModelId, OPENAI_COMPATIBLE_CONTEXT_WINDOW,
  OPENAI_COMPATIBLE_GENERATION_TIMEOUT_MS, openAICompatibleHeaders, validateOpenAICompatibleConfig,
} from './OpenAICompatibleConfig';
import { normalizeOpenAICompatibleCompletion, processOpenAICompatibleStream } from './OpenAICompatibleResponse';

/** The driver name is separate; this adapter's name is its stable configured instance ID. */
export class OpenAICompatibleAdapter extends BaseAdapter {
  readonly name: string;
  readonly baseUrl: string;
  private readonly savedModels: ModelInfo[];
  private readonly activeRequests = new Set<AbortController>();
  private disposed = false;

  constructor(config: LLMProviderConfig, instanceId: string) {
    const baseUrl = validateOpenAICompatibleConfig(config);
    const models = buildOpenAICompatibleModels(config);
    super(config.apiKey, models[0]?.id ?? '', baseUrl, false);
    this.name = instanceId;
    this.baseUrl = baseUrl;
    this.savedModels = models;
    this.initializeCache(); // BaseAdapter's metrics surface; generation deliberately bypasses it.
  }

  /** Never cache a remote agent's answer or accidentally skip an action request. */
  override generate(prompt: string, options?: GenerateOptions): Promise<LLMResponse> {
    return this.generateUncached(prompt, options);
  }

  private buildBody(prompt: string, options: GenerateOptions | undefined, stream: boolean): Record<string, unknown> {
    const model = options?.model || this.currentModel;
    if (!isOpenAICompatibleModelId(model)) throw new LLMProviderError('Choose a model ID for this endpoint.', this.name, 'INVALID_MODEL');
    const body: Record<string, unknown> = {
      model, messages: buildMessagesWithConversationHistory(prompt, options), stream,
    };
    const fields: Array<[string, unknown]> = [
      ['temperature', options?.temperature], ['max_tokens', options?.maxTokens],
      ['top_p', options?.topP], ['frequency_penalty', options?.frequencyPenalty],
      ['presence_penalty', options?.presencePenalty], ['stop', options?.stopSequences],
    ];
    for (const [key, value] of fields) if (value !== undefined) body[key] = value;
    if (options?.jsonMode) body.response_format = { type: 'json_object' };
    if (options?.enableTools !== false && options?.tools?.length) {
      body.tools = convertFunctionTools(options.tools);
      body.tool_choice = 'auto';
    }
    return body;
  }

  private requestScope(signal?: AbortSignal): { signal: AbortSignal; cleanup: () => void } {
    if (this.disposed) throw new LLMProviderError('Endpoint has been disposed.', this.name, 'PROVIDER_UNAVAILABLE');
    const controller = new AbortController();
    const relay = () => controller.abort();
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener('abort', relay, { once: true });
    const timer = window.setTimeout(() => controller.abort(
      new LLMProviderError('Endpoint generation deadline exceeded.', this.name, 'TIMEOUT'),
    ), OPENAI_COMPATIBLE_GENERATION_TIMEOUT_MS);
    this.activeRequests.add(controller);
    return {
      signal: controller.signal,
      cleanup: () => {
        window.clearTimeout(timer);
        signal?.removeEventListener('abort', relay);
        this.activeRequests.delete(controller);
      },
    };
  }

  private validateReturnedTools(calls: LLMResponse['toolCalls'], options?: GenerateOptions): void {
    if (!calls?.length) return;
    const allowed = new Set(options?.enableTools === false ? [] : (options?.tools ?? [])
      .filter(tool => tool.type === 'function').map(tool => tool.function?.name));
    if (calls.some(call => !allowed.has(call.function.name))) {
      throw new LLMProviderError('Endpoint returned a function call that Nexus did not offer.', this.name, 'UNEXPECTED_TOOL_CALL');
    }
  }

  private rethrowRequestError(error: unknown, signal: AbortSignal): never {
    if (signal.aborted) {
      if (signal.reason instanceof Error) throw signal.reason;
      throw new LLMProviderError('Request aborted.', this.name, 'ABORTED');
    }
    throw error;
  }

  async generateUncached(prompt: string, options?: GenerateOptions): Promise<LLMResponse> {
    const body = this.buildBody(prompt, options, false);
    const scope = this.requestScope(options?.abortSignal);
    try {
      const response = await this.request<unknown>({
        url: `${this.baseUrl}/chat/completions`, operation: 'generation', method: 'POST',
        headers: openAICompatibleHeaders(this.apiKey), body: JSON.stringify(body),
        timeoutMs: OPENAI_COMPATIBLE_GENERATION_TIMEOUT_MS, signal: scope.signal, retries: 0,
      });
      this.assertOk(response, `Endpoint generation failed: HTTP ${response.status}`);
      const completion = normalizeOpenAICompatibleCompletion(response.json, this.name);
      this.validateReturnedTools(completion.toolCalls, options);
      return {
        text: completion.content, provider: this.name, model: String(body.model),
        usage: completion.usage, toolCalls: completion.toolCalls, finishReason: completion.finishReason,
        metadata: completion.reasoning ? { reasoning: completion.reasoning } : {},
      };
    } catch (error) { this.rethrowRequestError(error, scope.signal); }
    finally { scope.cleanup(); }
  }

  async* generateStreamAsync(prompt: string, options?: GenerateOptions): AsyncGenerator<StreamChunk, void, unknown> {
    const body = this.buildBody(prompt, options, true);
    const scope = this.requestScope(options?.abortSignal);
    try {
      const stream = await this.requestStream({
        url: `${this.baseUrl}/chat/completions`, operation: 'streaming generation', method: 'POST',
        headers: openAICompatibleHeaders(this.apiKey), body: JSON.stringify(body),
        timeoutMs: OPENAI_COMPATIBLE_GENERATION_TIMEOUT_MS, signal: scope.signal,
      });
      for await (const chunk of processOpenAICompatibleStream(stream as AsyncIterable<string | Uint8Array>, this.name)) {
        if (scope.signal.aborted) throw new LLMProviderError('Request aborted.', this.name, 'ABORTED');
        this.validateReturnedTools(chunk.toolCalls, options);
        yield chunk;
      }
    } catch (error) { this.rethrowRequestError(error, scope.signal); }
    finally { scope.cleanup(); }
  }

  listModels(): Promise<ModelInfo[]> {
    return Promise.resolve(this.savedModels.map(model => ({ ...model })));
  }
  override isAvailable(): Promise<boolean> {
    return Promise.resolve(!this.disposed && this.savedModels.length > 0);
  }
  getCapabilities(): ProviderCapabilities {
    return {
      supportsStreaming: true, streamingMode: 'streaming', supportsFunctions: true,
      supportsThinking: true, supportsJSON: false, supportsImages: false,
      maxContextWindow: OPENAI_COMPATIBLE_CONTEXT_WINDOW,
      supportedFeatures: ['messages', 'streaming', 'function_calling'],
    };
  }
  getModelPricing(_modelId: string): Promise<ModelPricing | null> { return Promise.resolve(null); }
  override async clearCache(): Promise<void> { await Promise.resolve(); }
  dispose(): void {
    this.disposed = true;
    for (const controller of this.activeRequests) controller.abort();
    this.activeRequests.clear();
  }
}
