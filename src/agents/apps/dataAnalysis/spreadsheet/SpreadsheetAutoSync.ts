/**
 * SpreadsheetAutoSync — debounced, loop-safe scheduler that turns vault file
 * changes under `<root>/spreadsheets/<id>/*.csv` into a write-back of that
 * workbook. The actual sync work is injected (`sync`), so the scheduling logic
 * (path filtering, debounce, self-write suppression) is pure + unit-testable;
 * the agent wires `sync` to the hucre write-back and the vault `modify` event.
 *
 * Loop safety: the write-back re-projects the mirror (writes CSVs), which would
 * re-fire `modify`. We ignore events for a workbook while its sync is running
 * (catches the re-projection writes) and for a short cooldown afterward (catches
 * trailing events). Because the debounce only fires after edits go quiet, a
 * genuine concurrent edit mid-sync is a non-issue — and if one ever happened it
 * stays in the CSV and is picked up by the next trigger.
 */

export type SyncFn = (workbookId: string) => Promise<void>;

export interface AutoSyncOptions {
  /** Current resolved vault root (e.g. `Nexus`). Read each event (rename-safe). */
  getRoot: () => string;
  sync: SyncFn;
  /** Quiet period after the last edit before syncing. Default 1500ms. */
  debounceMs?: number;
  /** Window after a sync during which re-projection writes are ignored. Default 800ms. */
  cooldownMs?: number;
  setTimer?: (fn: () => void, ms: number) => number;
  clearTimer?: (handle: number) => void;
  now?: () => number;
}

export class SpreadsheetAutoSync {
  private readonly debounceMs: number;
  private readonly cooldownMs: number;
  private readonly setTimer: (fn: () => void, ms: number) => number;
  private readonly clearTimer: (handle: number) => void;
  private readonly now: () => number;

  private readonly timers = new Map<string, number>();
  private readonly suppressedUntil = new Map<string, number>();
  private readonly syncing = new Set<string>();

  constructor(private readonly options: AutoSyncOptions) {
    this.debounceMs = options.debounceMs ?? 1500;
    this.cooldownMs = options.cooldownMs ?? 800;
    this.setTimer = options.setTimer ?? ((fn, ms) => window.setTimeout(fn, ms));
    this.clearTimer = options.clearTimer ?? ((h) => window.clearTimeout(h));
    this.now = options.now ?? Date.now;
  }

  /** Call on every vault `modify`. No-op unless `path` is a mirror CSV shard. */
  notifyModified(path: string): void {
    const workbookId = this.workbookIdOf(path);
    if (!workbookId) {
      return;
    }
    if (this.syncing.has(workbookId)) {
      return; // mid-sync — ignore (catches our own re-projection writes)
    }
    if (this.now() < (this.suppressedUntil.get(workbookId) ?? 0)) {
      return; // cooldown — ignore trailing re-projection writes
    }
    this.schedule(workbookId);
  }

  private schedule(workbookId: string): void {
    const existing = this.timers.get(workbookId);
    if (existing) {
      this.clearTimer(existing);
    }
    this.timers.set(workbookId, this.setTimer(() => void this.run(workbookId), this.debounceMs));
  }

  private async run(workbookId: string): Promise<void> {
    this.timers.delete(workbookId);
    if (this.syncing.has(workbookId)) {
      return;
    }
    this.syncing.add(workbookId);
    try {
      await this.options.sync(workbookId);
    } catch {
      // Failures surface via the sync impl (Notice); don't crash the listener.
    } finally {
      this.syncing.delete(workbookId);
      this.suppressedUntil.set(workbookId, this.now() + this.cooldownMs);
    }
  }

  /** Map a vault path to its workbook id, or null if it isn't a mirror CSV shard. */
  workbookIdOf(path: string): string | null {
    const prefix = `${this.options.getRoot()}/spreadsheets/`;
    const norm = path.replace(/^\/+/, '');
    if (!norm.startsWith(prefix)) {
      return null;
    }
    const rest = norm.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash < 0) {
      return null;
    }
    const workbookId = rest.slice(0, slash);
    const relFile = rest.slice(slash + 1);
    if (!relFile.endsWith('.csv')) {
      return null; // ignore manifest.json and other files
    }
    if (relFile.startsWith('_archive/') || relFile.includes('/_archive/')) {
      return null; // ignore snapshot shards
    }
    return workbookId;
  }

  /** Cancel any pending timers (call on unload). */
  dispose(): void {
    for (const handle of this.timers.values()) {
      this.clearTimer(handle);
    }
    this.timers.clear();
  }
}
