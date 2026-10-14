/**
 * Gate a stored thinking preference at the request boundary.
 *
 * The user's thinking choice is stored per chat and per default, and it stays
 * stored when they switch to a model that cannot reason — so switching back
 * restores their level. What must not happen is that hidden preference being
 * sent: a request for a non-reasoning model always goes out with thinking off.
 *
 * The answer is driven by the registry's `supportsThinking` flag. A model with
 * no registry entry (discovered or custom models) has no capability data, so
 * its preference passes through unchanged and the adapter decides, which is
 * what every request did before this gate existed.
 */

import type { ThinkingEffort, ThinkingSettings } from '../../../types/llm/ProviderTypes';
import { registryModelSupportsThinking } from './modelCapabilityLookup';

export interface ThinkingPreference {
  enabled?: boolean;
  effort?: ThinkingEffort;
}

export interface ResolveThinkingOptions {
  /**
   * Capability supplied by the caller when it knows better than the static
   * registry. `undefined` falls back to the registry lookup.
   */
  supportsThinking?: boolean;
}

const DEFAULT_EFFORT: ThinkingEffort = 'medium';

/**
 * Returns the thinking settings a request for `provider`/`model` may carry.
 * The input object is never modified.
 */
export function resolveThinkingForModel(
  provider: string | null | undefined,
  model: string | null | undefined,
  thinking: ThinkingPreference | null | undefined,
  options: ResolveThinkingOptions = {}
): ThinkingSettings {
  const effort = thinking?.effort ?? DEFAULT_EFFORT;
  const enabled = thinking?.enabled === true;
  if (!enabled) return { enabled: false, effort };

  const supportsThinking = options.supportsThinking ?? registryModelSupportsThinking(provider, model);
  if (supportsThinking === false) return { enabled: false, effort };
  return { enabled: true, effort };
}
