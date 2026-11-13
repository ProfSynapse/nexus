import type {
  AntigravityCompatibleWireProtocol,
  CompatibleDriverKind,
  CompatibleThinkingMode,
  LLMProviderConfig,
  OpenAICompatibleModelDefinition,
  ResponsesCompatibleStateMode,
  ThinkingEffort,
} from '../../../../types/llm/ProviderTypes';

export type ProviderWireFamily = 'anthropic' | 'google' | 'responses' | 'openai-compatible';

export const CANONICAL_THINKING_EFFORTS: readonly ThinkingEffort[] = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
];

export interface ResolvedCompatibleModelThinking {
  supportsThinking?: boolean;
  efforts?: ThinkingEffort[];
  mode?: CompatibleThinkingMode;
  source: 'probed' | 'server' | 'default';
}

const antigravityWireModes = new Map<string, AntigravityCompatibleWireProtocol>();
const responsesStateModes = new Map<string, ResponsesCompatibleStateMode>();
const compatibleModelThinkingMap = new Map<string, ResolvedCompatibleModelThinking>();

function modelThinkingKey(providerId: string, modelId: string): string {
  return `${providerId}\u0000${modelId}`;
}

export function normalizeThinkingEffortList(raw: unknown): ThinkingEffort[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const found = new Set<ThinkingEffort>();
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const token = item.trim().toLowerCase();
    if (token === 'low' || token === 'minimal' || token === 'extra-low' || token === 'extra_low') {
      found.add('low');
    } else if (token === 'medium' || token === 'med') {
      found.add('medium');
    } else if (token === 'high') {
      found.add('high');
    } else if (token === 'xhigh' || token === 'extra-high' || token === 'extra_high') {
      found.add('xhigh');
    } else if (token === 'max' || token === 'maximum') {
      found.add('max');
    }
  }
  const ordered = CANONICAL_THINKING_EFFORTS.filter(level => found.has(level));
  return ordered.length > 0 ? ordered : undefined;
}

export function clampEffortToSupportedTiers(
  effort: ThinkingEffort,
  supported?: readonly ThinkingEffort[],
): ThinkingEffort {
  if (!supported || supported.length === 0) return effort;
  if (supported.includes(effort)) return effort;
  const targetIdx = CANONICAL_THINKING_EFFORTS.indexOf(effort);
  for (let i = targetIdx - 1; i >= 0; i--) {
    const candidate = CANONICAL_THINKING_EFFORTS[i];
    if (supported.includes(candidate)) return candidate;
  }
  for (let i = targetIdx + 1; i < CANONICAL_THINKING_EFFORTS.length; i++) {
    const candidate = CANONICAL_THINKING_EFFORTS[i];
    if (supported.includes(candidate)) return candidate;
  }
  return supported[0];
}

export function resolveDefinitionThinking(
  definition: OpenAICompatibleModelDefinition | undefined,
): ResolvedCompatibleModelThinking {
  if (!definition) return { source: 'default' };
  if (definition.probedSupportsThinking !== undefined) {
    if (!definition.probedSupportsThinking) {
      return { supportsThinking: false, efforts: [], mode: definition.probedThinkingMode, source: 'probed' };
    }
    const efforts = normalizeThinkingEffortList(definition.probedThinkingEfforts);
    return {
      supportsThinking: true,
      ...(efforts ? { efforts } : {}),
      ...(definition.probedThinkingMode ? { mode: definition.probedThinkingMode } : {}),
      source: 'probed',
    };
  }
  const reportedEfforts = normalizeThinkingEffortList(definition.reportedThinkingEfforts);
  if (definition.reportedSupportsThinking !== undefined || reportedEfforts) {
    const supports = definition.reportedSupportsThinking ?? Boolean(reportedEfforts?.length);
    if (!supports) {
      return { supportsThinking: false, efforts: [], source: 'server' };
    }
    return {
      supportsThinking: true,
      ...(reportedEfforts ? { efforts: reportedEfforts } : {}),
      source: 'server',
    };
  }
  return { source: 'default' };
}

/** Keep runtime wire-family, state-mode, and per-model thinking tiers in sync with saved settings. */
export function syncCompatibleWireProtocols(
  providers?: Record<string, LLMProviderConfig> | null
): void {
  antigravityWireModes.clear();
  responsesStateModes.clear();
  compatibleModelThinkingMap.clear();
  if (!providers) return;
  for (const [id, config] of Object.entries(providers)) {
    if (!config) continue;
    if (config.driverKind === 'antigravity-compatible') {
      antigravityWireModes.set(id, config.antigravityCompatible?.wireProtocol ?? 'auto');
    } else if (config.driverKind === 'responses-compatible') {
      responsesStateModes.set(id, config.responsesCompatible?.stateMode ?? 'stateless');
    }
    if (isCustomCompatibleDriverKind(config.driverKind)) {
      const models = getCustomCompatibleModelsRecord(config);
      for (const [modelId, def] of Object.entries(models)) {
        const resolved = resolveDefinitionThinking(def);
        if (resolved.source !== 'default') {
          compatibleModelThinkingMap.set(modelThinkingKey(id, modelId), resolved);
        }
      }
    }
  }
}

export function setAntigravityWireProtocol(
  instanceId: string,
  protocol: AntigravityCompatibleWireProtocol
): void {
  antigravityWireModes.set(instanceId, protocol);
}

export function resolveCompatibleModelThinking(
  provider?: string | null,
  model?: string | null,
): ResolvedCompatibleModelThinking | undefined {
  if (!provider || !model) return undefined;
  return compatibleModelThinkingMap.get(modelThinkingKey(provider, model));
}

export function resolveResponsesStateMode(
  provider?: string | null
): ResponsesCompatibleStateMode {
  if (!provider) return 'stateless';
  return responsesStateModes.get(provider)
    ?? responsesStateModes.get(provider.toLowerCase())
    ?? 'stateless';
}

/** Strip optional gateway prefix (`google/gemini-4-carbon`) and `:1m` suffix. */
export function stripCompatibleModelPrefix(modelId: string): string {
  const withoutVariant = modelId.replace(':1m', '');
  const slashIndex = withoutVariant.lastIndexOf('/');
  return slashIndex >= 0 ? withoutVariant.slice(slashIndex + 1) : withoutVariant;
}

export function isClaudeFamilyModelId(modelId?: string | null): boolean {
  if (!modelId) return false;
  return /^claude-/i.test(stripCompatibleModelPrefix(modelId));
}

export function resolveAntigravityModelWire(
  modelId: string | undefined,
  wireProtocol: AntigravityCompatibleWireProtocol = 'auto'
): 'anthropic' | 'google' {
  if (wireProtocol === 'messages') return 'anthropic';
  if (wireProtocol === 'v1beta') return 'google';
  return isClaudeFamilyModelId(modelId) ? 'anthropic' : 'google';
}

export function resolveProviderWireFamily(
  provider?: string | null,
  model?: string | null
): ProviderWireFamily {
  if (!provider) return 'openai-compatible';
  const normalized = provider.toLowerCase();
  if (normalized === 'anthropic' || normalized.startsWith('anthropic-compatible-')) {
    return 'anthropic';
  }
  if (normalized === 'google') {
    return 'google';
  }
  if (normalized.startsWith('responses-compatible-')) {
    return 'responses';
  }
  if (normalized.startsWith('antigravity-compatible-')) {
    const mode = antigravityWireModes.get(provider) ?? antigravityWireModes.get(normalized) ?? 'auto';
    return resolveAntigravityModelWire(model ?? undefined, mode);
  }
  return 'openai-compatible';
}

export function isCustomCompatibleDriverKind(value?: string | null): value is CompatibleDriverKind {
  return value === 'openai-compatible'
    || value === 'responses-compatible'
    || value === 'anthropic-compatible'
    || value === 'antigravity-compatible';
}

export function isCustomCompatibleProviderId(providerId: string): boolean {
  return providerId.startsWith('openai-compatible-')
    || providerId.startsWith('responses-compatible-')
    || providerId.startsWith('anthropic-compatible-')
    || providerId.startsWith('antigravity-compatible-');
}

export function isCustomCompatibleConfig(config?: LLMProviderConfig | null): boolean {
  if (!config) return false;
  return (config.driverKind === 'openai-compatible' && config.openaiCompatible?.schemaVersion === 1)
    || (config.driverKind === 'responses-compatible' && config.responsesCompatible?.schemaVersion === 1)
    || (config.driverKind === 'anthropic-compatible' && config.anthropicCompatible?.schemaVersion === 1)
    || (config.driverKind === 'antigravity-compatible' && config.antigravityCompatible?.schemaVersion === 1);
}

export function getCustomCompatibleFallbackLabel(driverKind?: string): string {
  switch (driverKind) {
    case 'responses-compatible':
      return 'Responses-compatible';
    case 'anthropic-compatible':
      return 'Anthropic-compatible';
    case 'antigravity-compatible':
      return 'Antigravity-compatible';
    default:
      return 'OpenAI-compatible';
  }
}

export function getCustomCompatibleDisplayName(config?: LLMProviderConfig | null): string {
  if (!config) return 'OpenAI-compatible';
  switch (config.driverKind) {
    case 'responses-compatible':
      return config.responsesCompatible?.displayName || 'Responses-compatible';
    case 'anthropic-compatible':
      return config.anthropicCompatible?.displayName || 'Anthropic-compatible';
    case 'antigravity-compatible':
      return config.antigravityCompatible?.displayName || 'Antigravity-compatible';
    default:
      return config.openaiCompatible?.displayName || 'OpenAI-compatible';
  }
}

export function getCustomCompatibleBaseUrl(config?: LLMProviderConfig | null): string {
  if (!config) return '';
  switch (config.driverKind) {
    case 'responses-compatible':
      return config.responsesCompatible?.baseUrl?.trim() ?? '';
    case 'anthropic-compatible':
      return config.anthropicCompatible?.baseUrl?.trim() ?? '';
    case 'antigravity-compatible':
      return config.antigravityCompatible?.baseUrl?.trim() ?? '';
    case 'openai-compatible':
      return config.openaiCompatible?.baseUrl?.trim() ?? '';
    default:
      return '';
  }
}

export function getCustomCompatibleModelsRecord(
  config?: LLMProviderConfig | null
): Record<string, OpenAICompatibleModelDefinition> {
  if (!config) return {};
  switch (config.driverKind) {
    case 'responses-compatible':
      return config.responsesCompatible?.models ?? {};
    case 'anthropic-compatible':
      return config.anthropicCompatible?.models ?? {};
    case 'antigravity-compatible':
      return config.antigravityCompatible?.models ?? {};
    case 'openai-compatible':
      return config.openaiCompatible?.models ?? {};
    default:
      return {};
  }
}
