// Location: src/services/helpers/DualBackendExecutor.ts
// Shared dual-backend routing helper for services that support both
// IStorageAdapter (SQLite hybrid) and legacy (JSONL + IndexManager) paths.
// Used by: WorkspaceService, ConversationService, MemoryService

import { IStorageAdapter } from '../../database/interfaces/IStorageAdapter';

/**
 * Type for the storage adapter parameter: either a direct adapter instance
 * or a getter function that lazily resolves the adapter.
 * The getter pattern ensures services pick up the adapter after SQLite
 * finishes initializing in the background, rather than capturing a
 * one-time null reference at construction time.
 */
export type StorageAdapterOrGetter = IStorageAdapter | (() => IStorageAdapter | undefined) | undefined;

type QueryAwareStorageAdapter = IStorageAdapter & {
  isQueryReady?: () => boolean;
};

/**
 * Resolve a StorageAdapterOrGetter to a ready IStorageAdapter, or undefined.
 * Supports both direct adapter references and lazy getter functions.
 * Returns the adapter only if it exists and isReady() returns true.
 */
export function resolveAdapter(adapterOrGetter: StorageAdapterOrGetter): IStorageAdapter | undefined {
  let adapter: IStorageAdapter | undefined;

  if (typeof adapterOrGetter === 'function') {
    adapter = adapterOrGetter();
  } else {
    adapter = adapterOrGetter;
  }

  if (adapter && adapter.isReady()) {
    return adapter;
  }

  return undefined;
}

/**
 * Resolve a StorageAdapterOrGetter to an adapter that is safe for read queries.
 *
 * If an adapter exposes isQueryReady(), that stronger signal is used.
 * Otherwise this falls back to isReady().
 */
export function resolveReadableAdapter(adapterOrGetter: StorageAdapterOrGetter): IStorageAdapter | undefined {
  let adapter: QueryAwareStorageAdapter | undefined;

  if (typeof adapterOrGetter === 'function') {
    adapter = adapterOrGetter() as QueryAwareStorageAdapter | undefined;
  } else {
    adapter = adapterOrGetter as QueryAwareStorageAdapter | undefined;
  }

  if (!adapter || !adapter.isReady()) {
    return undefined;
  }

  if (typeof adapter.isQueryReady === 'function') {
    return adapter.isQueryReady() ? adapter : undefined;
  }

  return adapter;
}

/**
 * Execute a dual-backend operation: if an adapter is available and ready,
 * run adapterFn; otherwise run legacyFn.
 *
 * Both functions may return either sync or async values; the result is
 * always awaited so callers get a consistent Promise<T>.
 *
 * @param adapterOrGetter - The adapter reference or getter to resolve
 * @param adapterFn - Function to call when adapter is ready (receives the resolved adapter)
 * @param legacyFn - Function to call when adapter is not available
 * @returns The result of whichever function was called
 */
export async function withDualBackend<T>(
  adapterOrGetter: StorageAdapterOrGetter,
  adapterFn: (adapter: IStorageAdapter) => T | Promise<T>,
  legacyFn: () => T | Promise<T>
): Promise<T> {
  const adapter = resolveAdapter(adapterOrGetter);
  if (adapter) {
    return adapterFn(adapter);
  }
  return legacyFn();
}

/**
 * Execute a dual-backend read operation.
 *
 * Routes to SQLite only when the adapter reports that read queries are safe.
 * Falls back to legacy storage during startup hydration windows.
 */
export async function withReadableBackend<T>(
  adapterOrGetter: StorageAdapterOrGetter,
  adapterFn: (adapter: IStorageAdapter) => T | Promise<T>,
  legacyFn: () => T | Promise<T>
): Promise<T> {
  const adapter = resolveReadableAdapter(adapterOrGetter);
  if (adapter) {
    return adapterFn(adapter);
  }
  return legacyFn();
}
