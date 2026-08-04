/**
 * Pure metadata-update semantics shared by task and project repositories.
 * Repositories resolve the operation against SQLite inside their transaction,
 * then persist the complete resulting object to both SQLite and JSONL.
 */

export type MetadataUpdateMode = 'merge' | 'replace';

export interface MetadataUpdateOperation {
  current?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  metadataMode?: MetadataUpdateMode;
  removeMetadataKeys?: string[];
}

interface NormalizedMetadataUpdate {
  current: Record<string, unknown>;
  metadata: Record<string, unknown>;
  mode: MetadataUpdateMode;
  removals: string[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Reflect.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function copyDefinedEntries(source: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(source).filter(([, value]) => value !== undefined)
  );
}

function normalizeMetadataUpdate(operation: MetadataUpdateOperation): NormalizedMetadataUpdate {
  const { current, metadata, metadataMode, removeMetadataKeys } = operation;

  if (metadataMode !== undefined && metadataMode !== 'merge' && metadataMode !== 'replace') {
    throw new Error('metadataMode must be either "merge" or "replace"');
  }
  if (metadata !== undefined && !isPlainObject(metadata)) {
    throw new Error('metadata must be an object');
  }
  if (current !== undefined && !isPlainObject(current)) {
    throw new Error('Stored metadata must be an object');
  }
  if (removeMetadataKeys !== undefined && !Array.isArray(removeMetadataKeys)) {
    throw new Error('removeMetadataKeys must be an array of non-empty strings');
  }

  const removals: string[] = [];
  for (const key of removeMetadataKeys ?? []) {
    if (typeof key !== 'string' || key.trim().length === 0) {
      throw new Error('removeMetadataKeys must be an array of non-empty strings');
    }
    if (!removals.includes(key)) {
      removals.push(key);
    }
  }

  const mode = metadataMode ?? 'merge';
  if (mode === 'replace') {
    if (metadata === undefined) {
      throw new Error('metadataMode "replace" requires an explicit metadata object');
    }
    if (removals.length > 0) {
      throw new Error('removeMetadataKeys cannot be combined with metadataMode "replace"');
    }
  }

  return {
    current: current ?? {},
    metadata: copyDefinedEntries(metadata ?? {}),
    mode,
    removals
  };
}

/**
 * Detect no-ops that do not depend on the current stored value. This is safe at
 * the service layer and ensures malformed inputs are validated before an early
 * return. Current-value-dependent no-ops remain the repository's responsibility.
 */
export function isMetadataUpdateTriviallyEmpty(operation: MetadataUpdateOperation): boolean {
  const normalized = normalizeMetadataUpdate(operation);
  return normalized.mode === 'merge'
    && Object.keys(normalized.metadata).length === 0
    && normalized.removals.length === 0;
}

/**
 * Resolve a shallow merge, explicit replacement, or merge-mode removals.
 * Returns undefined when the metadata operation makes no effective change.
 */
export function resolveMetadataUpdate(
  operation: MetadataUpdateOperation
): Record<string, unknown> | undefined {
  const normalized = normalizeMetadataUpdate(operation);

  if (normalized.mode === 'replace') {
    return normalized.metadata;
  }

  const patchKeys = Object.keys(normalized.metadata);
  const effectiveRemovals = normalized.removals.filter(key =>
    Object.prototype.hasOwnProperty.call(normalized.current, key)
    || Object.prototype.hasOwnProperty.call(normalized.metadata, key)
  );

  if (patchKeys.length === 0 && effectiveRemovals.length === 0) {
    return undefined;
  }

  const merged = { ...normalized.current, ...normalized.metadata };
  for (const key of effectiveRemovals) {
    delete merged[key];
  }
  return merged;
}
