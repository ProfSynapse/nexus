import type { LLMProviderConfig } from '../../../../types';
import { AnthropicAdapter } from '../anthropic/AnthropicAdapter';
import { BaseAdapter } from '../BaseAdapter';
import {
  LLMProviderError,
  type GenerateOptions,
  type LLMResponse,
  type ModelInfo,
  type ModelPricing,
  type ProviderCapabilities,
  type StreamChunk,
} from '../types';
import { isOpenAICompatibleModelId } from '../openai-compatible/OpenAICompatibleConfig';
import {
  resolveDefinitionThinking,
  type ResolvedCompatibleModelThinking,
} from '../shared/CompatibleEndpointUtils';
import {
  ANTHROPIC_COMPATIBLE_CONTEXT_WINDOW,
  buildAnthropicCompatibleModels,
  validateAnthropicCompatibleConfig,
} from './AnthropicCompatibleConfig';

/** Named third-party Anthropic Messages API endpoint (`/v1/messages`). */
export class AnthropicCompatibleAdapter extends BaseAdapter {
  readonly name: string;
  readonly baseUrl: string;
  private readonly delegate: AnthropicAdapter;
  private readonly savedModels: ModelInfo[];
  private readonly activeRequests = new Set<AbortController>();
  private disposed = false;

  constructor(config: LLMProviderConfig, instanceId: string) {
    const resolved = validateAnthropicCompatibleConfig(config);
    const savedModels = buildAnthropicCompatibleModels(config);
    super(config.apiKey, savedModels[0]?.id ?? '', resolved.baseUrl, false);
    this.name = instanceId;
    this.baseUrl = resolved.baseUrl;
    this.savedModels = savedModels;
    const thinkingOverrides: Record<string, ResolvedCompatibleModelThinking> = {};
    for (const [id, definition] of Object.entries(config.anthropicCompatible?.models ?? {})) {
      const resolvedThinking = resolveDefinitionThinking(definition);
      if (resolvedThinking.source !== 'default') {
        thinkingOverrides[id] = resolvedThinking;
      }
    }
    this.delegate = new AnthropicAdapter(config.apiKey, savedModels[0]?.id, {
      instanceName: instanceId,
      baseUrl: resolved.baseUrl,
      messagesUrl: resolved.messagesUrl,
      authMode: config.anthropicCompatible?.authMode ?? 'x-api-key',
      customModels: savedModels,
      thinkingOverrides,
    });
  }

  override generate(prompt: string, options?: GenerateOptions): Promise<LLMResponse> {
    return this.generateUncached(prompt, options);
  }

  private resolveTargetModel(options?: GenerateOptions): string {
    const model = options?.model || this.currentModel;
    if (!isOpenAICompatibleModelId(model)) {
      throw new LLMProviderError(
        'Select a model configured on this Anthropic-compatible endpoint before sending a message.',
        this.name,
        'CONFIGURATION_ERROR',
      );
    }
    return model;
  }

  private requestScope(signal?: AbortSignal): { signal: AbortSignal; cleanup: () => void } {
    if (this.disposed) {
      throw new LLMProviderError('This endpoint was closed while the request was starting.', this.name, 'ABORTED');
    }
    const controller = new AbortController();
    this.activeRequests.add(controller);
    const abort = () => controller.abort();
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener('abort', abort, { once: true });
    return {
      signal: controller.signal,
      cleanup: () => {
        signal?.removeEventListener('abort', abort);
        this.activeRequests.delete(controller);
      },
    };
  }

  async generateUncached(prompt: string, options?: GenerateOptions): Promise<LLMResponse> {
    const model = this.resolveTargetModel(options);
    const scope = this.requestScope(options?.abortSignal);
    try {
      return await this.delegate.generateUncached(prompt, {
        ...options,
        model,
        abortSignal: scope.signal,
      });
    } finally {
      scope.cleanup();
    }
  }

  async* generateStreamAsync(prompt: string, options?: GenerateOptions): AsyncGenerator<StreamChunk, void, unknown> {
    const model = this.resolveTargetModel(options);
    const scope = this.requestScope(options?.abortSignal);
    try {
      yield* this.delegate.generateStreamAsync(prompt, {
        ...options,
        model,
        abortSignal: scope.signal,
      });
    } finally {
      scope.cleanup();
    }
  }

  listModels(): Promise<ModelInfo[]> {
    return Promise.resolve(this.savedModels.map(model => ({ ...model })));
  }

  override isAvailable(): Promise<boolean> {
    return Promise.resolve(!this.disposed && this.savedModels.length > 0);
  }

  getCapabilities(): ProviderCapabilities {
    const maxContextWindow = this.savedModels.reduce(
      (max, model) => Math.max(max, model.contextWindow),
      ANTHROPIC_COMPATIBLE_CONTEXT_WINDOW,
    );
    return {
      supportsStreaming: true,
      streamingMode: 'streaming',
      supportsJSON: true,
      supportsImages: true,
      supportsFunctions: true,
      supportsThinking: true,
      maxContextWindow,
      supportedFeatures: ['messages', 'extended_thinking', 'function_calling', 'vision', 'streaming'],
    };
  }

  getModelPricing(_modelId: string): Promise<ModelPricing | null> {
    return Promise.resolve(null);
  }

  override async clearCache(): Promise<void> {
    await this.delegate.clearCache();
  }

  dispose(): void {
    this.disposed = true;
    for (const controller of this.activeRequests) controller.abort();
    this.activeRequests.clear();
  }
}
