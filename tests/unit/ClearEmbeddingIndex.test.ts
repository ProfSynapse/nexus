/**
 * "Delete index" removes embedding vectors and nothing else.
 *
 * Before this there was no delete path at all: "Rebuild cache" drops only the
 * conversation vectors, and note and trace vectors survived everything
 * (SQLiteMaintenanceService.clearAllData). The settings fold needs a way to
 * free that space while semantic search is off.
 *
 * What is real: SQLiteMaintenanceService and the schema SQL. What is faked:
 * the SQLite bridge, which records the statements instead of running them.
 * This repo's Jest lanes have no runnable sqlite-vec (the bundled WASM build
 * refuses to start under Node), so the statements are checked for shape and
 * the recreated vec0 DDL is checked against the schema it has to match. The
 * real round trip is an in-app step (see the plan's Phase 4 verification).
 *
 * If the delete forgot a table, touched a non-embedding table, ran outside a
 * transaction, or recreated a vec0 table with a different shape than the
 * schema creates, this goes red.
 */

import type { App } from 'obsidian';

jest.mock('@dao-xyz/sqlite3-vec/wasm', () => jest.fn(), { virtual: true });

import {
  SQLiteMaintenanceService,
  EMBEDDING_VECTOR_TABLES,
  EMBEDDING_METADATA_TABLES
} from '../../src/database/storage/SQLiteMaintenanceService';
import type { SQLiteWasmBridge, SQLiteDatabaseHandle } from '../../src/database/storage/SQLiteWasmBridge';
import { SCHEMA_SQL } from '../../src/database/schema/schema';

/** Every table that holds embedding data, by name, in the current schema. */
const ALL_EMBEDDING_TABLES = [
  'note_embeddings',
  'embedding_metadata',
  'trace_embeddings',
  'trace_embedding_metadata',
  'conversation_embeddings',
  'conversation_embedding_metadata',
  'embedding_backfill_state'
];

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').replace(/\(\s+/g, '(').replace(/\s+\)/g, ')').trim();
}

function schemaVecDefinition(table: string): string {
  const match = new RegExp(
    `CREATE VIRTUAL TABLE IF NOT EXISTS ${table} USING vec0\\(([^)]*)\\)`
  ).exec(SCHEMA_SQL);
  if (!match) {
    throw new Error(`schema.ts has no vec0 definition for ${table}`);
  }
  return normalizeSql(match[0]);
}

function createService() {
  const statements: string[] = [];
  let inTransaction = false;
  const outsideTransaction: string[] = [];

  const bridge = {
    exec: (_db: SQLiteDatabaseHandle, sql: string) => {
      statements.push(sql);
      if (!inTransaction) outsideTransaction.push(sql);
    }
  } as unknown as SQLiteWasmBridge;

  const service = new SQLiteMaintenanceService({
    app: {} as App,
    dbPath: 'cache.db',
    bridge,
    getDb: () => ({}) as SQLiteDatabaseHandle,
    queryOne: async () => null,
    transaction: async <T>(fn: () => Promise<T>): Promise<T> => {
      inTransaction = true;
      try {
        return await fn();
      } finally {
        inTransaction = false;
      }
    }
  });

  return { service, statements, outsideTransaction };
}

describe('clearEmbeddingIndex', () => {
  it('empties all seven embedding tables inside one transaction', async () => {
    const { service, statements, outsideTransaction } = createService();

    await service.clearEmbeddingIndex();

    expect(outsideTransaction).toEqual([]);
    for (const table of ALL_EMBEDDING_TABLES) {
      const emptied = statements.some(sql =>
        sql === `DELETE FROM ${table}` || sql === `DROP TABLE IF EXISTS ${table}`
      );
      expect({ table, emptied }).toEqual({ table, emptied: true });
    }
  });

  it('recreates every dropped vec0 table with the schema definition, so it accepts inserts again', async () => {
    const { service, statements } = createService();

    await service.clearEmbeddingIndex();

    const dropped = statements
      .filter(sql => sql.startsWith('DROP TABLE IF EXISTS '))
      .map(sql => sql.slice('DROP TABLE IF EXISTS '.length));
    expect(dropped.sort()).toEqual([...EMBEDDING_VECTOR_TABLES].sort());

    for (const table of dropped) {
      const dropAt = statements.indexOf(`DROP TABLE IF EXISTS ${table}`);
      const create = statements.findIndex(
        (sql, index) => index > dropAt && sql.startsWith(`CREATE VIRTUAL TABLE IF NOT EXISTS ${table} `)
      );
      expect(create).toBeGreaterThan(dropAt);
      expect(normalizeSql(statements[create])).toBe(schemaVecDefinition(table));
    }
  });

  it('touches no table that is not embedding data', async () => {
    const { service, statements } = createService();

    await service.clearEmbeddingIndex();

    const touched = new Set(
      statements.map(sql => /(?:FROM|EXISTS)\s+(\w+)/.exec(sql)?.[1]).filter(Boolean)
    );
    for (const table of touched) {
      expect(ALL_EMBEDDING_TABLES).toContain(table);
    }
    expect([...EMBEDDING_METADATA_TABLES].every(table => touched.has(table))).toBe(true);
  });

  it('names every embedding table the schema defines', () => {
    // A new embedding table added to schema.ts without being added here would
    // survive "Delete index". The schema is the authority.
    const vecTables = [...SCHEMA_SQL.matchAll(/CREATE VIRTUAL TABLE IF NOT EXISTS (\w+) USING vec0/g)]
      .map(match => match[1]);
    expect([...EMBEDDING_VECTOR_TABLES].sort()).toEqual(vecTables.sort());

    const metadataTables = [...SCHEMA_SQL.matchAll(/CREATE TABLE IF NOT EXISTS (\w*embedding\w*)/g)]
      .map(match => match[1]);
    expect([...EMBEDDING_METADATA_TABLES].sort()).toEqual(metadataTables.sort());
  });
});
