/**
 * What the selected model can do, as far as the settings UI needs to know:
 * whether it reasons (Thinking row), whether it accepts a temperature
 * (Creativity row) and how large its context window is (Context window row).
 *
 * Registry models answer synchronously from StaticModelsService. Models the
 * registry does not know (Ollama, LM Studio, OpenAI-compatible endpoints)
 * report their window only once the provider has listed them, so the first
 * call starts a lookup and `onDiscovered` fires when it lands.
 *
 * Merged sign-in providers (ChatGPT, Claude Code, Antigravity CLI) are looked
 * up under their own id first and then under the API provider they are shown
 * with, matching the merged model dropdown.
 *
 * Mobile-safe: no Node imports.
 */

import type { ModelWithProvider } from '../../../services/StaticModelsService';
import { getContextWindowOverrideKey } from '../../../ui/chat/utils/ContextWindowSettings';

export interface ModelCapabilities {
  /** False when nothing is known; the Thinking row is shown only for models known to reason. */
  supportsThinking: boolean;
  /** Only an explicit registry `false` turns Creativity off; unknown models accept it. */
  supportsSamplingParams: boolean;
  /** Advertised window in tokens, when known. */
  contextWindow?: number;
  /** Registry display name, when the registry knows the model. */
  name?: string;
}

export interface StaticModelLookup {
  findModel(provider: string, modelId: string): ModelWithProvider | undefined;
}

export interface DiscoveredModelLookup {
  getModelsForProvider(provider: string): Promise<Array<{ id: string; contextWindow?: number }>>;
}

const NO_CAPABILITIES: ModelCapabilities = { supportsThinking: false, supportsSamplingParams: true };

const MERGED_PROVIDERS: Record<string, string> = {
  'openai-codex': 'openai',
  'anthropic-claude-code': 'anthropic',
  'google-gemini-cli': 'google'
};

export function findStaticModel(
  staticModels: StaticModelLookup,
  provider: string | null | undefined,
  model: string | null | undefined
): ModelWithProvider | undefined {
  if (!provider || !model) return undefined;
  const direct = staticModels.findModel(provider, model);
  if (direct) return direct;
  const merged = MERGED_PROVIDERS[provider];
  return merged ? staticModels.findModel(merged, model) : undefined;
}

/** Registry-only answer; `undefined` when the registry does not know the model. */
export function getStaticModelCapabilities(
  staticModels: StaticModelLookup,
  provider: string | null | undefined,
  model: string | null | undefined
): ModelCapabilities | undefined {
  const spec = findStaticModel(staticModels, provider, model);
  if (!spec) return undefined;
  return {
    supportsThinking: spec.capabilities?.supportsThinking === true,
    supportsSamplingParams: spec.supportsSamplingParams !== false,
    contextWindow: spec.contextWindow > 0 ? spec.contextWindow : undefined,
    name: spec.name
  };
}

/**
 * Capability lookups for one settings renderer, remembering windows that
 * providers report at runtime so a redraw does not ask again.
 */
export class ModelCapabilityResolver {
  private discoveredWindows = new Map<string, number>();
  private pending = new Set<string>();

  constructor(
    private readonly staticModels: StaticModelLookup,
    private readonly getDiscoveredLookup: () => DiscoveredModelLookup
  ) {}

  /**
   * Capabilities for a provider/model. When the window is unknown, a lookup
   * starts (once per model) and `onDiscovered` is called if it finds one.
   */
  get(
    provider: string | null | undefined,
    model: string | null | undefined,
    onDiscovered?: () => void
  ): ModelCapabilities {
    if (!provider || !model) return { ...NO_CAPABILITIES };
    const known = getStaticModelCapabilities(this.staticModels, provider, model) ?? { ...NO_CAPABILITIES };
    if (known.contextWindow) return known;

    const key = getContextWindowOverrideKey(provider, model);
    const discovered = this.discoveredWindows.get(key);
    if (discovered) return { ...known, contextWindow: discovered };
    if (onDiscovered) this.lookupContextWindow(provider, model, onDiscovered);
    return known;
  }

  private lookupContextWindow(provider: string, model: string, onDiscovered: () => void): void {
    const key = getContextWindowOverrideKey(provider, model);
    if (this.pending.has(key)) return;
    this.pending.add(key);
    void this.getDiscoveredLookup().getModelsForProvider(provider).then(models => {
      const window = models.find(candidate => candidate.id === model)?.contextWindow;
      if (!window || window <= 0) return;
      this.discoveredWindows.set(key, window);
      onDiscovered();
    }).catch(() => {
      // An unavailable provider has no reliable advertised limit to adjust.
    });
  }
}
