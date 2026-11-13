import type {
  AnthropicCompatibleAuthMode,
  AntigravityCompatibleAuthMode,
  AntigravityCompatibleWireProtocol,
  LLMProviderConfig,
  OpenAICompatibleModelDefinition,
  ResponsesCompatibleAuthMode,
  ResponsesCompatibleStateMode,
} from '../../types/llm/ProviderTypes';
import { isOpenAICompatibleContextWindow, isOpenAICompatibleModelId, OPENAI_COMPATIBLE_MAX_CONTEXT_WINDOW, OPENAI_COMPATIBLE_MIN_CONTEXT_WINDOW } from '../../services/llm/adapters/openai-compatible/OpenAICompatibleConfig';
import type { OpenAICompatibleContextCheckResult } from '../../services/llm/adapters/openai-compatible/OpenAICompatibleContextCheck';
import { checkAnthropicCompatibleContextWindow, discoverAnthropicCompatibleModels, normalizeAnthropicCompatibleBaseUrl, probeAnthropicCompatibleModelThinking, resolveAnthropicCompatibleContextWindow, validateAnthropicCompatibleConfig } from '../../services/llm/adapters/anthropic-compatible/AnthropicCompatibleConfig';
import { checkAntigravityCompatibleContextWindow, discoverAntigravityCompatibleModels, normalizeAntigravityCompatibleBaseUrl, probeAntigravityCompatibleModelThinking, resolveAntigravityCompatibleContextWindow, validateAntigravityCompatibleConfig } from '../../services/llm/adapters/antigravity-compatible/AntigravityCompatibleConfig';
import { checkResponsesCompatibleContextWindow, discoverResponsesCompatibleModels, normalizeResponsesCompatibleBaseUrl, probeResponsesCompatibleModelThinking, resolveResponsesCompatibleContextWindow, validateResponsesCompatibleConfig } from '../../services/llm/adapters/responses-compatible/ResponsesCompatibleConfig';
import { normalizeThinkingEffortList } from '../../services/llm/adapters/shared/CompatibleEndpointUtils';
import type { CompatibleThinkingProbeResult } from '../../services/llm/adapters/shared/CompatibleThinkingProbe';

function cloneModelDefinition(definition: OpenAICompatibleModelDefinition): OpenAICompatibleModelDefinition {
  return {
    ...definition,
    ...(definition.reportedThinkingEfforts ? { reportedThinkingEfforts: [...definition.reportedThinkingEfforts] } : {}),
    ...(definition.probedThinkingEfforts ? { probedThinkingEfforts: [...definition.probedThinkingEfforts] } : {}),
  };
}
export type CustomCompatibleKind = 'responses-compatible' | 'anthropic-compatible' | 'antigravity-compatible';
export type CustomCompatibleEndpointConfig = LLMProviderConfig & (
  | { driverKind: 'responses-compatible'; responsesCompatible: NonNullable<LLMProviderConfig['responsesCompatible']> }
  | { driverKind: 'anthropic-compatible'; anthropicCompatible: NonNullable<LLMProviderConfig['anthropicCompatible']> }
  | { driverKind: 'antigravity-compatible'; antigravityCompatible: NonNullable<LLMProviderConfig['antigravityCompatible']> }
);

export function isCustomEndpoint(config: LLMProviderConfig, kind: CustomCompatibleKind): config is CustomCompatibleEndpointConfig {
  switch (kind) {
    case 'responses-compatible':
      return config.driverKind === kind && config.responsesCompatible?.schemaVersion === 1;
    case 'anthropic-compatible':
      return config.driverKind === kind && config.anthropicCompatible?.schemaVersion === 1;
    case 'antigravity-compatible':
      return config.driverKind === kind && config.antigravityCompatible?.schemaVersion === 1;
  }
}

export function copyCustomEndpoint(config: CustomCompatibleEndpointConfig): CustomCompatibleEndpointConfig {
  const models = Object.fromEntries(Object.entries(config.models ?? {}).map(([id, model]) => [id, { ...model }]));
  if (config.driverKind === 'responses-compatible') {
    const endpoint = config.responsesCompatible;
    return { ...config, models, responsesCompatible: { ...endpoint, models: Object.fromEntries(Object.entries(endpoint.models).map(([id, model]) => [id, cloneModelDefinition(model)])) } };
  }
  if (config.driverKind === 'anthropic-compatible') {
    const endpoint = config.anthropicCompatible;
    return { ...config, models, anthropicCompatible: { ...endpoint, models: Object.fromEntries(Object.entries(endpoint.models).map(([id, model]) => [id, cloneModelDefinition(model)])) } };
  }
  const endpoint = config.antigravityCompatible;
  return { ...config, models, antigravityCompatible: { ...endpoint, models: Object.fromEntries(Object.entries(endpoint.models).map(([id, model]) => [id, cloneModelDefinition(model)])) } };
}

export class CustomCompatibleEditSession {
  readonly draft: CustomCompatibleEndpointConfig;
  private revision = 0;
  private closed = false;
  private saveQueue: Promise<void> = Promise.resolve();

  constructor(readonly id: string, config: CustomCompatibleEndpointConfig, private readonly persist: (id: string, config: CustomCompatibleEndpointConfig) => Promise<void>) {
    this.draft = copyCustomEndpoint(config);
  }

  get endpoint() {
    switch (this.draft.driverKind) {
      case 'responses-compatible':
        return this.draft.responsesCompatible;
      case 'anthropic-compatible':
        return this.draft.anthropicCompatible;
      case 'antigravity-compatible':
        return this.draft.antigravityCompatible;
    }
  }

  setName(value: string): void { this.endpoint.displayName = value; }
  setBaseUrl(value: string): void {
    if (value === this.endpoint.baseUrl) return;
    this.revision++;
    this.endpoint.baseUrl = value;
  }
  setApiKey(value: string): void { this.revision++; this.draft.apiKey = value; }
  setResponsesStateMode(value: ResponsesCompatibleStateMode): void {
    if (this.draft.driverKind !== 'responses-compatible') return;
    this.revision++;
    this.draft.responsesCompatible.stateMode = value;
  }
  setResponsesAuthMode(value: ResponsesCompatibleAuthMode): void {
    if (this.draft.driverKind !== 'responses-compatible') return;
    this.revision++;
    this.draft.responsesCompatible.authMode = value;
  }
  setAnthropicAuthMode(value: AnthropicCompatibleAuthMode): void {
    if (this.draft.driverKind !== 'anthropic-compatible') return;
    this.revision++;
    this.draft.anthropicCompatible.authMode = value;
  }
  setAntigravityWireProtocol(value: AntigravityCompatibleWireProtocol): void {
    if (this.draft.driverKind !== 'antigravity-compatible') return;
    this.revision++;
    this.draft.antigravityCompatible.wireProtocol = value;
  }
  setAntigravityAuthMode(value: AntigravityCompatibleAuthMode): void {
    if (this.draft.driverKind !== 'antigravity-compatible') return;
    this.revision++;
    this.draft.antigravityCompatible.authMode = value;
  }
  setModelEnabled(id: string, enabled: boolean): void {
    this.draft.models = { ...this.draft.models, [id]: { ...this.draft.models?.[id], enabled } };
  }
  setContextWindow(id: string, value: number | undefined): void {
    const definition = this.endpoint.models[id];
    if (!definition) throw new Error('This model is not in the list.');
    if (value !== undefined && !isOpenAICompatibleContextWindow(value)) {
      throw new Error(`Enter a whole number of tokens from ${OPENAI_COMPATIBLE_MIN_CONTEXT_WINDOW.toLocaleString()} to ${OPENAI_COMPATIBLE_MAX_CONTEXT_WINDOW.toLocaleString()}.`);
    }
    const next = cloneModelDefinition(definition);
    if (value === undefined) delete next.contextWindow;
    else next.contextWindow = value;
    this.endpoint.models = { ...this.endpoint.models, [id]: next };
  }
  useContextWindow(id: string, value: number): string {
    const followsServer = this.endpoint.models[id]?.reportedContextWindow === value;
    this.setContextWindow(id, followsServer ? undefined : value);
    return followsServer ? '' : String(value);
  }
  resolveContextWindow(id: string, ignoreUser = false) {
    const definition = this.endpoint.models[id];
    const effective = ignoreUser && definition ? { ...definition, contextWindow: undefined } : definition;
    switch (this.draft.driverKind) {
      case 'responses-compatible':
        return resolveResponsesCompatibleContextWindow(effective, id);
      case 'anthropic-compatible':
        return resolveAnthropicCompatibleContextWindow(effective, id);
      case 'antigravity-compatible':
        return resolveAntigravityCompatibleContextWindow(effective, id);
    }
  }
  async checkContextWindow(id: string, signal?: AbortSignal): Promise<OpenAICompatibleContextCheckResult> {
    const error = this.validationError();
    if (error) throw new Error(error);
    if (!this.endpoint.models[id]) throw new Error('This model is not in the list.');
    const request = { baseUrl: this.endpoint.baseUrl, apiKey: this.draft.apiKey, model: id, contextWindow: this.resolveContextWindow(id).contextWindow, signal };
    switch (this.draft.driverKind) {
      case 'responses-compatible':
        return checkResponsesCompatibleContextWindow({
          ...request,
          stateMode: this.draft.responsesCompatible.stateMode,
          authMode: this.draft.responsesCompatible.authMode,
        });
      case 'anthropic-compatible':
        return checkAnthropicCompatibleContextWindow({ ...request, authMode: this.draft.anthropicCompatible.authMode });
      case 'antigravity-compatible':
        return checkAntigravityCompatibleContextWindow({ ...request, authMode: this.draft.antigravityCompatible.authMode, wireProtocol: this.draft.antigravityCompatible.wireProtocol });
    }
  }
  async probeThinking(id: string, signal?: AbortSignal): Promise<CompatibleThinkingProbeResult> {
    const error = this.validationError();
    if (error) throw new Error(error);
    if (!this.endpoint.models[id]) throw new Error('This model is not in the list.');
    const revision = this.revision;
    let result: CompatibleThinkingProbeResult;
    switch (this.draft.driverKind) {
      case 'responses-compatible':
        result = await probeResponsesCompatibleModelThinking({
          baseUrl: this.draft.responsesCompatible.baseUrl,
          apiKey: this.draft.apiKey,
          stateMode: this.draft.responsesCompatible.stateMode,
          authMode: this.draft.responsesCompatible.authMode,
          model: id,
          signal,
        });
        break;
      case 'anthropic-compatible':
        result = await probeAnthropicCompatibleModelThinking({
          baseUrl: this.draft.anthropicCompatible.baseUrl,
          apiKey: this.draft.apiKey,
          authMode: this.draft.anthropicCompatible.authMode,
          model: id,
          signal,
        });
        break;
      case 'antigravity-compatible':
        result = await probeAntigravityCompatibleModelThinking({
          baseUrl: this.draft.antigravityCompatible.baseUrl,
          apiKey: this.draft.apiKey,
          wireProtocol: this.draft.antigravityCompatible.wireProtocol,
          authMode: this.draft.antigravityCompatible.authMode,
          model: id,
          signal,
        });
        break;
    }
    if (this.closed || revision !== this.revision) {
      return { kind: 'failed', message: 'Connection changed before the thinking probe finished.' };
    }
    if (signal?.aborted) return result;
    const current = this.endpoint.models[id];
    if (!current) return result;
    if (result.kind === 'supported') {
      const next = cloneModelDefinition(current);
      next.probedSupportsThinking = true;
      next.probedThinkingEfforts = [...result.efforts];
      next.probedThinkingMode = result.mode;
      this.endpoint.models = { ...this.endpoint.models, [id]: next };
    } else if (result.kind === 'unsupported') {
      const next = cloneModelDefinition(current);
      next.probedSupportsThinking = false;
      delete next.probedThinkingEfforts;
      delete next.probedThinkingMode;
      this.endpoint.models = { ...this.endpoint.models, [id]: next };
    }
    return result;
  }
  validationError(): string | null {
    if (!this.endpoint.displayName.trim()) return 'Enter a name for this endpoint.';
    try {
      switch (this.draft.driverKind) {
        case 'responses-compatible':
          validateResponsesCompatibleConfig(this.draft);
          break;
        case 'anthropic-compatible':
          validateAnthropicCompatibleConfig(this.draft);
          break;
        case 'antigravity-compatible':
          validateAntigravityCompatibleConfig(this.draft);
          break;
      }
      return null;
    } catch (error) { return error instanceof Error ? error.message : 'Enter a valid API base URL.'; }
  }
  async save(): Promise<void> {
    const error = this.validationError();
    if (error) throw new Error(error);
    const snapshot = copyCustomEndpoint(this.draft);
    switch (snapshot.driverKind) {
      case 'responses-compatible':
        snapshot.responsesCompatible.displayName = snapshot.responsesCompatible.displayName.trim();
        snapshot.responsesCompatible.baseUrl = normalizeResponsesCompatibleBaseUrl(snapshot.responsesCompatible.baseUrl);
        break;
      case 'anthropic-compatible':
        snapshot.anthropicCompatible.displayName = snapshot.anthropicCompatible.displayName.trim();
        snapshot.anthropicCompatible.baseUrl = normalizeAnthropicCompatibleBaseUrl(snapshot.anthropicCompatible.baseUrl);
        break;
      case 'antigravity-compatible':
        snapshot.antigravityCompatible.displayName = snapshot.antigravityCompatible.displayName.trim();
        snapshot.antigravityCompatible.baseUrl = normalizeAntigravityCompatibleBaseUrl(snapshot.antigravityCompatible.baseUrl);
        break;
    }
    const pending = this.saveQueue.catch(() => undefined).then(() => this.persist(this.id, snapshot));
    this.saveQueue = pending;
    return pending;
  }
  addModel(value: string): void {
    const id = value.trim();
    if (!isOpenAICompatibleModelId(id)) throw new Error('Enter the model ID expected by your server, without control characters.');
    if (Object.prototype.hasOwnProperty.call(this.endpoint.models, id)) throw new Error('This model is already in the list.');
    const error = this.validationError();
    if (error) throw new Error(error);
    this.endpoint.models = { ...this.endpoint.models, [id]: { source: 'manual' } };
    this.setModelEnabled(id, true);
    this.draft.enabled = true;
  }
  async connect(): Promise<'connected' | 'empty' | 'stale'> {
    const error = this.validationError();
    if (error) throw new Error(error);
    const revision = ++this.revision;
    const config = this.draft;
    try {
      const discovered = config.driverKind === 'responses-compatible'
        ? await discoverResponsesCompatibleModels(normalizeResponsesCompatibleBaseUrl(config.responsesCompatible.baseUrl), config.apiKey, config.responsesCompatible.authMode)
        : config.driverKind === 'anthropic-compatible'
          ? await discoverAnthropicCompatibleModels(normalizeAnthropicCompatibleBaseUrl(config.anthropicCompatible.baseUrl), config.apiKey, config.anthropicCompatible.authMode)
          : await discoverAntigravityCompatibleModels(normalizeAntigravityCompatibleBaseUrl(config.antigravityCompatible.baseUrl), config.apiKey, config.antigravityCompatible.wireProtocol, config.antigravityCompatible.authMode);
      if (this.closed || revision !== this.revision) return 'stale';
      for (const { id, contextWindow, supportsThinking, thinkingEfforts } of discovered) {
        const existing = Object.prototype.hasOwnProperty.call(this.endpoint.models, id) ? this.endpoint.models[id] : undefined;
        const next = existing ? cloneModelDefinition(existing) : { source: 'discovered' as const };
        if (contextWindow === undefined) delete next.reportedContextWindow;
        else next.reportedContextWindow = contextWindow;
        if (supportsThinking === undefined) delete next.reportedSupportsThinking;
        else next.reportedSupportsThinking = supportsThinking;
        const normalizedEfforts = normalizeThinkingEffortList(thinkingEfforts);
        if (normalizedEfforts === undefined) delete next.reportedThinkingEfforts;
        else next.reportedThinkingEfforts = [...normalizedEfforts];
        this.endpoint.models = { ...this.endpoint.models, [id]: next };
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
  close(): void { this.closed = true; this.revision++; }
}
