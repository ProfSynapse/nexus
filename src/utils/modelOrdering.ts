import { ModelRegistry } from '../services/llm/adapters/ModelRegistry';

export interface ModelOrderingIdentity {
  provider: string;
  id: string;
  /** Provider-published Unix seconds, when already present in a live listing. */
  created?: number;
}

function releaseTime(provider: string, id: string, created?: number): number | null {
  const releaseDate = ModelRegistry.findModel(provider, id)?.releaseDate;
  if (releaseDate && /^\d{4}-\d{2}-\d{2}$/.test(releaseDate)) {
    const time = Date.parse(`${releaseDate}T00:00:00Z`);
    if (Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === releaseDate) {
      return time;
    }
  }

  if (typeof created === 'number' && Number.isSafeInteger(created) && created > 0) {
    const time = created * 1000;
    if (Number.isFinite(time) && !Number.isNaN(new Date(time).getTime())) return time;
  }
  return null;
}

/** Sort only models with verified dates; keep unknown and equal-date entries in their original order. */
export function sortModelsNewestFirst<T>(
  models: readonly T[],
  identity: (model: T) => ModelOrderingIdentity
): T[] {
  return models
    .map((model, index) => {
      const { provider, id, created } = identity(model);
      return { model, index, time: releaseTime(provider, id, created) };
    })
    .sort((left, right) => {
      if (left.time === null && right.time === null) return left.index - right.index;
      if (left.time === null) return 1;
      if (right.time === null) return -1;
      return right.time - left.time || left.index - right.index;
    })
    .map(entry => entry.model);
}
