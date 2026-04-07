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
    sqlite3_last_insert_rowid(db: SQLiteDatabaseHandle): number | bigint;
    SQLITE_DESERIALIZE_FREEONCLOSE: number;
    SQLITE_DESERIALIZE_RESIZEABLE: number;
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

  deserializeDatabase(module: SQLiteWasmModule, data: Uint8Array): SQLiteDatabaseHandle {
    const ptr = module.wasm.allocFromTypedArray(data);
    const db = this.createMemoryDatabase(module);
    const rc = module.capi.sqlite3_deserialize(
      db,
      'main',
      ptr,
      data.byteLength,
      data.byteLength,
      module.capi.SQLITE_DESERIALIZE_FREEONCLOSE |
      module.capi.SQLITE_DESERIALIZE_RESIZEABLE
    );

    if (rc !== 0) {
      throw new Error(`sqlite3_deserialize failed with code ${rc}`);
    }

    return db;
  }

  exportDatabase(module: SQLiteWasmModule, db: SQLiteDatabaseHandle): ArrayBuffer {
    return module.capi.sqlite3_js_db_export(db).buffer;
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
