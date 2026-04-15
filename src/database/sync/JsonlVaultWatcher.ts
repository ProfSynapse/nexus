/**
 * Location: src/database/sync/JsonlVaultWatcher.ts
 *
 * Watches vault file events under the plugin's storage data path and fires
 * a callback whenever JSONL shards change. Lets the plugin reconcile its
 * SQLite cache the moment Obsidian Sync lands a remote JSONL write — e.g.
 * a chat written on desktop becomes visible on mobile without a restart.
 *
 * Why vault events (not polling):
 * - As of v5.7.0+ storage lives under a regular vault folder (default
 *   `Nexus/data/`), which means `vault.on('modify' | 'create' | 'delete'
 *   | 'rename')` fires for it — including for writes landed by Obsidian
 *   Sync. This is the canonical Obsidian API for detecting file changes.
 *
 * Self-write suppression:
 * - The plugin itself appends to these JSONL shards during normal use
 *   (saving messages, workspace updates, etc.), which would cause the
 *   watcher to echo-trigger sync for no reason. `JSONLWriter` calls
 *   `suppressFor(path)` just before each write so the watcher ignores
 *   the corresponding modify event for a short TTL.
 *
 * Debounce:
 * - Events are coalesced over a configurable window (default 2s) so
 *   burst sync arrivals (many shards landing together) produce a single
 *   `onChange` invocation with the union of modified streams.
 *
 * Related:
 * - src/database/sync/SyncCoordinator.ts — the reconciliation target
 * - src/database/adapters/HybridStorageAdapter.ts — owns + lifecycles this
 * - src/database/storage/JSONLWriter.ts — invokes `suppressFor` pre-write
 */

import { App, EventRef, TAbstractFile, TFile, normalizePath } from 'obsidian';

export type WatchedCategory = 'conversations' | 'workspaces' | 'tasks';

/**
 * A stream whose on-disk shards were observed to change during a debounce
 * window. Callers use these to decide whether the currently-viewed content
 * needs a refresh.
 */
export interface ModifiedStream {
  category: WatchedCategory;
  /** Raw stream id as written on disk, e.g. `conv_abc-123`, `ws_xyz`, `tasks_xyz`. */
  streamId: string;
  /** Domain id with category prefix stripped, e.g. `abc-123` (a conversationId) or `xyz` (a workspaceId). */
  businessId: string;
  /** Example relative path that triggered the change, e.g. `conversations/conv_abc-123/shard-000.jsonl`. */
  samplePath: string;
}

export interface JsonlVaultWatcherOptions {
  app: App;
  /** Current plugin data path, e.g. `Nexus/data`. Can be updated via `setDataPath`. */
  dataPath: string;
  /**
   * Fired (debounced) when one or more JSONL shards under `dataPath` change
   * due to something other than this device's own writes. Implementations
   * typically call `HybridStorageAdapter.sync()` and then re-render any
   * currently-open views affected by `modified`.
   */
  onChange: (modified: ModifiedStream[]) => Promise<void> | void;
  /** Coalesce window in ms. Default: 2000. */
  debounceMs?: number;
  /** Suppression TTL in ms for self-writes. Default: 3000. */
  suppressTtlMs?: number;
}

const MATCH_SHARDED = /^(conversations|workspaces|tasks)\/([^/]+)\/shard-\d+\.jsonl$/;
const MATCH_FLAT = /^(conversations|workspaces|tasks)\/([^/]+)\.jsonl$/;

const BUSINESS_ID_PREFIX: Record<WatchedCategory, string> = {
  conversations: 'conv_',
  workspaces: 'ws_',
  tasks: 'tasks_'
};

interface ParsedStreamPath {
  category: WatchedCategory;
  streamId: string;
  businessId: string;
}

/**
 * Parse a path (relative to the plugin's `dataPath`) into its category
 * and stream id. Accepts both the sharded layout used by VaultEventStore
 * (`<cat>/<streamId>/shard-NNN.jsonl`) and the legacy flat layout
 * (`<cat>/<streamId>.jsonl`). Returns `null` for anything else (meta
 * manifests, unrelated files, etc.).
 */
export function parseStreamPath(relativePath: string): ParsedStreamPath | null {
  const normalized = normalizePath(relativePath).replace(/^\/+|\/+$/g, '');
  const match = MATCH_SHARDED.exec(normalized) ?? MATCH_FLAT.exec(normalized);
  if (!match) {
    return null;
  }
  const category = match[1] as WatchedCategory;
  const streamId = match[2];
  const prefix = BUSINESS_ID_PREFIX[category];
  const businessId = streamId.startsWith(prefix) ? streamId.slice(prefix.length) : streamId;
  return { category, streamId, businessId };
}

/**
 * Vault event-based JSONL watcher. See file header for design notes.
 */
export class JsonlVaultWatcher {
  private readonly app: App;
  private readonly onChange: (modified: ModifiedStream[]) => Promise<void> | void;
  private readonly debounceMs: number;
  private readonly suppressTtlMs: number;

  private dataPath: string;
  private running = false;
  private eventRefs: EventRef[] = [];

  /**
   * Self-write suppression keyed by `${category}:${streamId}` → expiry ms.
   * `JSONLWriter` doesn't know the physical shard path (that's owned by
   * `ShardedJsonlStreamStore` and can rotate between shards), so suppression
   * has to live at the logical stream level: suppress all shards belonging
   * to a stream for a TTL window after the plugin writes to it.
   */
  private readonly suppressed = new Map<string, number>();

  /** Accumulator of streams modified within the current debounce window. */
  private readonly pending = new Map<string, ModifiedStream>();
  private debounceTimer?: ReturnType<typeof setTimeout>;

  private dispatching = false;
  private dispatchQueued = false;

  constructor(options: JsonlVaultWatcherOptions) {
    this.app = options.app;
    this.onChange = options.onChange;
    this.debounceMs = options.debounceMs ?? 2000;
    this.suppressTtlMs = options.suppressTtlMs ?? 3000;
    this.dataPath = normalizeDataPath(options.dataPath);
  }

  /**
   * Register vault event listeners. Idempotent.
   */
  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;

    const vault = this.app.vault;
    this.eventRefs.push(
      vault.on('modify', (file) => this.handleFileEvent(file)),
      vault.on('create', (file) => this.handleFileEvent(file)),
      vault.on('delete', (file) => this.handleFileEvent(file)),
      vault.on('rename', (file, oldPath) => {
        this.handleFileEvent(file);
        // Also flag the old path in case it was a stream path we care about.
        const parsed = this.parseRelative(oldPath);
        if (parsed) {
          this.recordModified(parsed, oldPath);
          this.scheduleDispatch();
        }
      })
    );
  }

  /**
   * Detach all listeners and clear pending timers. Safe to call if never started.
   */
  stop(): void {
    this.running = false;

    for (const ref of this.eventRefs) {
      this.app.vault.offref(ref);
    }
    this.eventRefs = [];

    if (this.debounceTimer !== undefined) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }

    this.pending.clear();
    this.suppressed.clear();
  }

  /**
   * Update the path being watched (e.g. after `relocateVaultRoot`). Does
   * not re-register listeners — the filter just uses the new path going
   * forward. Clears any pending accumulator from the previous location.
   */
  setDataPath(newDataPath: string): void {
    this.dataPath = normalizeDataPath(newDataPath);
    this.pending.clear();
  }

  /**
   * Mark a logical stream as "about to be written by us" so imminent vault
   * modify events for its shards are treated as echo and ignored. Invoked
   * by `JSONLWriter.appendEvent(s)` before delegating to the router.
   *
   * Accepts either the logical path (e.g. `conversations/conv_abc.jsonl`)
   * or a concrete shard path — both are parsed to `(category, streamId)`.
   */
  suppressLogicalPath(path: string, ttlMs = this.suppressTtlMs): void {
    const parsed = parseStreamPath(stripDataPathPrefix(path, this.dataPath));
    if (!parsed) {
      return;
    }
    const key = suppressionKey(parsed.category, parsed.streamId);
    this.suppressed.set(key, Date.now() + Math.max(0, ttlMs));
  }

  /**
   * Test / manual hook: return whether the watcher is currently running.
   */
  isRunning(): boolean {
    return this.running;
  }

  // --- Internal ------------------------------------------------------------

  private handleFileEvent(file: TAbstractFile | null): void {
    if (!this.running || !file) {
      return;
    }

    // Skip folders — shard paths always end in .jsonl files.
    if (!(file instanceof TFile)) {
      return;
    }
    if (file.extension !== 'jsonl') {
      return;
    }

    const fullPath = normalizePath(file.path);
    const parsed = this.parseRelative(fullPath);
    if (!parsed) {
      return;
    }

    if (this.isSuppressed(parsed.category, parsed.streamId)) {
      return;
    }

    this.recordModified(parsed, fullPath);
    this.scheduleDispatch();
  }

  private recordModified(parsed: ParsedStreamPath, fullPath: string): void {
    const key = `${parsed.category}:${parsed.streamId}`;
    if (!this.pending.has(key)) {
      this.pending.set(key, {
        category: parsed.category,
        streamId: parsed.streamId,
        businessId: parsed.businessId,
        samplePath: fullPath
      });
    }
  }

  private parseRelative(fullVaultPath: string): ParsedStreamPath | null {
    const normalized = normalizePath(fullVaultPath);
    const prefix = `${this.dataPath}/`;
    if (!normalized.startsWith(prefix)) {
      return null;
    }
    const relative = normalized.slice(prefix.length);
    return parseStreamPath(relative);
  }

  private isSuppressed(category: WatchedCategory, streamId: string): boolean {
    const key = suppressionKey(category, streamId);
    const expiry = this.suppressed.get(key);
    if (expiry === undefined) {
      return false;
    }
    if (Date.now() > expiry) {
      this.suppressed.delete(key);
      return false;
    }
    // Consume the suppression so later remote writes aren't silently
    // dropped if Obsidian Sync lands quickly after ours. If the plugin
    // appends multiple events to the same stream in rapid succession,
    // `JSONLWriter` re-suppresses before each append.
    this.suppressed.delete(key);
    return true;
  }

  private scheduleDispatch(): void {
    if (this.debounceTimer !== undefined) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      if (!this.running) {
        return;
      }
      void this.dispatch();
    }, this.debounceMs);
  }

  private async dispatch(): Promise<void> {
    if (this.dispatching) {
      // A dispatch is already running — record that more changes landed
      // so we can fire again after it finishes (with whatever has
      // accumulated in `pending` by then).
      this.dispatchQueued = true;
      return;
    }

    if (this.pending.size === 0) {
      return;
    }

    const modified = Array.from(this.pending.values());
    this.pending.clear();

    this.dispatching = true;
    try {
      await this.onChange(modified);
    } catch (error) {
      console.error('[JsonlVaultWatcher] onChange callback failed:', error);
    } finally {
      this.dispatching = false;
    }

    if (this.dispatchQueued && this.running) {
      this.dispatchQueued = false;
      if (this.pending.size > 0) {
        this.scheduleDispatch();
      }
    }
  }
}

function normalizeDataPath(path: string): string {
  return normalizePath(path).replace(/^\/+|\/+$/g, '');
}

function suppressionKey(category: WatchedCategory, streamId: string): string {
  return `${category}:${streamId}`;
}

/**
 * Accepts either a logical path (no dataPath prefix, e.g.
 * `conversations/conv_abc.jsonl`) or a vault path (with dataPath prefix,
 * e.g. `Nexus/data/conversations/conv_abc/shard-000.jsonl`) and returns
 * the portion relative to `dataPath`. If the input looks logical already,
 * it's returned unchanged.
 */
function stripDataPathPrefix(path: string, dataPath: string): string {
  const normalized = normalizePath(path).replace(/^\/+|\/+$/g, '');
  const prefix = `${dataPath}/`;
  return normalized.startsWith(prefix) ? normalized.slice(prefix.length) : normalized;
}
