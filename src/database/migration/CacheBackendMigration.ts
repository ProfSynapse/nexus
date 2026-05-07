import type { DataAdapter } from 'obsidian';
import { Notice } from 'obsidian';

import type { CacheBlobStore } from '../storage/CacheBlobStore';

/**
 * Conflict-copy patterns for the one-shot janitor (architecture spec §6.2).
 * Ordered with the literal `cache.db` first so callers can identify it; the
 * janitor explicitly defers deletion of the literal until conflict siblings
 * are gone, so on partial failure the next migration run can still read it.
 */
export const CONFLICT_COPY_PATTERNS: ReadonlyArray<RegExp> = [
  /^cache\.db$/,                                           // literal: cache.db
  /^cache \d+\.db$/,                                       // iCloud:  cache 2.db
  /^cache \(\d+\)\.db$/,                                   // generic: cache (1).db
  /^cache_\d+\.db$/,                                       // underscore-numeric: cache_2.db, cache_3.db
  /^cache_conf\d*\.db$/,                                   // sync helper: cache_conf.db, cache_conf2.db
  /^cache\[Conflict\].*\.db$/,                             // suffix:  cache[Conflict].db
  /^cache\.db \(Conflict\)$/i,                             // OneDrive: cache.db (Conflict)
  /^cache.*conflicted copy \d{4}-\d{2}-\d{2}\.db$/i,       // Dropbox: cache (Pinky's conflicted copy 2026-01-15).db
  /^cache \(Case Conflict\)\.db$/i,                        // case-fold: cache (Case Conflict).db
  /^cache\.db\.[a-f0-9]{6,}$/i                             // hash-suffix: cache.db.a1b2c3
];

const LITERAL_CACHE_PATTERN = CONFLICT_COPY_PATTERNS[0];

export type MigrationOutcome =
  | 'not_needed'
  | 'verified'
  | 'failed'
  | 'mobile_bypass';

export interface CacheBackendState {
  /** Which backend is authoritative. 'file' = vault.adapter; 'idb' = IndexedDB. */
  backend: 'file' | 'idb';
  migrationState: 'not_needed' | 'pending' | 'verified' | 'failed';
  migratedAt?: number;
  lastError?: string;
}

export interface JanitorReport {
  removed: string[];
  failed: { path: string; error: string }[];
}

export interface MigrationResult {
  outcome: MigrationOutcome;
  bytesMigrated?: number;
  totalMs?: number;
  janitor?: JanitorReport;
  error?: string;
}

export interface CacheBackendMigrationOptions {
  /** Vault adapter for legacy reads + janitor sweeps. Required even on desktop. */
  adapter: DataAdapter;
  /** Absolute vault-relative path of the legacy `cache.db` file. */
  legacyDbPath: string;
  /** Plugin data root (`${dataRoot}`); the janitor scans this dir non-recursively. */
  pluginDataRoot: string;
  /** Destination blob store. On desktop this is the IDB-backed impl. */
  blobStore: CacheBlobStore;
  /** Persisted migration-state reader/writer. */
  stateAccessor: CacheBackendStateAccessor;
  /**
   * Mobile bypass — when true, runIfNeeded returns `mobile_bypass` immediately
   * and persists `{ backend: 'file', migrationState: 'not_needed' }`.
   */
  isMobile: boolean;
  /**
   * Whether to surface user-facing Notice messages. Default true; tests pass
   * false to keep stdout quiet.
   */
  showNotices?: boolean;
}

export interface CacheBackendStateAccessor {
  read(): Promise<CacheBackendState | undefined>;
  write(state: CacheBackendState): Promise<void>;
}

/**
 * Foreground-blocking cache-backend migration (spec §5).
 *
 * State machine:
 *
 *   DETECT → READ_LEGACY → WRITE_IDB → VERIFY → MARK_VERIFIED → DONE
 *                                                       │
 *                                                       └─ JANITOR (fire-and-forget)
 *
 * Idempotent on partial failure: if MARK_VERIFIED fails, the next launch's
 * DETECT re-runs READ_LEGACY → WRITE_IDB (overwriting with the same bytes) →
 * VERIFY → MARK_VERIFIED. The janitor deletes the literal `cache.db` LAST so
 * a partially-failed migration always has the legacy file to read from.
 */
export class CacheBackendMigration {
  constructor(private readonly opts: CacheBackendMigrationOptions) {}

  async runIfNeeded(): Promise<MigrationResult> {
    if (this.opts.isMobile) {
      await this.opts.stateAccessor.write({
        backend: 'file',
        migrationState: 'not_needed'
      });
      return { outcome: 'mobile_bypass' };
    }

    const persisted = await this.opts.stateAccessor.read();
    if (persisted?.migrationState === 'verified' && persisted.backend === 'idb') {
      return { outcome: 'verified' };
    }

    const legacyExists = await this.adapterExists(this.opts.legacyDbPath);
    if (!legacyExists) {
      // Fresh desktop install — no legacy file to migrate. Mark verified
      // immediately so subsequent boots short-circuit.
      await this.opts.stateAccessor.write({
        backend: 'idb',
        migrationState: 'verified',
        migratedAt: Date.now()
      });
      return { outcome: 'not_needed' };
    }

    return this.runStateMachine();
  }

  private async runStateMachine(): Promise<MigrationResult> {
    const startedAt = Date.now();
    const notice = this.opts.showNotices !== false
      ? new Notice('Migrating Nexus cache to local storage…', 0)
      : null;

    try {
      const legacyBytes = await this.readLegacy();
      this.log(`READ_LEGACY ok (bytes=${legacyBytes.byteLength})`);

      await this.writeIdb(legacyBytes);
      this.log(`WRITE_IDB ok (bytes=${legacyBytes.byteLength})`);

      const verified = await this.verifyIdb(legacyBytes.byteLength);
      if (!verified) {
        // One-shot retry per spec §5.2.
        await this.writeIdb(legacyBytes);
        const retryOk = await this.verifyIdb(legacyBytes.byteLength);
        if (!retryOk) throw new Error('VERIFY failed after retry');
      }
      this.log('VERIFY ok');

      await this.opts.stateAccessor.write({
        backend: 'idb',
        migrationState: 'verified',
        migratedAt: Date.now()
      });
      const totalMs = Date.now() - startedAt;
      this.log(`MARK_VERIFIED ok (totalMs=${totalMs})`);

      // Janitor runs fire-and-forget — failure here NEVER blocks startup
      // (spec §5.4). Tests await this.janitorPromise via the returned result.
      const janitorPromise = this.runJanitor();
      const result: MigrationResult = {
        outcome: 'verified',
        bytesMigrated: legacyBytes.byteLength,
        totalMs
      };

      // Attach so callers (tests) can await it; production code ignores it.
      void janitorPromise.then(report => {
        result.janitor = report;
        this.log(
          `JANITOR done (removed=${report.removed.length}, failed=${report.failed.length})`
        );
      }).catch(err => {
        this.log(`JANITOR error (continuing): ${err instanceof Error ? err.message : String(err)}`);
      });

      if (notice) {
        notice.hide();
        if (this.opts.showNotices !== false) {
          new Notice('Nexus cache migration complete.', 3000);
        }
      }

      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(`FAILED: ${message}`);
      await this.opts.stateAccessor.write({
        backend: 'file',
        migrationState: 'failed',
        lastError: message
      });
      if (notice) {
        notice.hide();
        if (this.opts.showNotices !== false) {
          new Notice(
            'Nexus cache migration failed — falling back to a fresh rebuild from synced data.',
            8000
          );
        }
      }
      return { outcome: 'failed', error: message };
    }
  }

  private async readLegacy(): Promise<ArrayBuffer> {
    const data = await this.opts.adapter.readBinary(this.opts.legacyDbPath);
    if (data.byteLength === 0) {
      throw new Error('Legacy cache.db read returned 0 bytes');
    }
    return data;
  }

  private async writeIdb(buffer: ArrayBuffer): Promise<void> {
    await this.opts.blobStore.write(buffer);
  }

  private async verifyIdb(expectedBytes: number): Promise<boolean> {
    const meta = await this.opts.blobStore.getMetadata();
    if (meta && meta.size === expectedBytes) return true;
    // Fallback: read full bytes and compare length. Slower but reliable
    // against backends with weak metadata.
    const data = await this.opts.blobStore.read();
    const ok = data !== null && data.byteLength === expectedBytes;
    if (!ok) {
      // Diagnostic only — does not change return semantics. Captures all three
      // numbers so a length-mismatch failure is greppable in the user's
      // console and the one-shot retry path in runStateMachine() still owns
      // the recovery decision.
      console.warn('[CacheBackendMigration] verifyIdb mismatch', {
        expectedBytes,
        metaSize: meta ? meta.size : null,
        readBytes: data ? data.byteLength : null
      });
    }
    return ok;
  }

  /**
   * Janitor sweep — pattern-match cache.db siblings in pluginDataRoot
   * (non-recursive), delete conflict copies first, then the literal
   * `cache.db` last. Per-file failure logs and continues (spec §6.4).
   */
  async runJanitor(): Promise<JanitorReport> {
    const report: JanitorReport = { removed: [], failed: [] };
    const root = this.opts.pluginDataRoot;
    let listing: { files: string[] };
    try {
      listing = await this.opts.adapter.list(root);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      report.failed.push({ path: root, error: `list failed: ${message}` });
      return report;
    }

    const candidates = listing.files
      .filter(p => typeof p === 'string')
      .map(p => ({ full: p, base: basenameOf(p) }))
      .filter(({ base }) => CONFLICT_COPY_PATTERNS.some(re => re.test(base)));

    // Conflict siblings first (anything not the literal cache.db).
    const literal = candidates.filter(c => LITERAL_CACHE_PATTERN.test(c.base));
    const conflicts = candidates.filter(c => !LITERAL_CACHE_PATTERN.test(c.base));

    for (const c of conflicts) {
      try {
        await this.opts.adapter.remove(c.full);
        report.removed.push(c.full);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        report.failed.push({ path: c.full, error: message });
      }
    }
    // Literal cache.db last (preserves recovery if conflicts deletion crashed).
    for (const c of literal) {
      try {
        await this.opts.adapter.remove(c.full);
        report.removed.push(c.full);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        report.failed.push({ path: c.full, error: message });
      }
    }

    return report;
  }

  private async adapterExists(path: string): Promise<boolean> {
    try {
      return await this.opts.adapter.exists(path);
    } catch {
      return false;
    }
  }

  private log(line: string): void {
    console.warn(`[CacheBlobStore.Migration] ${line}`);
  }
}

function basenameOf(path: string): string {
  const idx = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return idx >= 0 ? path.slice(idx + 1) : path;
}
