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

  it('allows a write keyword inside a string literal value', () => {
    expect(assertReadOnlySelect("SELECT path FROM notes WHERE status = 'delete'").ok).toBe(true);
    expect(assertReadOnlySelect("SELECT path FROM notes WHERE title = 'drop everything'").ok).toBe(true);
  });

  it('allows a leading comment before SELECT', () => {
    expect(assertReadOnlySelect('-- find active\nSELECT path FROM notes').ok).toBe(true);
  });

  it('still blocks a DML keyword outside any literal (WITH ... DELETE)', () => {
    expect(assertReadOnlySelect('WITH x AS (SELECT 1) DELETE FROM notes').ok).toBe(false);
  });

  it('allows the replace() string function but blocks REPLACE INTO', () => {
    expect(assertReadOnlySelect("SELECT replace(title, 'a', 'b') FROM notes").ok).toBe(true);
    expect(assertReadOnlySelect('REPLACE INTO notes VALUES (1)').ok).toBe(false);
    expect(assertReadOnlySelect("SELECT 1 WHERE 1=1; replace into notes values(1)").ok).toBe(false);
  });

  it('allows a parenthesized compound read', () => {
    expect(assertReadOnlySelect('(SELECT 1) UNION (SELECT 2)').ok).toBe(true);
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

  it('wraps the query in an outer LIMIT (maxRows+1) to bound runaway reads', async () => {
    const mock: MockSqlite = { query: jest.fn().mockResolvedValue([]), queryOne: jest.fn() };
    await run(makeTool(mock), { sql: 'SELECT * FROM notes', maxRows: 10 });
    const [sqlArg, bindArg] = mock.query.mock.calls[0];
    expect(sqlArg).toMatch(/^SELECT \* FROM \(/i);
    expect(sqlArg).toMatch(/\) LIMIT \?$/);
    expect(bindArg).toEqual([11]); // maxRows + 1
  });

  it('strips a trailing semicolon before nesting the query', async () => {
    const mock: MockSqlite = { query: jest.fn().mockResolvedValue([]), queryOne: jest.fn() };
    await run(makeTool(mock), { sql: 'SELECT 1;' });
    const [sqlArg] = mock.query.mock.calls[0];
    expect(sqlArg).toBe('SELECT * FROM (SELECT 1) LIMIT ?');
  });

  it('coerces boolean bind params to 1/0 and appends the row cap', async () => {
    const mock: MockSqlite = { query: jest.fn().mockResolvedValue([]), queryOne: jest.fn() };
    await run(makeTool(mock), { sql: 'SELECT * FROM notes WHERE a = ? AND b = ?', params: [true, false] });
    const bindArg = mock.query.mock.calls[0][1];
    expect(bindArg).toEqual([1, 0, 501]); // booleans coerced, default maxRows(500)+1
  });

  it('describe returns schema, note count, and distinct keys', async () => {
    const mock: MockSqlite = {
      query: jest.fn().mockResolvedValue([{ key: 'due' }, { key: 'status' }]),
      queryOne: jest.fn().mockResolvedValue({ n: 7 }),
    };
    const res = await run(makeTool(mock), { describe: true });
    const schema = res.data as { noteCount: number; distinctKeys: string[]; built: boolean; status: string };
    expect(res.success).toBe(true);
    expect(schema.noteCount).toBe(7);
    expect(schema.distinctKeys).toEqual(['due', 'status']);
    expect(schema.built).toBe(true);
    expect(schema.status).toBe('ready');
  });

  it('describe reports built:false when the index tables do not exist yet', async () => {
    const mock: MockSqlite = {
      query: jest.fn().mockRejectedValue(new Error('no such table: notes')),
      queryOne: jest.fn().mockRejectedValue(new Error('no such table: notes')),
    };
    const res = await run(makeTool(mock), { describe: true });
    const schema = res.data as { built: boolean; status: string; noteCount: number };
    expect(res.success).toBe(true);
    expect(schema.built).toBe(false);
    expect(schema.status).toMatch(/building/i);
    expect(schema.noteCount).toBe(0);
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
