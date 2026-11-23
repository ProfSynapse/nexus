import sqlite3InitModule from '@dao-xyz/sqlite3-vec/wasm';

import type { QueryParams } from '../repositories/base/BaseRepository';
import type { RunResult } from '../interfaces/IStorageBackend';

export interface SQLiteStatement {
  bind(params: QueryParams): void;
  step(): boolean;
  stepReset(): void;
  get(mode: unknown): unknown;
  finalize(): void;
}

export interface SQLiteDatabaseHandle {
  exec(sql: string): void;
  prepare(sql: string): SQLiteStatement;
  close(): void;
  changes(): number;
  selectValue(sql: string): unknown;
}

export interface SQLiteWasmModule {
  oo1: {
    DB: new (filename: string) => SQLiteDatabaseHandle;
  };
  wasm: {
    allocFromTypedArray(data: Uint8Array): number;
    alloc(size: number): number;
    dealloc(ptr: number): void;
    heap8u(): Uint8Array;
    peek64(ptr: number): bigint;
  };
  capi: {
    sqlite3_deserialize(
      db: SQLiteDatabaseHandle,
      schema: string,
      ptr: number,
      size: number,
      maxSize: number,
      flags: number
    ): number;
    sqlite3_js_db_export(db: SQLiteDatabaseHandle): { buffer: ArrayBuffer };
    sqlite3_serialize(db: SQLiteDatabaseHandle, schema: string, sizePtr: number, flags: number): number;
    sqlite3_get_autocommit(db: SQLiteDatabaseHandle): number;
    sqlite3_last_insert_rowid(db: SQLiteDatabaseHandle): number | bigint;
    SQLITE_DESERIALIZE_FREEONCLOSE: number;
    SQLITE_DESERIALIZE_RESIZEABLE: number;
    SQLITE_SERIALIZE_NOCOPY: number;
  };
}

interface SQLiteInitOptions {
  instantiateWasm?: (
    imports: WebAssembly.Imports,
    successCallback: (instance: WebAssembly.Instance) => void
  ) => Record<string, never>;
  print?: (message: string) => void;
  printErr?: (message: string) => void;
}

type SQLiteModuleFactory = (options?: SQLiteInitOptions) => Promise<SQLiteWasmModule>;

const sqliteModuleFactory = sqlite3InitModule as unknown as SQLiteModuleFactory;

/**
 * Free space allocated behind a deserialized database, as a share of its size,
 * clamped to [MIN, MAX].
 *
 * A deserialized database lives in one heap buffer exactly its own size, and
 * the first write that needs one more page makes SQLite double that buffer
 * (memdbEnlarge), holding old and new at once while it copies. For a 314 MiB
 * cache that is ~940 MiB of WASM heap from a single new page. Allocating the
 * buffer with room to spare lets ordinary growth land in that room, so a
 * session doubles only after it has written more than the slack.
 */
const DESERIALIZE_SLACK_SHARE = 1 / 8;
const DESERIALIZE_SLACK_MIN_BYTES = 8 * 1024 * 1024;
const DESERIALIZE_SLACK_MAX_BYTES = 64 * 1024 * 1024;

export function deserializeSlackBytes(size: number): number {
  return Math.min(
    DESERIALIZE_SLACK_MAX_BYTES,
    Math.max(DESERIALIZE_SLACK_MIN_BYTES, Math.ceil(size * DESERIALIZE_SLACK_SHARE))
  );
}

export class SQLiteWasmBridge {
  async initializeModule(wasmBinary: ArrayBuffer): Promise<SQLiteWasmModule> {
    const initOptions: SQLiteInitOptions = {
      instantiateWasm: (imports, successCallback) => {
        WebAssembly.instantiate(wasmBinary, imports)
          .then(result => {
            successCallback(result.instance);
          })
          .catch(err => {
            console.error('[SQLiteCacheManager] WASM instantiation failed:', err);
          });
        return {};
      },
      print: () => undefined,
      printErr: (msg: string) => console.error('[SQLite]', msg)
    };

    return sqliteModuleFactory(initOptions);
  }

  createMemoryDatabase(module: SQLiteWasmModule): SQLiteDatabaseHandle {
    return new module.oo1.DB(':memory:');
  }

  /**
   * Open `data` as an in-memory database, in a heap buffer with slack behind it
   * (see DESERIALIZE_SLACK_SHARE). The slack is never part of the database:
   * exports and serializations cover the database's own size only.
   */
  deserializeDatabase(module: SQLiteWasmModule, data: Uint8Array): SQLiteDatabaseHandle {
    const size = data.byteLength;
    let capacity = size + deserializeSlackBytes(size);
    let ptr: number;
    try {
      ptr = module.wasm.alloc(capacity);
    } catch {
      // The slack is an optimisation; a heap that cannot spare it still opens
      // the database the way it always did.
      capacity = size;
      ptr = module.wasm.alloc(capacity);
    }
    module.wasm.heap8u().set(data, ptr);
    return this.adoptBuffer(module, ptr, size, capacity);
  }

  /**
   * Export the whole database as bytes outside the WASM heap.
   *
   * A deserialized database is already one contiguous buffer, so it is copied
   * straight out of the heap (SQLITE_SERIALIZE_NOCOPY) instead of through
   * sqlite3_js_db_export, which first allocates a second full-size copy inside
   * the heap - the allocation that fails with SQLITE_NOMEM once the database
   * is around a quarter of the heap. Same bytes either way. A database that
   * was never deserialized (a fresh :memory: one) has no such buffer; NOCOPY
   * returns null for it and the old export is used.
   */
  exportDatabase(module: SQLiteWasmModule, db: SQLiteDatabaseHandle): ArrayBuffer {
    const view = this.serializeInPlace(module, db);
    if (view === null) {
      return module.capi.sqlite3_js_db_export(db).buffer;
    }
    return view.heap.slice(view.ptr, view.ptr + view.size).buffer;
  }

  /** Whether `db` is outside any transaction (sqlite3_get_autocommit). */
  isAutocommit(module: SQLiteWasmModule, db: SQLiteDatabaseHandle): boolean {
    return module.capi.sqlite3_get_autocommit(db) !== 0;
  }

  private serializeInPlace(
    module: SQLiteWasmModule,
    db: SQLiteDatabaseHandle
  ): { heap: Uint8Array; ptr: number; size: number } | null {
    const sizePtr = module.wasm.alloc(8);
    let ptr: number;
    let size: number;
    try {
      ptr = module.capi.sqlite3_serialize(db, 'main', sizePtr, module.capi.SQLITE_SERIALIZE_NOCOPY);
      size = Number(module.wasm.peek64(sizePtr));
    } finally {
      module.wasm.dealloc(sizePtr);
    }
    if (!ptr) {
      return null;
    }
    const heap = module.wasm.heap8u();
    if (size < 0 || ptr + size > heap.byteLength) {
      throw new Error(`In-place serialization returned a buffer outside the WASM heap (ptr ${ptr}, size ${size})`);
    }
    return { heap, ptr, size };
  }

  private adoptBuffer(module: SQLiteWasmModule, ptr: number, size: number, capacity: number): SQLiteDatabaseHandle {
    const db = this.createMemoryDatabase(module);
    const rc = module.capi.sqlite3_deserialize(
      db,
      'main',
      ptr,
      size,
      capacity,
      module.capi.SQLITE_DESERIALIZE_FREEONCLOSE |
      module.capi.SQLITE_DESERIALIZE_RESIZEABLE
    );

    if (rc !== 0) {
      throw new Error(`sqlite3_deserialize failed with code ${rc}`);
    }

    return db;
  }

  exec(db: SQLiteDatabaseHandle, sql: string): void {
    db.exec(sql);
  }

  executeStatement(db: SQLiteDatabaseHandle, sql: string, params?: QueryParams): void {
    const stmt = db.prepare(sql);
    try {
      if (params?.length) {
        stmt.bind(params);
      }
      stmt.step();
    } finally {
      stmt.finalize();
    }
  }

  collectValues(db: SQLiteDatabaseHandle, sql: string): unknown[][] {
    const stmt = db.prepare(sql);
    const results: unknown[][] = [];
    try {
      while (stmt.step()) {
        results.push(stmt.get([]) as unknown[]);
      }
      return results;
    } finally {
      stmt.finalize();
    }
  }

  query<T>(db: SQLiteDatabaseHandle, sql: string, params?: QueryParams): T[] {
    const stmt = db.prepare(sql);
    try {
      if (params?.length) {
        stmt.bind(params);
      }
      const results: T[] = [];
      while (stmt.step()) {
        results.push(stmt.get({}) as T);
      }
      return results;
    } finally {
      stmt.finalize();
    }
  }

  queryOne<T>(db: SQLiteDatabaseHandle, sql: string, params?: QueryParams): T | null {
    const stmt = db.prepare(sql);
    try {
      if (params?.length) {
        stmt.bind(params);
      }
      if (!stmt.step()) {
        return null;
      }
      return stmt.get({}) as T;
    } finally {
      stmt.finalize();
    }
  }

  run(db: SQLiteDatabaseHandle, module: SQLiteWasmModule, sql: string, params?: QueryParams): RunResult {
    const stmt = db.prepare(sql);
    try {
      if (params?.length) {
        stmt.bind(params);
      }
      stmt.stepReset();
    } finally {
      stmt.finalize();
    }

    const rawRowId = module.capi.sqlite3_last_insert_rowid(db);
    return {
      changes: db.changes(),
      lastInsertRowid: typeof rawRowId === 'bigint' ? Number(rawRowId) : rawRowId
    };
  }

  getIntegrityCheckResult(db: SQLiteDatabaseHandle): unknown {
    return db.selectValue('PRAGMA integrity_check');
  }

  close(db: SQLiteDatabaseHandle): void {
    db.close();
  }
}
