// Location: src/services/helpers/DualBackendExecutor.ts
// Shared dual-backend routing helper for services that support both
// IStorageAdapter (SQLite hybrid) and legacy (JSONL + IndexManager) paths.
// Used by: WorkspaceService, ConversationService, MemoryService

import { IStorageAdapter } from '../../database/interfaces/IStorageAdapter';
import { withTimeout } from '../../utils/withTimeout';

/**
 * How long a mutation will wait for a storage adapter that exists but has not
 * finished initializing.
 *
 * Bounded on purpose. Waiting forever would trade issue #333 for issue #158 —
 * a stalled hydration would hang the delete button instead of lying about it.
 * Thirty seconds is long enough to cover an ordinary startup rebuild and short
 * enough that a user who clicks Delete gets an answer; when it expires the
 * caller gets an error it can retry, not a false success.
 */
export const WRITE_BACKEND_READY_TIMEOUT_MS = 30_000;

/**
 * Raised when the hybrid adapter is the store of record but cannot accept a
 * write, instead of quietly writing somewhere nothing reads.
 *
 * This is the whole of issue #333. `deleteWorkspace` routed through
 * `withDualBackend`, which asks `isReady()` and falls back to the legacy
 * `<id>.json` path the instant the answer is no — which it is for the whole of
 * startup hydration. The delete then wrote no `workspace_deleted` event and
 * removed no SQLite row, reported success, and the UI dropped a row that was
 * still there. It came back on the next read.
 *
 * Callers already handle a throw (the workspaces tab shows "Failed to delete
 * workspace"), so failing is both honest and recoverable — retrying once
 * hydration finishes works.
 */
export class StorageBackendUnavailableError extends Error {
  constructor(reason: string) {
    super(
      `Storage is not ready, so this change was not saved (${reason}). `
      + 'Writing it to the legacy backend would report success and then lose it. '
      + 'Try again once startup finishes.'
    );
    this.name = 'StorageBackendUnavailableError';
  }
}

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
  waitForQueryReady?: (maxWaitMs?: number) => Promise<boolean>;
  /** Settles when initialization finishes: true on success, false on failure. */
  waitForReady?: () => Promise<boolean>;
  /** Non-null once initialization has settled unsuccessfully. */
  getInitError?: () => Error | null;
};

function getRawAdapter(adapterOrGetter: StorageAdapterOrGetter): QueryAwareStorageAdapter | undefined {
  if (typeof adapterOrGetter === 'function') {
    return adapterOrGetter();
  }
  return adapterOrGetter;
}

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
    adapter = adapterOrGetter();
  } else {
    adapter = adapterOrGetter;
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
 * Routes to SQLite when query-ready. If the adapter is initialized but still
 * hydrating, awaits `waitForQueryReady()` (event-driven; timeout is a safety
 * net for stuck hydration) before falling through to legacy. This closes the
 * race window where reads issued during startup silently hit a stale legacy
 * view (issue #190).
 */
export async function withReadableBackend<T>(
  adapterOrGetter: StorageAdapterOrGetter,
  adapterFn: (adapter: IStorageAdapter) => T | Promise<T>,
  legacyFn: () => T | Promise<T>
): Promise<T> {
  let adapter = resolveReadableAdapter(adapterOrGetter);
  if (adapter) return adapterFn(adapter);

  const raw = getRawAdapter(adapterOrGetter);
  if (raw && raw.isReady() && typeof raw.waitForQueryReady === 'function') {
    const ready = await raw.waitForQueryReady();
    if (ready) {
      adapter = resolveReadableAdapter(adapterOrGetter);
      if (adapter) return adapterFn(adapter);
    }
  }
  return legacyFn();
}

/**
 * Resolve an adapter that is safe to WRITE through, waiting out startup.
 *
 * `resolveAdapter` answers "is the adapter ready *right now*", which is the
 * right question for a read that has a usable fallback and the wrong one for a
 * mutation. The two backends are different stores, not two views of one: the
 * hybrid adapter writes a JSONL event plus a SQLite row, the legacy path
 * writes an `<id>.json` file and an index entry. On a vault-root install
 * nothing reads those files, so a mutation routed to legacy is discarded —
 * silently, after reporting success.
 *
 * That branch is easy to reach. `isReady()` is false for the whole of startup
 * hydration, which is tens of seconds on a large vault, and the workspace UI
 * is fully interactive throughout. This is what made deleted workspaces come
 * back (#333).
 *
 * Returns:
 * - the adapter, once ready — waiting for initialization if need be, bounded
 *   by `timeoutMs` so a stalled hydration cannot hang the caller (#158);
 * - `undefined` only when no adapter is in play at all, which is the one case
 *   where the legacy path really is the store of record;
 * - throws `StorageBackendUnavailableError` when an adapter is in play but
 *   will not accept the write, so the caller can report a failure instead of
 *   an imaginary success.
 */
export async function resolveWritableAdapter(
  adapterOrGetter: StorageAdapterOrGetter,
  timeoutMs: number = WRITE_BACKEND_READY_TIMEOUT_MS
): Promise<IStorageAdapter | undefined> {
  const ready = resolveAdapter(adapterOrGetter);
  if (ready) return ready;

  const raw = getRawAdapter(adapterOrGetter);
  if (!raw || typeof raw.waitForReady !== 'function') {
    // No adapter object to wait for. Note this still covers the brief window
    // before the adapter *service* is constructed, where the getter returns
    // undefined — reads have exactly the same blind spot, so writes are no
    // longer the weaker path, but neither is closed here.
    return undefined;
  }

  // `false` is the timeout sentinel as well as the init-failed answer; the two
  // are told apart below by whether an init error was recorded.
  const becameReady = await withTimeout(raw.waitForReady(), timeoutMs, false);
  if (becameReady) {
    // Re-resolve rather than trusting `raw`: only resolveAdapter applies the
    // ready check, and the getter may hand back a different instance.
    const settled = resolveAdapter(adapterOrGetter);
    if (settled) return settled;
  }

  const initError = raw.getInitError?.() ?? null;
  if (initError) {
    throw new StorageBackendUnavailableError(initError.message);
  }
  if (!raw.isReady()) {
    throw new StorageBackendUnavailableError(
      `storage did not become ready within ${timeoutMs}ms`
    );
  }

  // Ready after all, but the getter no longer resolves it — treat as absent
  // rather than guessing.
  return undefined;
}

/**
 * Execute a dual-backend WRITE — the mutating counterpart to
 * `withReadableBackend`.
 *
 * Use this for anything destructive, and for anything whose caller fires a
 * change notification afterwards: a notification that follows a vacuous
 * success is how the UI ends up lying convincingly. Because this throws rather
 * than returning, the notification is skipped automatically.
 *
 * See `resolveWritableAdapter` for why a mutation cannot fall through to the
 * legacy backend the way a read can.
 */
export async function withWritableBackend<T>(
  adapterOrGetter: StorageAdapterOrGetter,
  adapterFn: (adapter: IStorageAdapter) => T | Promise<T>,
  legacyFn: () => T | Promise<T>,
  timeoutMs: number = WRITE_BACKEND_READY_TIMEOUT_MS
): Promise<T> {
  const adapter = await resolveWritableAdapter(adapterOrGetter, timeoutMs);
  if (adapter) {
    return adapterFn(adapter);
  }
  return legacyFn();
}
