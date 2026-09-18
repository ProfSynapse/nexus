import type { CacheBlobStore } from './CacheBlobStore';
import {
  SQLiteWasmBridge,
  SQLiteWasmModule,
  SQLiteDatabaseHandle
} from './SQLiteWasmBridge';

interface SQLitePersistenceServiceOptions {
  blobStore: CacheBlobStore;
  bridge: SQLiteWasmBridge;
}

/**
 * Floor between two cache-size console lines. One a minute is discoverable
 * without being the reason a long index run's console is unreadable.
 */
const SIZE_REPORT_INTERVAL_MS = 60_000;

export class SQLitePersistenceService {
  private readonly bridge: SQLiteWasmBridge;
  private readonly blobStore: CacheBlobStore;
  /** Epoch ms of the last size line, or null when none has been emitted yet. */
  private lastSizeReportAt: number | null = null;

  constructor(options: SQLitePersistenceServiceOptions) {
    this.blobStore = options.blobStore;
    this.bridge = options.bridge;
  }

  async loadDatabase(sqlite3: SQLiteWasmModule, schemaSql: string): Promise<SQLiteDatabaseHandle> {
    try {
      const data = await this.blobStore.read();

      if (!data || data.byteLength === 0) {
        return this.createFreshDatabase(sqlite3, schemaSql);
      }

      const db = this.bridge.deserializeDatabase(sqlite3, new Uint8Array(data));

      try {
        const integrityResult = this.bridge.getIntegrityCheckResult(db);
        if (integrityResult !== 'ok') {
          const integrityMessage = typeof integrityResult === 'string'
            ? integrityResult
            : JSON.stringify(integrityResult) ?? 'unknown';
          throw new Error(`Database integrity check failed: ${integrityMessage}`);
        }
      } catch (integrityError) {
        this.reportCacheRebuild('failed its integrity check', integrityError, data.byteLength);
        return this.recreateCorruptedDatabase(sqlite3, schemaSql);
      }

      return db;
    } catch (error) {
      this.reportCacheRebuild('could not be read or opened', error);
      return this.recreateCorruptedDatabase(sqlite3, schemaSql);
    }
  }

  /**
   * Announce a cache rebuild on the console, loudly enough that a user can find
   * it. This path used to be a bare `catch {}`: the cache was silently
   * discarded and rebuilt, so the only thing anyone ever saw was the downstream
   * symptom — an empty or half-populated view — with nothing in the console
   * tying it back to a corrupt database. Issue #209 stayed undiagnosable for
   * months for exactly that reason.
   *
   * Only reached on a genuine failure. An absent, empty or older-schema cache
   * all take other branches and stay silent, so this line appearing at all
   * means something really was wrong with the blob.
   *
   * Deliberately `console.error` and nothing else. `logger.systemWarn` and
   * `systemLog` are no-ops in this build, so routing through them would
   * re-hide the event. A `Notice` is not raised here: this runs during cache
   * open, well before the workspace is ready, and this class is pure
   * persistence with no Obsidian dependency. `console.error` is what the
   * Obsidian developer console and `obsidian-cli dev:console` read, which is
   * where a bug report gets written from. Note it does NOT reach
   * `obsidian-cli dev:errors`: that surface reports uncaught exceptions, not
   * `console.error` calls - verified live on 2026-08-24 by corrupting a real
   * cache, where this line appeared in `dev:console` while `dev:errors` stayed
   * empty. So the release verification gate does not fail on this line; it is
   * discoverable, not alarming. If a user-facing surface is ever wanted, it
   * belongs to a caller that already owns UI, not here.
   *
   * This reports; it does not decide. Recovery itself is unchanged.
   */
  private reportCacheRebuild(reason: string, cause: unknown, discardedBytes?: number): void {
    const causeText = cause instanceof Error ? cause.message : String(cause);
    const sizeText = discardedBytes === undefined
      ? ''
      : ` Discarded cache was ${discardedBytes} bytes.`;

    console.error(
      `[SQLiteCacheManager] Local cache database ${reason} — discarding it and rebuilding from scratch. ` +
      `Cause: ${causeText}.${sizeText} ` +
      'This rebuild deletes no user data of its own: the SQLite cache is a derived index, and the ' +
      'JSONL event store is the source of truth. Existing data reappears only once that event store ' +
      'is replayed into the new cache — so if anything still looks missing after this, the replay is ' +
      'what to investigate, not the rebuild. ' +
      'If this line appears on every start, the cache is being corrupted again after each rebuild — report it with this line.',
      cause
    );
  }

  async saveDatabase(sqlite3: SQLiteWasmModule, db: SQLiteDatabaseHandle): Promise<void> {
    try {
      const consoleRef = console;
      const originalLog = consoleRef.log;
      consoleRef.log = () => undefined;

      let buffer: ArrayBuffer;
      try {
        buffer = this.bridge.exportDatabase(sqlite3, db);
      } finally {
        consoleRef.log = originalLog;
      }

      await this.blobStore.write(buffer);
      this.reportSavedSize(buffer.byteLength);
    } catch (error) {
      console.error('[SQLiteCacheManager] Failed to save to blob store:', error);
      throw error;
    }
  }

  /**
   * Say how big the thing we just wrote was, once per successful save, rate
   * limited.
   *
   * The number matters because every save allocates roughly three copies of
   * it (the WASM heap original, the exported JS buffer, and the backend's own
   * copy), and a `RangeError: Array buffer allocation failed` during indexing
   * is that figure meeting a fragmented heap. Until now nothing anywhere told a
   * user or a bug report what that figure was; `getStatistics().dbSizeBytes`
   * had to be asked for deliberately, which nobody does before filing.
   *
   * `buffer.byteLength` is the exact size that was written and costs nothing:
   * the buffer is already in hand, no extra read, no extra query, and this runs
   * only after the write has already succeeded, so it cannot change save
   * behaviour or introduce a new failure.
   *
   * `console.warn`, which is not a free choice: `logger.systemWarn` and
   * `systemLog` are no-ops in this build, and the repo's ESLint config enforces
   * the Obsidian plugin guideline that only `warn` and `error` may be used, so
   * `info` and `log` are not available however well they would fit. Between the
   * two that remain, `error` would dress a routine success up as a failure.
   * `warn` also reads correctly once the number is large, which is the only
   * situation in which anyone goes looking for it. Same reasoning as
   * reportCacheRebuild above, one level quieter because nothing has failed.
   *
   * Rate limited because a full index currently saves every ten notes: an
   * 18k-note vault would otherwise put roughly 1800 identical lines in the
   * console and bury everything else. First save always reports, then at most
   * one line per interval.
   */
  private reportSavedSize(byteLength: number): void {
    const now = Date.now();
    if (this.lastSizeReportAt !== null && now - this.lastSizeReportAt < SIZE_REPORT_INTERVAL_MS) {
      return;
    }
    this.lastSizeReportAt = now;

    const megabytes = (byteLength / (1024 * 1024)).toFixed(1);
    console.warn(
      `[SQLiteCacheManager] Saved cache database: ${byteLength} bytes (${megabytes} MB). ` +
      'Each save copies this much out of the WASM heap and again into the backing store, so if ' +
      'saves start failing with an allocation error this is the number that explains it. ' +
      'Reported at most once per minute.'
    );
  }

  async recreateCorruptedDatabase(sqlite3: SQLiteWasmModule, schemaSql: string): Promise<SQLiteDatabaseHandle> {
    try {
      await this.blobStore.remove();
    } catch (removeError) {
      // Non-fatal: the fresh database is written over the old blob below. Still
      // worth saying, because a remove that keeps failing is the difference
      // between "corrupted once" and "corruption we can never clear".
      console.warn(
        '[SQLiteCacheManager] Could not delete the corrupt cache blob before rebuilding it; ' +
        'the rebuild continues and will overwrite it.',
        removeError
      );
    }

    const db = this.createFreshDatabase(sqlite3, schemaSql);
    await this.saveDatabase(sqlite3, db);
    return db;
  }

  createFreshDatabase(sqlite3: SQLiteWasmModule, schemaSql: string): SQLiteDatabaseHandle {
    const db = this.bridge.createMemoryDatabase(sqlite3);
    this.bridge.exec(db, schemaSql);
    return db;
  }
}
