/**
 * SkillSyncWatcher — automatic, debounced skill import + index refresh.
 *
 * Located at: src/agents/apps/skills/services/SkillSyncWatcher.ts
 * Removes the need to call `syncSkills` by hand: it watches for skill-folder
 * changes and (debounced) imports provider dotfolders into the mirror, then
 * refreshes the SQLite index from the mirror. Started by SkillsAgent.onload(),
 * stopped by SkillsAgent.onunload().
 *
 * Coverage / platform reality:
 *   - The MIRROR (`<root>/skills/…`) is a normal, non-hidden vault path, so the
 *     documented `vault.on('create'|'modify'|'delete'|'rename')` events fire for
 *     it on BOTH desktop and mobile.
 *   - The SOURCE provider dotfolders (`<vault>/.<provider>/skills/…`) are HIDDEN
 *     and are NOT indexed by Obsidian's vault, so the documented events NEVER
 *     fire for them. To make edits to those event-driven we also subscribe to
 *     the undocumented `vault.on('raw')` event, which the desktop
 *     FileSystemAdapter emits for any path under the vault dir (including
 *     dotfolders). On mobile `raw` is silent — there, hidden-source changes are
 *     picked up by the on-load sync instead. Both legs are best-effort.
 *
 * Scope: import + index-refresh ONLY. Sync-BACK (mirror → origin dotfolder)
 * writes to the user's real provider folders and stays explicit (the syncSkills
 * tool / updateSkill), so automatic activity can never clobber a source of truth.
 *
 * Loop-safety: import skips byte-identical writes (hash-gated), so the mirror
 * writes it makes settle after one no-op cycle; `_archive/` churn is ignored.
 *
 * Mirrors the debounce shape of src/database/sync/JsonlVaultWatcher.ts.
 */

import type { App, EventRef, TAbstractFile, Vault } from 'obsidian';
import type { SkillsRuntime } from './SkillsContext';
import { SkillSyncService } from './SkillSyncService';

/** Vault augmented with the undocumented `raw` event (desktop file-watcher). */
type VaultWithRaw = Vault & {
  on(name: 'raw', callback: (path: string) => void): EventRef;
};

export class SkillSyncWatcher {
  private readonly eventRefs: EventRef[] = [];
  private debounceTimer?: number;
  private running = false;
  private pending = false;
  private disposed = false;
  /** Bounded retries for the initial sync while storage is still warming up. */
  private initialRetries = 5;

  constructor(
    private readonly app: App,
    /** Resolved at FIRE time (not start time) so a not-yet-ready store self-heals. */
    private readonly resolveRuntime: () => SkillsRuntime | null,
    private readonly debounceMs = 2000
  ) {}

  /** Subscribe to vault events and kick off the initial catch-up sync. */
  start(): void {
    const vault = this.app.vault;

    // Documented events — fire for the (non-hidden) mirror on desktop + mobile.
    this.eventRefs.push(
      vault.on('create', (f: TAbstractFile) => this.onPath(f.path)),
      vault.on('modify', (f: TAbstractFile) => this.onPath(f.path)),
      vault.on('delete', (f: TAbstractFile) => this.onPath(f.path)),
      vault.on('rename', (f: TAbstractFile, oldPath: string) => {
        this.onPath(f.path);
        this.onPath(oldPath);
      })
    );

    // Undocumented `raw` event — desktop-only coverage for hidden provider
    // dotfolders. Guarded: absent/throwing registration is fine (mobile).
    try {
      this.eventRefs.push(
        (vault as VaultWithRaw).on('raw', (path: string) => this.onPath(path))
      );
    } catch {
      /* `raw` unsupported on this platform — mirror events + on-load sync cover it. */
    }

    // Catch up on anything that changed while the app was closed.
    this.schedule();
  }

  /** Unsubscribe and cancel any pending run. */
  stop(): void {
    this.disposed = true;
    if (this.debounceTimer !== undefined) {
      window.clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }
    for (const ref of this.eventRefs) {
      this.app.vault.offref(ref);
    }
    this.eventRefs.length = 0;
  }

  private onPath(path: string): void {
    if (this.disposed || !path) {
      return;
    }
    if (this.isSkillPath(path)) {
      this.schedule();
    }
  }

  /**
   * True for paths under the mirror root or under any `.<provider>/skills/` source
   * dotfolder. `_archive/` snapshots are excluded so our own archive writes don't
   * re-trigger the watcher.
   */
  private isSkillPath(path: string): boolean {
    const norm = path.replace(/\\/g, '/');
    if (norm.includes('/_archive/') || norm.includes('/_archive')) {
      return false;
    }
    const rt = this.resolveRuntime();
    if (rt && (norm === rt.skillsRoot || norm.startsWith(`${rt.skillsRoot}/`))) {
      return true;
    }
    // `.<provider>/skills/...` at (or below) the vault root.
    return /(^|\/)\.[^/]+\/skills(\/|$)/.test(norm);
  }

  private schedule(): void {
    if (this.disposed) {
      return;
    }
    if (this.debounceTimer !== undefined) {
      window.clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = window.setTimeout(() => {
      this.debounceTimer = undefined;
      void this.run();
    }, this.debounceMs);
  }

  private async run(): Promise<void> {
    if (this.disposed) {
      return;
    }
    // Coalesce overlapping runs — re-run once after the in-flight one finishes.
    if (this.running) {
      this.pending = true;
      return;
    }

    const rt = this.resolveRuntime();
    if (!rt) {
      // Storage not ready yet — retry the initial catch-up a bounded number of times.
      if (this.initialRetries > 0) {
        this.initialRetries -= 1;
        this.schedule();
      }
      return;
    }
    this.initialRetries = 0;

    this.running = true;
    try {
      const sync = new SkillSyncService(rt.vaultAdapter, rt.skillsRoot, rt.index);
      // import: provider dotfolders → mirror (hash-gated, archive-then-replace).
      await sync.import();
      // refresh the SQLite index from the (now-current) mirror.
      const parsed = await rt.scanner.scan();
      await rt.index.syncFromScan(parsed);
    } catch {
      /* best-effort — a later event (or the next edit) retries. */
    } finally {
      this.running = false;
      if (this.pending && !this.disposed) {
        this.pending = false;
        this.schedule();
      }
    }
  }
}
