/**
 * NotesIndexService unit tests — verifies the SQL issued for schema creation,
 * note upsert + property reconciliation, delete, and conservative prune. SQLite
 * is mocked per the repository test convention (no real DB).
 */

import { NotesIndexService, type NoteIndexInput } from '../../src/database/services/notesIndex/NotesIndexService';
import type { SQLiteCacheManager } from '../../src/database/storage/SQLiteCacheManager';

type MockSqlite = {
  exec: jest.Mock;
  run: jest.Mock;
  query: jest.Mock;
  queryOne: jest.Mock;
};

function createMockSqlite(): MockSqlite {
  return {
    exec: jest.fn().mockResolvedValue(undefined),
    run: jest.fn().mockResolvedValue({ changes: 1, lastInsertRowid: 0 }),
    query: jest.fn().mockResolvedValue([]),
    queryOne: jest.fn().mockResolvedValue({ id: 1 }),
  };
}

function makeService(mock: MockSqlite): NotesIndexService {
  return new NotesIndexService(mock as unknown as SQLiteCacheManager);
}

function sampleInput(overrides: Partial<NoteIndexInput> = {}): NoteIndexInput {
  return {
    path: 'Projects/alpha.md',
    basename: 'alpha',
    folder: 'Projects',
    ext: 'md',
    title: 'Alpha',
    ctime: 1,
    mtime: 2,
    size: 3,
    tags: ['task'],
    links: [],
    frontmatter: { status: 'active', priority: 2, tags: ['x', 'y'] },
    contentHash: 'hash-a',
    ...overrides,
  };
}

const runsMatching = (mock: MockSqlite, needle: string) =>
  mock.run.mock.calls.filter(([sql]) => typeof sql === 'string' && sql.includes(needle));

describe('NotesIndexService', () => {
  it('ensureSchema creates both tables', async () => {
    const mock = createMockSqlite();
    await makeService(mock).ensureSchema();
    const [ddl] = mock.exec.mock.calls[0];
    expect(ddl).toContain('CREATE TABLE IF NOT EXISTS notes');
    expect(ddl).toContain('CREATE TABLE IF NOT EXISTS note_properties');
    expect(ddl).toContain('idx_np_key_text');
  });

  describe('upsertNote', () => {
    it('upserts the note row then replaces its property rows', async () => {
      const mock = createMockSqlite();
      await makeService(mock).upsertNote(sampleInput());

      // 1 note upsert
      expect(runsMatching(mock, 'INSERT INTO notes')).toHaveLength(1);
      // old properties cleared exactly once
      expect(runsMatching(mock, 'DELETE FROM note_properties')).toHaveLength(1);
      // status(1) + priority(1) + tags x,y(2) = 4 property inserts
      expect(runsMatching(mock, 'INSERT INTO note_properties')).toHaveLength(4);
    });

    it('threads the resolved note_id into the property rows', async () => {
      const mock = createMockSqlite();
      mock.queryOne.mockResolvedValue({ id: 42 });
      await makeService(mock).upsertNote(sampleInput());

      for (const [, params] of runsMatching(mock, 'INSERT INTO note_properties')) {
        expect((params as unknown[])[0]).toBe(42);
      }
    });

    it('skips property work when the note row cannot be resolved', async () => {
      const mock = createMockSqlite();
      mock.queryOne.mockResolvedValue(null);
      await makeService(mock).upsertNote(sampleInput());

      expect(runsMatching(mock, 'INSERT INTO notes')).toHaveLength(1);
      expect(runsMatching(mock, 'INSERT INTO note_properties')).toHaveLength(0);
    });
  });

  describe('deleteNote', () => {
    it('removes properties then the note row', async () => {
      const mock = createMockSqlite();
      await makeService(mock).deleteNote('Projects/alpha.md');
      expect(runsMatching(mock, 'DELETE FROM note_properties')).toHaveLength(1);
      expect(runsMatching(mock, 'DELETE FROM notes')).toHaveLength(1);
    });

    it('is a no-op when the note is not indexed', async () => {
      const mock = createMockSqlite();
      mock.queryOne.mockResolvedValue(null);
      await makeService(mock).deleteNote('nope.md');
      expect(mock.run).not.toHaveBeenCalled();
    });
  });

  describe('pruneMissing', () => {
    it('prunes nothing for an empty present-set (failed-walk guard)', async () => {
      const mock = createMockSqlite();
      await makeService(mock).pruneMissing(new Set());
      expect(mock.query).not.toHaveBeenCalled();
      expect(mock.run).not.toHaveBeenCalled();
    });

    it('deletes only notes absent from the present-set', async () => {
      const mock = createMockSqlite();
      mock.query.mockResolvedValueOnce([{ path: 'a.md' }, { path: 'gone.md' }]);
      mock.queryOne.mockResolvedValue({ id: 7 });

      await makeService(mock).pruneMissing(new Set(['a.md']));

      expect(runsMatching(mock, 'DELETE FROM notes')).toHaveLength(1);
    });
  });

  it('count returns the scalar', async () => {
    const mock = createMockSqlite();
    mock.queryOne.mockResolvedValue({ n: 5 });
    expect(await makeService(mock).count()).toBe(5);
  });
});
