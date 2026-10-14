/**
 * Registry-backed capability lookups for request boundaries.
 *
 * Every answer comes from the static model registry. A model that is not in
 * the registry (Ollama, LM Studio, OpenAI-compatible endpoints, ids typed by
 * hand) has no capability data, and each helper says so explicitly rather than
 * guessing: `undefined` for tri-state answers, and the permissive answer for
 * booleans that only ever restrict a request.
 *
 * Pure data access — no Node or Obsidian imports — so it is safe on mobile and
 * in settings UI as well as the runtime paths.
 */

import { ModelRegistry } from '../adapters/ModelRegistry';
import type { ModelSpec } from '../adapters/modelTypes';

/** The registry entry for a provider/model pair, if one exists. */
export function findRegistryModelSpec(
  provider: string | null | undefined,
  model: string | null | undefined
): ModelSpec | undefined {
  if (!provider || !model) return undefined;
  return ModelRegistry.findModel(provider, model);
}

/**
 * Whether the registry says this model can think.
 * `undefined` means there is no registry entry, so nothing is known.
 */
export function registryModelSupportsThinking(
  provider: string | null | undefined,
  model: string | null | undefined
): boolean | undefined {
  return findRegistryModelSpec(provider, model)?.capabilities.supportsThinking;
}

/**
 * Whether a request for this model may carry `temperature`.
 * Only an explicit `supportsSamplingParams: false` in the registry says no;
 * models without an entry keep the parameter, matching the adapters.
 */
export function modelAcceptsSamplingParams(
  provider: string | null | undefined,
  model: string | null | undefined
): boolean {
  return findRegistryModelSpec(provider, model)?.supportsSamplingParams !== false;
}

/** The advertised context window, when the registry knows the model. */
export function getRegistryContextWindow(
  provider: string | null | undefined,
  model: string | null | undefined
): number | undefined {
  const window = findRegistryModelSpec(provider, model)?.contextWindow;
  return typeof window === 'number' && window > 0 ? window : undefined;
}
