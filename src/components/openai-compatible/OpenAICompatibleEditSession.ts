import type { LLMProviderConfig, OpenAICompatibleModelDefinition } from '../../types/llm/ProviderTypes';
import {
  discoverOpenAICompatibleModels,
  isOpenAICompatibleContextWindow,
  isOpenAICompatibleModelId,
  normalizeOpenAICompatibleBaseUrl,
  OPENAI_COMPATIBLE_MAX_CONTEXT_WINDOW,
  OPENAI_COMPATIBLE_MIN_CONTEXT_WINDOW,
  probeOpenAICompatibleModelThinking,
  resolveOpenAICompatibleContextWindow,
} from '../../services/llm/adapters/openai-compatible/OpenAICompatibleConfig';
import {
  checkOpenAICompatibleContextWindow,
  type OpenAICompatibleContextCheckResult,
} from '../../services/llm/adapters/openai-compatible/OpenAICompatibleContextCheck';
import { normalizeThinkingEffortList } from '../../services/llm/adapters/shared/CompatibleEndpointUtils';
import type { CompatibleThinkingProbeResult } from '../../services/llm/adapters/shared/CompatibleThinkingProbe';

function cloneModelDefinition(definition: OpenAICompatibleModelDefinition): OpenAICompatibleModelDefinition {
  return {
    ...definition,
    ...(definition.reportedThinkingEfforts ? { reportedThinkingEfforts: [...definition.reportedThinkingEfforts] } : {}),
    ...(definition.probedThinkingEfforts ? { probedThinkingEfforts: [...definition.probedThinkingEfforts] } : {}),
  };
}
export type CompatibleEndpointConfig = LLMProviderConfig & {
  driverKind: 'openai-compatible';
  openaiCompatible: {
    schemaVersion: 1;
    displayName: string;
    baseUrl: string;
    models: Record<string, OpenAICompatibleModelDefinition>;
  };
};

export function copyEndpoint(config: CompatibleEndpointConfig): CompatibleEndpointConfig {
  return {
    ...config,
    models: Object.fromEntries(Object.entries(config.models ?? {}).map(([id, model]) => [id, { ...model }])),
    openaiCompatible: {
      ...config.openaiCompatible,
      models: Object.fromEntries(Object.entries(config.openaiCompatible.models).map(([id, model]) => [id, cloneModelDefinition(model)])),
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
    private readonly check = checkOpenAICompatibleContextWindow,
    private readonly probe = probeOpenAICompatibleModelThinking,
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

  /** Undefined clears the user's value, so the server's report or the default applies again. */
  setContextWindow(id: string, value: number | undefined): void {
    const definition = this.draft.openaiCompatible.models[id];
    if (!definition) throw new Error('This model is not in the list.');
    if (value !== undefined && !isOpenAICompatibleContextWindow(value)) {
      throw new Error(`Enter a whole number of tokens from ${OPENAI_COMPATIBLE_MIN_CONTEXT_WINDOW.toLocaleString()} to ${OPENAI_COMPATIBLE_MAX_CONTEXT_WINDOW.toLocaleString()}.`);
    }
    const next = cloneModelDefinition(definition);
    if (value === undefined) delete next.contextWindow;
    else next.contextWindow = value;
    this.draft.openaiCompatible.models = { ...this.draft.openaiCompatible.models, [id]: next };
  }

  /**
   * Adopts a size a check revealed. When the server reports that same size,
   * the user's value is cleared so the model follows the server's report
   * instead of pinning a copy that would outlive a later server change.
   * Returns the value the field should show ('' when following the server).
   */
  useContextWindow(id: string, value: number): string {
    const followsServer = this.draft.openaiCompatible.models[id]?.reportedContextWindow === value;
    this.setContextWindow(id, followsServer ? undefined : value);
    return followsServer ? '' : String(value);
  }

  /** Sends one prompt of the model's current context size; the caller saves nothing on its behalf. */
  async checkContextWindow(id: string, signal?: AbortSignal): Promise<OpenAICompatibleContextCheckResult> {
    const error = this.validationError();
    if (error) throw new Error(error);
    const definition = this.draft.openaiCompatible.models[id];
    if (!definition) throw new Error('This model is not in the list.');
    return this.check({
      baseUrl: this.draft.openaiCompatible.baseUrl, apiKey: this.draft.apiKey, model: id,
      contextWindow: resolveOpenAICompatibleContextWindow(definition).contextWindow, signal,
    });
  }

  /** Sends minimal probe requests to detect which thinking effort tiers this model accepts. */
  async probeThinking(id: string, signal?: AbortSignal): Promise<CompatibleThinkingProbeResult> {
    const error = this.validationError();
    if (error) throw new Error(error);
    const definition = this.draft.openaiCompatible.models[id];
    if (!definition) throw new Error('This model is not in the list.');
    const revision = this.revision;
    const result = await this.probe({
      baseUrl: this.draft.openaiCompatible.baseUrl,
      apiKey: this.draft.apiKey,
      model: id,
      signal,
    });
    if (this.closed || revision !== this.revision) {
      return { kind: 'failed', message: 'Connection changed before the thinking probe finished.' };
    }
    if (signal?.aborted) return result;
    const current = this.draft.openaiCompatible.models[id];
    if (!current) return result;
    if (result.kind === 'supported') {
      const next = cloneModelDefinition(current);
      next.probedSupportsThinking = true;
      next.probedThinkingEfforts = [...result.efforts];
      next.probedThinkingMode = result.mode;
      this.draft.openaiCompatible.models = { ...this.draft.openaiCompatible.models, [id]: next };
    } else if (result.kind === 'unsupported') {
      const next = cloneModelDefinition(current);
      next.probedSupportsThinking = false;
      delete next.probedThinkingEfforts;
      delete next.probedThinkingMode;
      this.draft.openaiCompatible.models = { ...this.draft.openaiCompatible.models, [id]: next };
    }
    return result;
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
      const discovered = await this.discover(baseUrl, key);
      if (this.closed || revision !== this.revision) return 'stale';
      for (const { id, contextWindow, supportsThinking, thinkingEfforts } of discovered) {
        const existing = Object.prototype.hasOwnProperty.call(this.draft.openaiCompatible.models, id)
          ? this.draft.openaiCompatible.models[id] : undefined;
        // The report is refreshed on every Connect; user and probed values are preserved.
        const next = existing ? cloneModelDefinition(existing) : { source: 'discovered' as const };
        if (contextWindow === undefined) delete next.reportedContextWindow;
        else next.reportedContextWindow = contextWindow;
        if (supportsThinking === undefined) delete next.reportedSupportsThinking;
        else next.reportedSupportsThinking = supportsThinking;
        const normalizedEfforts = normalizeThinkingEffortList(thinkingEfforts);
        if (normalizedEfforts === undefined) delete next.reportedThinkingEfforts;
        else next.reportedThinkingEfforts = [...normalizedEfforts];
        this.draft.openaiCompatible.models = { ...this.draft.openaiCompatible.models, [id]: next };
        if (!existing) this.setModelEnabled(id, true);
      }
      if (discovered.length > 0) this.draft.enabled = true;
      await this.save();
      return this.closed || revision !== this.revision ? 'stale' : discovered.length ? 'connected' : 'empty';
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
