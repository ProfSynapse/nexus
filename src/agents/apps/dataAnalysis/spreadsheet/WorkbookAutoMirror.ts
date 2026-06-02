/**
 * WorkbookAutoMirror — debounced, loop-safe scheduler that turns vault changes
 * to a source `.xlsx`/`.xlsm` into an automatic CSV-package mirror under
 * `<root>/spreadsheets/<id>/`. The FORWARD sibling of SpreadsheetAutoSync (which
 * is the reverse leg: mirror CSV edits → write back to the workbook).
 *
 * Removes the need to call `mirrorWorkbook` by hand: drop or edit an Excel file
 * anywhere in the vault and it is auto-projected into editable CSV shards. The
 * actual mirror work is injected (`mirror`), so the scheduling logic (path
 * filtering, debounce, self-write suppression) is pure + unit-testable.
 *
 * Loop safety (forward ⇄ reverse): WorkbookMirrorService.generate is
 * hash-idempotent and the reverse write-back refreshes the manifest's
 * `sourceHash` to the freshly-written bytes. So the `.xlsx` `modify` that a
 * write-back emits re-enters here, computes the SAME hash, and short-circuits to
 * a no-op — no CSV rewrite, no oscillation. The `syncing` guard + post-run
 * cooldown additionally coalesce the burst of events around a write-back.
 *
 * Paths under the mirror itself (`<root>/spreadsheets/…`) and `_archive/`
 * snapshots are never treated as sources.
 */

export type MirrorFn = (path: string) => Promise<void>;

export interface AutoMirrorOptions {
  /** Current resolved vault root (e.g. `Nexus`). Read each event (rename-safe). */
  getRoot: () => string;
  mirror: MirrorFn;
  /** Quiet period after the last change before mirroring. Default 1500ms. */
  debounceMs?: number;
  /** Window after a mirror during which re-entrant writes are ignored. Default 800ms. */
  cooldownMs?: number;
  setTimer?: (fn: () => void, ms: number) => number;
  clearTimer?: (handle: number) => void;
  now?: () => number;
}

export class WorkbookAutoMirror {
  private readonly debounceMs: number;
  private readonly cooldownMs: number;
  private readonly setTimer: (fn: () => void, ms: number) => number;
  private readonly clearTimer: (handle: number) => void;
  private readonly now: () => number;

  private readonly timers = new Map<string, number>();
  private readonly suppressedUntil = new Map<string, number>();
  private readonly mirroring = new Set<string>();

  constructor(private readonly options: AutoMirrorOptions) {
    this.debounceMs = options.debounceMs ?? 1500;
    this.cooldownMs = options.cooldownMs ?? 800;
    this.setTimer = options.setTimer ?? ((fn, ms) => window.setTimeout(fn, ms));
    this.clearTimer = options.clearTimer ?? ((h) => window.clearTimeout(h));
    this.now = options.now ?? Date.now;
  }

  /** Call on every vault `create`/`modify`. No-op unless `path` is a source workbook. */
  notifyChanged(path: string): void {
    if (!this.isWorkbookPath(path)) {
      return;
    }
    if (this.mirroring.has(path)) {
      return; // mid-mirror — ignore our own re-read churn
    }
    if (this.now() < (this.suppressedUntil.get(path) ?? 0)) {
      return; // cooldown — ignore the write-back's `.xlsx` modify
    }
    this.schedule(path);
  }

  /**
   * True for a source `.xlsx`/`.xlsm` that lives OUTSIDE the mirror tree. The
   * mirror's own folder and `_archive/` snapshots are never re-mirrored.
   */
  isWorkbookPath(path: string): boolean {
    const norm = path.replace(/^\/+/, '');
    if (!/\.(xlsx|xlsm)$/i.test(norm)) {
      return false;
    }
    if (norm.startsWith(`${this.options.getRoot()}/spreadsheets/`)) {
      return false; // don't mirror the mirror
    }
    if (norm.includes('/_archive/')) {
      return false;
    }
    return true;
  }

  private schedule(path: string): void {
    const existing = this.timers.get(path);
    if (existing) {
      this.clearTimer(existing);
    }
    this.timers.set(path, this.setTimer(() => void this.run(path), this.debounceMs));
  }

  private async run(path: string): Promise<void> {
    this.timers.delete(path);
    if (this.mirroring.has(path)) {
      return;
    }
    this.mirroring.add(path);
    try {
      await this.options.mirror(path);
    } catch {
      // Failures surface via the mirror impl (Notice); don't crash the listener.
    } finally {
      this.mirroring.delete(path);
      this.suppressedUntil.set(path, this.now() + this.cooldownMs);
    }
  }

  /** Cancel any pending timers (call on unload). */
  dispose(): void {
    for (const handle of this.timers.values()) {
      this.clearTimer(handle);
    }
    this.timers.clear();
  }
}
