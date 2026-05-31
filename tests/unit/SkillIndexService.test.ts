/**
 * SkillIndexService Unit Tests
 *
 * Verifies the SQLite index over the `skills` table: the owned-state-preserving
 * UPSERT, recency-ordered listing with archive/search filters, name lookup, the
 * load-recency stamp, and the snake→camel row mapping. SQLite is mocked with
 * jest.fn() per the repository test convention — no real DB.
 */

import { SkillIndexService } from '../../src/agents/apps/skills/services/SkillIndexService';
import type { SQLiteCacheManager } from '../../src/database/storage/SQLiteCacheManager';
import type { ParsedSkillFolder, SkillRecord } from '../../src/agents/apps/skills/types';

type MockSqlite = {
  queryOne: jest.Mock;
  query: jest.Mock;
  run: jest.Mock;
};

function createMockSqlite(): MockSqlite {
  return {
    queryOne: jest.fn(),
    query: jest.fn().mockResolvedValue([]),
    run: jest.fn().mockResolvedValue({ changes: 1, lastInsertRowid: 0 }),
  };
}

function makeService(mock: MockSqlite): SkillIndexService {
  return new SkillIndexService(mock as unknown as SQLiteCacheManager);
}

const sampleRow = {
  id: 'skill-1',
  provider: 'claude',
  name: 'essay-editor',
  description: 'Edit essays for clarity.',
  vault_path: 'Nexus/skills/claude/essay-editor',
  origin_path: null,
  content_hash: 'abc123',
  is_archived: 1,
  last_loaded_at: null,
  created: 100,
  updated: 200,
};

describe('SkillIndexService', () => {
  describe('syncFromScan', () => {
    it('issues the owned-state-preserving UPSERT once per parsed skill', async () => {
      const mock = createMockSqlite();
      const service = makeService(mock);

      const parsed: ParsedSkillFolder[] = [
        {
          provider: 'claude',
          name: 'essay-editor',
          description: 'Edit essays.',
          vaultPath: 'Nexus/skills/claude/essay-editor',
          contentHash: 'hash-a',
        },
        {
          provider: 'codex',
          name: 'pr-reviewer',
          description: 'Review PRs.',
          vaultPath: 'Nexus/skills/codex/pr-reviewer',
          originPath: '/.codex/skills/pr-reviewer',
          contentHash: 'hash-b',
        },
      ];

      await service.syncFromScan(parsed);

      expect(mock.run).toHaveBeenCalledTimes(2);

      const [sql] = mock.run.mock.calls[0];
      expect(sql).toContain('INSERT INTO skills');
      expect(sql).toContain('ON CONFLICT(provider, name) DO UPDATE SET');
      // Owned state must NOT appear in the SET clause.
      const setClause = sql.slice(sql.indexOf('DO UPDATE SET'));
      expect(setClause).not.toContain('is_archived');
      expect(setClause).not.toContain('last_loaded_at');
      expect(setClause).toContain('description=excluded.description');
      expect(setClause).toContain('content_hash=excluded.content_hash');

      // First row params: id, provider, name, description, vaultPath, originPath(null), hash, now, now
      const params = mock.run.mock.calls[0][1] as unknown[];
      expect(params).toHaveLength(9);
      expect(params[1]).toBe('claude');
      expect(params[2]).toBe('essay-editor');
      expect(params[3]).toBe('Edit essays.');
      expect(params[4]).toBe('Nexus/skills/claude/essay-editor');
      expect(params[5]).toBeNull(); // originPath undefined → null
      expect(params[6]).toBe('hash-a');
      expect(typeof params[7]).toBe('number'); // created
      expect(typeof params[8]).toBe('number'); // updated

      // Second row carries originPath through.
      const params2 = mock.run.mock.calls[1][1] as unknown[];
      expect(params2[5]).toBe('/.codex/skills/pr-reviewer');
    });

    it('runs nothing for an empty scan', async () => {
      const mock = createMockSqlite();
      await makeService(mock).syncFromScan([]);
      expect(mock.run).not.toHaveBeenCalled();
    });
  });

  describe('list', () => {
    it('excludes archived skills by default (is_archived = 0 in WHERE)', async () => {
      const mock = createMockSqlite();
      await makeService(mock).list();
      const [sql] = mock.query.mock.calls[0];
      expect(sql).toContain('WHERE is_archived = 0');
      expect(sql).toContain('ORDER BY last_loaded_at DESC, name ASC');
    });

    it('omits the archived filter when includeArchived is true', async () => {
      const mock = createMockSqlite();
      await makeService(mock).list({ includeArchived: true });
      const [sql] = mock.query.mock.calls[0];
      expect(sql).not.toContain('is_archived');
      expect(sql).toContain('ORDER BY last_loaded_at DESC, name ASC');
    });

    it('builds a LIKE search clause with wrapped params', async () => {
      const mock = createMockSqlite();
      await makeService(mock).list({ search: 'essay' });
      const [sql, params] = mock.query.mock.calls[0];
      expect(sql).toContain('(name LIKE ? OR description LIKE ?)');
      expect(params).toEqual(['%essay%', '%essay%']);
    });

    it('combines archived filter and search with AND', async () => {
      const mock = createMockSqlite();
      await makeService(mock).list({ search: 'essay', includeArchived: false });
      const [sql, params] = mock.query.mock.calls[0];
      expect(sql).toContain('WHERE is_archived = 0 AND (name LIKE ? OR description LIKE ?)');
      expect(params).toEqual(['%essay%', '%essay%']);
    });

    it('maps a row from snake_case to a SkillRecord', async () => {
      const mock = createMockSqlite();
      mock.query.mockResolvedValueOnce([sampleRow]);
      const result = await makeService(mock).list({ includeArchived: true });
      expect(result).toHaveLength(1);
      const record: SkillRecord = result[0];
      expect(record.isArchived).toBe(true); // 1 → true
      expect(record.lastLoadedAt).toBeUndefined(); // null → undefined
      expect(record.originPath).toBeUndefined(); // null → undefined
      expect(record.vaultPath).toBe('Nexus/skills/claude/essay-editor');
      expect(record.provider).toBe('claude');
      expect(record.name).toBe('essay-editor');
      expect(record.contentHash).toBe('abc123');
    });
  });

  describe('findByName', () => {
    it('queries by name only when no provider is given', async () => {
      const mock = createMockSqlite();
      await makeService(mock).findByName('essay-editor');
      const [sql, params] = mock.query.mock.calls[0];
      expect(sql).toContain('WHERE name = ?');
      expect(sql).not.toContain('provider = ?');
      expect(sql).toContain('ORDER BY last_loaded_at DESC');
      expect(params).toEqual(['essay-editor']);
    });

    it('adds a provider clause when given', async () => {
      const mock = createMockSqlite();
      await makeService(mock).findByName('essay-editor', 'claude');
      const [sql, params] = mock.query.mock.calls[0];
      expect(sql).toContain('WHERE name = ? AND provider = ?');
      expect(params).toEqual(['essay-editor', 'claude']);
    });
  });

  describe('touchLoaded', () => {
    it('runs the recency UPDATE for the given id', async () => {
      const mock = createMockSqlite();
      await makeService(mock).touchLoaded('skill-1');
      const [sql, params] = mock.run.mock.calls[0];
      expect(sql).toBe('UPDATE skills SET last_loaded_at = ?, updated = ? WHERE id = ?');
      expect(params).toHaveLength(3);
      expect(typeof params[0]).toBe('number');
      expect(typeof params[1]).toBe('number');
      expect(params[2]).toBe('skill-1');
    });
  });
});
