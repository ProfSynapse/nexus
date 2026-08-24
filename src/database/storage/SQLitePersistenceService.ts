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

export class SQLitePersistenceService {
  private readonly bridge: SQLiteWasmBridge;
  private readonly blobStore: CacheBlobStore;

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
    } catch (error) {
      console.error('[SQLiteCacheManager] Failed to save to blob store:', error);
      throw error;
    }
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
