import type { ModelSpec } from '../modelTypes';

/**
 * Whether a request may carry `temperature` / `top_p` for this model.
 *
 * Driven by `ModelSpec.supportsSamplingParams` rather than by matching model
 * ids, so a new model that rejects sampling is handled by its registry entry
 * alone. Ids with no registry entry (custom or not-yet-added models) keep the
 * parameters, which is what every model accepted before reasoning-first
 * releases started rejecting them.
 */
export function acceptsSamplingParams(models: readonly ModelSpec[], modelId: string): boolean {
  const spec = models.find(m => m.apiName === modelId);
  return spec?.supportsSamplingParams !== false;
}
