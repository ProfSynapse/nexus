import type { AntigravityCompatibleWireProtocol, LLMProviderConfig } from '../../../../types/llm/ProviderTypes';
import { AnthropicAdapter } from '../anthropic/AnthropicAdapter';
import { BaseAdapter } from '../BaseAdapter';
import { GoogleAdapter } from '../google/GoogleAdapter';
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
  resolveAntigravityModelWire,
  resolveDefinitionThinking,
  type ResolvedCompatibleModelThinking,
} from '../shared/CompatibleEndpointUtils';
import {
  ANTIGRAVITY_COMPATIBLE_CONTEXT_WINDOW,
  buildAntigravityCompatibleModels,
  toAnthropicAuthMode,
  validateAntigravityCompatibleConfig,
} from './AntigravityCompatibleConfig';

/**
 * Third-party Antigravity gateway adapter supporting both Gemini `v1beta`
 * (`/v1beta` or `/antigravity/v1beta`) and Anthropic `messages`
 * (`/v1/messages` or `/antigravity/v1/messages`) routes.
 */
export class AntigravityCompatibleAdapter extends BaseAdapter {
  readonly name: string;
  readonly baseUrl: string;
  private readonly wireProtocol: AntigravityCompatibleWireProtocol;
  private readonly googleDelegate: GoogleAdapter;
  private readonly anthropicDelegate: AnthropicAdapter;
  private readonly savedModels: ModelInfo[];
  private readonly activeRequests = new Set<AbortController>();
  private disposed = false;

  constructor(config: LLMProviderConfig, instanceId: string) {
    const resolved = validateAntigravityCompatibleConfig(config);
    const savedModels = buildAntigravityCompatibleModels(config);
    super(config.apiKey, savedModels[0]?.id ?? '', resolved.baseUrl, false);
    this.name = instanceId;
    this.baseUrl = resolved.baseUrl;
    this.wireProtocol = config.antigravityCompatible?.wireProtocol ?? 'auto';
    this.savedModels = savedModels;

    const authMode = config.antigravityCompatible?.authMode ?? 'both';
    const thinkingOverrides: Record<string, ResolvedCompatibleModelThinking> = {};
    for (const [id, definition] of Object.entries(config.antigravityCompatible?.models ?? {})) {
      const resolvedThinking = resolveDefinitionThinking(definition);
      if (resolvedThinking.source !== 'default') {
        thinkingOverrides[id] = resolvedThinking;
      }
    }
    this.googleDelegate = new GoogleAdapter(config.apiKey, savedModels[0]?.id, {
      instanceName: instanceId,
      baseUrl: resolved.v1betaBaseUrl,
      authMode,
      customModels: savedModels,
      thinkingOverrides,
    });
    this.anthropicDelegate = new AnthropicAdapter(config.apiKey, savedModels[0]?.id, {
      instanceName: instanceId,
      baseUrl: resolved.gatewayRootUrl,
      messagesUrl: resolved.messagesUrl,
      authMode: toAnthropicAuthMode(authMode),
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
        'Select a model configured on this Antigravity-compatible endpoint before sending a message.',
        this.name,
        'CONFIGURATION_ERROR',
      );
    }
    return model;
  }

  private selectDelegate(model: string): BaseAdapter {
    const wire = resolveAntigravityModelWire(model, this.wireProtocol);
    return wire === 'anthropic' ? this.anthropicDelegate : this.googleDelegate;
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
    const delegate = this.selectDelegate(model);
    const scope = this.requestScope(options?.abortSignal);
    try {
      return await delegate.generateUncached(prompt, {
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
    const delegate = this.selectDelegate(model);
    const scope = this.requestScope(options?.abortSignal);
    try {
      yield* delegate.generateStreamAsync(prompt, {
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
      ANTIGRAVITY_COMPATIBLE_CONTEXT_WINDOW,
    );
    return {
      supportsStreaming: true,
      streamingMode: 'streaming',
      supportsJSON: true,
      supportsImages: true,
      supportsFunctions: true,
      supportsThinking: true,
      maxContextWindow,
      supportedFeatures: [
        'messages',
        'extended_thinking',
        'function_calling',
        'vision',
        'streaming',
        'json_mode',
        'thinking_mode',
      ],
    };
  }

  getModelPricing(_modelId: string): Promise<ModelPricing | null> {
    return Promise.resolve(null);
  }

  override async clearCache(): Promise<void> {
    await Promise.all([
      this.googleDelegate.clearCache(),
      this.anthropicDelegate.clearCache(),
    ]);
  }

  dispose(): void {
    this.disposed = true;
    for (const controller of this.activeRequests) controller.abort();
    this.activeRequests.clear();
  }
}
