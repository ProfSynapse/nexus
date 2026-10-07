import type { LLMProviderConfig } from '../../types/llm/ProviderTypes';
import {
  discoverOpenAICompatibleModels,
  isOpenAICompatibleModelId,
  normalizeOpenAICompatibleBaseUrl,
} from '../../services/llm/adapters/openai-compatible/OpenAICompatibleConfig';

export type CompatibleEndpointConfig = LLMProviderConfig & {
  driverKind: 'openai-compatible';
  openaiCompatible: {
    schemaVersion: 1;
    displayName: string;
    baseUrl: string;
    models: Record<string, { source: 'discovered' | 'manual' }>;
  };
};

export function copyEndpoint(config: CompatibleEndpointConfig): CompatibleEndpointConfig {
  return {
    ...config,
    models: Object.fromEntries(Object.entries(config.models ?? {}).map(([id, model]) => [id, { ...model }])),
    openaiCompatible: {
      ...config.openaiCompatible,
      models: Object.fromEntries(Object.entries(config.openaiCompatible.models).map(([id, model]) => [id, { ...model }])),
    },
  };
}

export function isCompatibleEndpoint(config: LLMProviderConfig): config is CompatibleEndpointConfig {
  return config.driverKind === 'openai-compatible' && config.openaiCompatible?.schemaVersion === 1;
}

/** Owns one editor draft; async discovery can never overwrite newer credentials. */
export class OpenAICompatibleEditSession {
  readonly draft: CompatibleEndpointConfig;
  private revision = 0;
  private closed = false;
  private saveQueue: Promise<void> = Promise.resolve();

  constructor(
    readonly id: string,
    config: CompatibleEndpointConfig,
    private readonly persist: (id: string, config: CompatibleEndpointConfig) => Promise<void>,
    private readonly discover = discoverOpenAICompatibleModels,
  ) {
    this.draft = copyEndpoint(config);
  }

  setName(value: string): void {
    this.draft.openaiCompatible.displayName = value;
  }

  setBaseUrl(value: string): void {
    if (value === this.draft.openaiCompatible.baseUrl) return;
    this.revision++;
    // Keep user selections through intermediate keystrokes and address fixes.
    // Discovery is invalidated, but editing an address never deletes models.
    this.draft.openaiCompatible.baseUrl = value;
  }

  setApiKey(value: string): void {
    this.revision++;
    this.draft.apiKey = value;
  }

  setModelEnabled(id: string, enabled: boolean): void {
    this.draft.models = { ...this.draft.models, [id]: { ...this.draft.models?.[id], enabled } };
  }

  validationError(): string | null {
    if (!this.draft.openaiCompatible.displayName.trim()) return 'Enter a name for this endpoint.';
    try {
      normalizeOpenAICompatibleBaseUrl(this.draft.openaiCompatible.baseUrl);
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : 'Enter a valid API base URL.';
    }
  }

  async save(): Promise<void> {
    const error = this.validationError();
    if (error) throw new Error(error);
    const snapshot = copyEndpoint(this.draft);
    snapshot.openaiCompatible.displayName = snapshot.openaiCompatible.displayName.trim();
    snapshot.openaiCompatible.baseUrl = normalizeOpenAICompatibleBaseUrl(snapshot.openaiCompatible.baseUrl);
    const pending = this.saveQueue.catch(() => undefined).then(() => this.persist(this.id, snapshot));
    this.saveQueue = pending;
    return pending;
  }

  addModel(value: string): void {
    const id = value.trim();
    if (!isOpenAICompatibleModelId(id)) throw new Error('Enter the model ID expected by your server, without control characters.');
    if (Object.prototype.hasOwnProperty.call(this.draft.openaiCompatible.models, id)) throw new Error('This model is already in the list.');
    const error = this.validationError();
    if (error) throw new Error(error);
    this.draft.openaiCompatible.models = { ...this.draft.openaiCompatible.models, [id]: { source: 'manual' } };
    this.setModelEnabled(id, true);
    this.draft.enabled = true;
  }

  async connect(): Promise<'connected' | 'empty' | 'stale'> {
    const error = this.validationError();
    if (error) throw new Error(error);
    const revision = ++this.revision;
    const baseUrl = normalizeOpenAICompatibleBaseUrl(this.draft.openaiCompatible.baseUrl);
    const key = this.draft.apiKey;
    try {
      const ids = await this.discover(baseUrl, key);
      if (this.closed || revision !== this.revision) return 'stale';
      for (const id of new Set(ids)) {
        if (!Object.prototype.hasOwnProperty.call(this.draft.openaiCompatible.models, id)) {
          this.draft.openaiCompatible.models = { ...this.draft.openaiCompatible.models, [id]: { source: 'discovered' } };
          this.setModelEnabled(id, true);
        }
      }
      if (ids.length > 0) this.draft.enabled = true;
      await this.save();
      return this.closed || revision !== this.revision ? 'stale' : ids.length ? 'connected' : 'empty';
    } catch (error) {
      if (this.closed || revision !== this.revision) return 'stale';
      throw error;
    }
  }

  close(): void {
    this.closed = true;
    this.revision++;
  }
}
