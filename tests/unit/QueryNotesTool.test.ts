/**
 * QueryNotesTool unit tests — the read-only SQL guard and the execute paths
 * (describe, missing/blocked/valid sql, row cap, friendly errors). SQLite is
 * mocked; no real DB.
 */

import { QueryNotesTool, assertReadOnlySelect } from '../../src/agents/searchManager/tools/queryNotes';
import type { QueryNotesParams } from '../../src/agents/searchManager/tools/queryNotes';
import type { SQLiteCacheManager } from '../../src/database/storage/SQLiteCacheManager';

type MockSqlite = { query: jest.Mock; queryOne: jest.Mock };

function makeTool(mock: MockSqlite | null) {
  return new QueryNotesTool(() => (mock as unknown as SQLiteCacheManager) ?? undefined);
}

const run = (tool: QueryNotesTool, params: Partial<QueryNotesParams>) =>
  tool.execute(params as QueryNotesParams);

describe('assertReadOnlySelect', () => {
  it('accepts SELECT and WITH', () => {
    expect(assertReadOnlySelect('SELECT * FROM notes').ok).toBe(true);
    expect(assertReadOnlySelect('WITH x AS (SELECT 1) SELECT * FROM x').ok).toBe(true);
    expect(assertReadOnlySelect('select path from notes;').ok).toBe(true); // trailing ; ok
  });

  it('rejects multiple statements', () => {
    expect(assertReadOnlySelect('SELECT 1; SELECT 2').ok).toBe(false);
    expect(assertReadOnlySelect('SELECT 1; DROP TABLE notes').ok).toBe(false);
  });

  it('rejects non-select leading statements', () => {
    expect(assertReadOnlySelect('UPDATE notes SET x=1').ok).toBe(false);
    expect(assertReadOnlySelect('PRAGMA table_info(notes)').ok).toBe(false);
  });

  it('rejects write/DDL keywords anywhere', () => {
    for (const sql of ['SELECT 1 WHERE 1=1 OR delete', 'SELECT * FROM notes; insert']) {
      expect(assertReadOnlySelect(sql).ok).toBe(false);
    }
  });

  it('does not false-positive on column names containing a keyword', () => {
    // `created` contains "create" but is a distinct word → allowed.
    expect(assertReadOnlySelect('SELECT created FROM notes').ok).toBe(true);
  });
});

describe('QueryNotesTool.execute', () => {
  it('errors when the cache is unavailable', async () => {
    const res = await run(makeTool(null), { sql: 'SELECT 1' });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/unavailable/i);
  });

  it('errors when sql is missing', async () => {
    const mock: MockSqlite = { query: jest.fn(), queryOne: jest.fn() };
    const res = await run(makeTool(mock), {});
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/sql is required/i);
  });

  it('blocks a non-read-only query before touching the DB', async () => {
    const mock: MockSqlite = { query: jest.fn(), queryOne: jest.fn() };
    const res = await run(makeTool(mock), { sql: 'DELETE FROM notes' });
    expect(res.success).toBe(false);
    expect(mock.query).not.toHaveBeenCalled();
  });

  it('runs a valid SELECT and returns columns + rows', async () => {
    const mock: MockSqlite = {
      query: jest.fn().mockResolvedValue([{ path: 'a.md', status: 'active' }]),
      queryOne: jest.fn(),
    };
    const res = await run(makeTool(mock), { sql: 'SELECT path, status FROM notes' });
    expect(res.success).toBe(true);
    const data = res.data as { columns: string[]; rowCount: number; truncated: boolean };
    expect(data.columns).toEqual(['path', 'status']);
    expect(data.rowCount).toBe(1);
    expect(data.truncated).toBe(false);
  });

  it('caps rows at maxRows and flags truncation', async () => {
    const mock: MockSqlite = {
      query: jest.fn().mockResolvedValue([{ p: 1 }, { p: 2 }, { p: 3 }]),
      queryOne: jest.fn(),
    };
    const res = await run(makeTool(mock), { sql: 'SELECT p FROM notes', maxRows: 2 });
    const data = res.data as { rowCount: number; truncated: boolean };
    expect(data.rowCount).toBe(2);
    expect(data.truncated).toBe(true);
  });

  it('describe returns schema, note count, and distinct keys', async () => {
    const mock: MockSqlite = {
      query: jest.fn().mockResolvedValue([{ key: 'due' }, { key: 'status' }]),
      queryOne: jest.fn().mockResolvedValue({ n: 7 }),
    };
    const res = await run(makeTool(mock), { describe: true });
    const schema = res.data as { noteCount: number; distinctKeys: string[] };
    expect(res.success).toBe(true);
    expect(schema.noteCount).toBe(7);
    expect(schema.distinctKeys).toEqual(['due', 'status']);
  });

  it('adds a hint when the table is not built yet', async () => {
    const mock: MockSqlite = {
      query: jest.fn().mockRejectedValue(new Error('no such table: notes')),
      queryOne: jest.fn(),
    };
    const res = await run(makeTool(mock), { sql: 'SELECT * FROM notes' });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/not be built yet/i);
  });
});
