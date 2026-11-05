/**
 * Text that tells an agent which image or video models a rule applies to. The
 * same id can behave differently on another provider, so providers are never
 * merged.
 */

export interface ProviderModel {
  provider: string;
  id: string;
}

/**
 * Group models that share a value, per provider: "16 on openai: a, b; 8 on
 * openrouter: c".
 */
export function groupModels<T extends ProviderModel>(models: readonly T[], valueOf: (model: T) => string): string {
  const groups = new Map<string, string[]>();
  for (const model of models) {
    const value = valueOf(model);
    const key = value ? `${value} on ${model.provider}` : model.provider;
    groups.set(key, [...(groups.get(key) ?? []), model.id]);
  }
  return Array.from(groups, ([key, ids]) => `${key}: ${ids.join(', ')}`).join('; ');
}

/** "a", "a or b", "a, b, or c". */
export function joinWithOr(items: readonly string[]): string {
  if (items.length < 2) return items.join('');
  return `${items.slice(0, -1).join(', ')}${items.length > 2 ? ',' : ''} or ${items[items.length - 1]}`;
}

/** "openai: a, b; openrouter: a, c" for the given models. */
export function describeModelsByProvider(models: readonly ProviderModel[]): string {
  return groupModels(models, () => '');
}
