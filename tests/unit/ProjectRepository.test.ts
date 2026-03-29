/**
 * ProjectRepository Unit Tests
 *
 * Tests the project repository CRUD operations with mocked SQLite and JSONL dependencies.
 * Verifies JSONL event sourcing, SQLite cache updates, and cache invalidation.
 *
 * Coverage target: 80%+ (repository with mocks)
 */

import { ProjectRepository } from '../../src/database/repositories/ProjectRepository';
import { RepositoryDependencies } from '../../src/database/repositories/base/BaseRepository';

// ============================================================================
// Mock Dependencies
// ============================================================================

function createMockDeps(): RepositoryDependencies {
  return {
    sqliteCache: {
      queryOne: jest.fn(),
      query: jest.fn(),
      run: jest.fn(),
      transaction: jest.fn((fn: () => Promise<any>) => fn())
    } as any,
    jsonlWriter: {
      appendEvent: jest.fn().mockResolvedValue({ id: 'evt-1', type: 'test', timestamp: Date.now(), deviceId: 'dev-1' })
    } as any,
    queryCache: {
      cachedQuery: jest.fn((_key: string, fn: () => Promise<any>) => fn()),
      invalidateByType: jest.fn(),
      invalidateById: jest.fn(),
      invalidate: jest.fn()
    } as any
  };
}

describe('ProjectRepository', () => {
  let repo: ProjectRepository;
  let deps: RepositoryDependencies;

  beforeEach(() => {
    deps = createMockDeps();
    repo = new ProjectRepository(deps);
  });

  // ============================================================================
  // getById
  // ============================================================================

  describe('getById', () => {
    it('should return project when found', async () => {
      (deps.sqliteCache.queryOne as jest.Mock).mockResolvedValue({
        id: 'proj-1',
        workspaceId: 'ws-1',
        name: 'Test',
        description: null,
        status: 'active',
        created: 1000,
        updated: 1000,
        metadataJson: null
      });

      const result = await repo.getById('proj-1');

      expect(result).not.toBeNull();
      expect(result!.id).toBe('proj-1');
      expect(result!.name).toBe('Test');
      expect(result!.status).toBe('active');
    });

    it('should return null when not found', async () => {
      (deps.sqliteCache.queryOne as jest.Mock).mockResolvedValue(null);

      const result = await repo.getById('nonexistent');
      expect(result).toBeNull();
    });

    it('should parse metadataJson when present', async () => {
      (deps.sqliteCache.queryOne as jest.Mock).mockResolvedValue({
        id: 'proj-1',
        workspaceId: 'ws-1',
        name: 'Test',
        description: null,
        status: 'active',
        created: 1000,
        updated: 1000,
        metadataJson: '{"color":"blue"}'
      });

      const result = await repo.getById('proj-1');
      expect(result!.metadata).toEqual({ color: 'blue' });
    });

    it('should handle malformed metadataJson gracefully', async () => {
      (deps.sqliteCache.queryOne as jest.Mock).mockResolvedValue({
        id: 'proj-1',
        workspaceId: 'ws-1',
        name: 'Test',
        description: null,
        status: 'active',
        created: 1000,
        updated: 1000,
        metadataJson: '{invalid json}'
      });

      const result = await repo.getById('proj-1');
      expect(result!.metadata).toBeUndefined();
    });

    it('should use query cache', async () => {
      (deps.sqliteCache.queryOne as jest.Mock).mockResolvedValue(null);

      await repo.getById('proj-1');

      expect(deps.queryCache.cachedQuery).toHaveBeenCalledWith(
        'project:get:proj-1',
        expect.any(Function),
        undefined
      );
    });
  });

  // ============================================================================
  // getAll
  // ============================================================================

  describe('getAll', () => {
    it('should return paginated results', async () => {
      (deps.sqliteCache.queryOne as jest.Mock).mockResolvedValue({ count: 2 });
      (deps.sqliteCache.query as jest.Mock).mockResolvedValue([
        { id: 'p1', workspaceId: 'ws-1', name: 'P1', description: null, status: 'active', created: 1000, updated: 1000, metadataJson: null },
        { id: 'p2', workspaceId: 'ws-1', name: 'P2', description: null, status: 'active', created: 2000, updated: 2000, metadataJson: null }
      ]);

      const result = await repo.getAll();

      expect(result.items).toHaveLength(2);
      expect(result.totalItems).toBe(2);
    });

    it('should apply pagination params', async () => {
      (deps.sqliteCache.queryOne as jest.Mock).mockResolvedValue({ count: 50 });
      (deps.sqliteCache.query as jest.Mock).mockResolvedValue([]);

      await repo.getAll({ page: 2, pageSize: 10 });

      const queryCall = (deps.sqliteCache.query as jest.Mock).mock.calls[0];
      expect(queryCall[0]).toContain('LIMIT');
      expect(queryCall[0]).toContain('OFFSET');
      expect(queryCall[1]).toContain(10); // pageSize
      expect(queryCall[1]).toContain(20); // offset = page * pageSize
    });
  });

  // ============================================================================
  // create
  // ============================================================================

  describe('create', () => {
    it('should write JSONL event and SQLite row', async () => {
      const result = await repo.create({
        name: 'New Project',
        description: 'Desc',
        workspaceId: 'ws-1'
      });

      expect(result).toBeDefined();
      expect(typeof result).toBe('string');

      // Verify JSONL event
      expect(deps.jsonlWriter.appendEvent).toHaveBeenCalledWith(
        'tasks/tasks_ws-1.jsonl',
        expect.objectContaining({
          type: 'project_created',
          data: expect.objectContaining({
            name: 'New Project',
            description: 'Desc',
            workspaceId: 'ws-1',
            status: 'active'
          })
        })
      );

      // Verify SQLite insert
      expect(deps.sqliteCache.run).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO projects'),
        expect.arrayContaining(['ws-1', 'New Project', 'Desc', 'active'])
      );
    });

    it('should serialize metadata to JSON', async () => {
      await repo.create({
        name: 'P',
        workspaceId: 'ws-1',
        metadata: { key: 'value' }
      });

      const sqliteCall = (deps.sqliteCache.run as jest.Mock).mock.calls[0];
      expect(sqliteCall[1]).toContain('{"key":"value"}');
    });

    it('should invalidate cache after creation', async () => {
      await repo.create({ name: 'P', workspaceId: 'ws-1' });
      expect(deps.queryCache.invalidateByType).toHaveBeenCalledWith('project');
    });

    it('should run operations in a transaction', async () => {
      await repo.create({ name: 'P', workspaceId: 'ws-1' });
      expect(deps.sqliteCache.transaction).toHaveBeenCalled();
    });

    it('should propagate errors', async () => {
      (deps.sqliteCache.run as jest.Mock).mockRejectedValue(new Error('DB error'));

      await expect(
        repo.create({ name: 'P', workspaceId: 'ws-1' })
      ).rejects.toThrow('DB error');
    });
  });

  // ============================================================================
  // update
  // ============================================================================

  describe('update', () => {
    beforeEach(() => {
      // Mock getById (used internally by update to get workspaceId)
      (deps.queryCache.cachedQuery as jest.Mock).mockImplementation(
        (_key: string, fn: () => Promise<any>) => fn()
      );
      (deps.sqliteCache.queryOne as jest.Mock).mockResolvedValue({
        id: 'proj-1',
        workspaceId: 'ws-1',
        name: 'Original',
        description: null,
        status: 'active',
        created: 1000,
        updated: 1000,
        metadataJson: null
      });
    });

    it('should write JSONL event and update SQLite', async () => {
      await repo.update('proj-1', { name: 'Updated' });

      expect(deps.jsonlWriter.appendEvent).toHaveBeenCalledWith(
        'tasks/tasks_ws-1.jsonl',
        expect.objectContaining({
          type: 'project_updated',
          projectId: 'proj-1'
        })
      );

      expect(deps.sqliteCache.run).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE projects SET'),
        expect.arrayContaining(['Updated', 'proj-1'])
      );
    });

    it('should throw if project not found', async () => {
      (deps.sqliteCache.queryOne as jest.Mock).mockResolvedValue(null);

      await expect(repo.update('nonexistent', { name: 'X' })).rejects.toThrow('not found');
    });

    it('should only update provided fields', async () => {
      await repo.update('proj-1', { description: 'New desc' });

      const sqlCall = (deps.sqliteCache.run as jest.Mock).mock.calls[0];
      const sql = sqlCall[0];
      expect(sql).toContain('description = ?');
      expect(sql).not.toContain('name = ?');
    });

    it('should invalidate cache with project ID', async () => {
      await repo.update('proj-1', { name: 'X' });
      expect(deps.queryCache.invalidateById).toHaveBeenCalledWith('project', 'proj-1');
    });
  });

  // ============================================================================
  // delete
  // ============================================================================

  describe('delete', () => {
    beforeEach(() => {
      (deps.queryCache.cachedQuery as jest.Mock).mockImplementation(
        (_key: string, fn: () => Promise<any>) => fn()
      );
      (deps.sqliteCache.queryOne as jest.Mock).mockResolvedValue({
        id: 'proj-1',
        workspaceId: 'ws-1',
        name: 'Project',
        description: null,
        status: 'active',
        created: 1000,
        updated: 1000,
        metadataJson: null
      });
    });

    it('should write delete event and remove from SQLite', async () => {
      await repo.delete('proj-1');

      expect(deps.jsonlWriter.appendEvent).toHaveBeenCalledWith(
        'tasks/tasks_ws-1.jsonl',
        expect.objectContaining({
          type: 'project_deleted',
          projectId: 'proj-1'
        })
      );

      expect(deps.sqliteCache.run).toHaveBeenCalledWith(
        'DELETE FROM projects WHERE id = ?',
        ['proj-1']
      );
    });

    it('should throw if project not found', async () => {
      (deps.sqliteCache.queryOne as jest.Mock).mockResolvedValue(null);

      await expect(repo.delete('nonexistent')).rejects.toThrow('not found');
    });

    it('should invalidate both project and task caches', async () => {
      await repo.delete('proj-1');

      expect(deps.queryCache.invalidateByType).toHaveBeenCalledWith('project');
      expect(deps.queryCache.invalidateByType).toHaveBeenCalledWith('task');
    });
  });

  // ============================================================================
  // count
  // ============================================================================

  describe('count', () => {
    it('should return total count without criteria', async () => {
      (deps.sqliteCache.queryOne as jest.Mock).mockResolvedValue({ count: 42 });

      const result = await repo.count();
      expect(result).toBe(42);
    });

    it('should filter by criteria', async () => {
      (deps.sqliteCache.queryOne as jest.Mock).mockResolvedValue({ count: 5 });

      await repo.count({ workspaceId: 'ws-1', status: 'active' });

      const call = (deps.sqliteCache.queryOne as jest.Mock).mock.calls[0];
      expect(call[0]).toContain('workspaceId = ?');
      expect(call[0]).toContain('status = ?');
      expect(call[1]).toContain('ws-1');
      expect(call[1]).toContain('active');
    });

    it('should return 0 when no results', async () => {
      (deps.sqliteCache.queryOne as jest.Mock).mockResolvedValue(null);

      const result = await repo.count();
      expect(result).toBe(0);
    });
  });

  // ============================================================================
  // getByWorkspace
  // ============================================================================

  describe('getByWorkspace', () => {
    it('should query by workspace ID', async () => {
      (deps.sqliteCache.queryOne as jest.Mock).mockResolvedValue({ count: 1 });
      (deps.sqliteCache.query as jest.Mock).mockResolvedValue([
        { id: 'p1', workspaceId: 'ws-1', name: 'P1', description: null, status: 'active', created: 1000, updated: 1000, metadataJson: null }
      ]);

      const result = await repo.getByWorkspace('ws-1');

      expect(result.items).toHaveLength(1);
      const queryCall = (deps.sqliteCache.query as jest.Mock).mock.calls[0];
      expect(queryCall[0]).toContain('workspaceId = ?');
    });

    it('should filter by status', async () => {
      (deps.sqliteCache.queryOne as jest.Mock).mockResolvedValue({ count: 0 });
      (deps.sqliteCache.query as jest.Mock).mockResolvedValue([]);

      await repo.getByWorkspace('ws-1', { status: 'active' });

      const queryCall = (deps.sqliteCache.query as jest.Mock).mock.calls[0];
      expect(queryCall[0]).toContain('status = ?');
    });
  });

  // ============================================================================
  // getByName
  // ============================================================================

  describe('getByName', () => {
    it('should find project by workspace and name', async () => {
      (deps.sqliteCache.queryOne as jest.Mock).mockResolvedValue({
        id: 'proj-1',
        workspaceId: 'ws-1',
        name: 'Target',
        description: null,
        status: 'active',
        created: 1000,
        updated: 1000,
        metadataJson: null
      });

      const result = await repo.getByName('ws-1', 'Target');

      expect(result).not.toBeNull();
      expect(result!.name).toBe('Target');
    });

    it('should return null when not found', async () => {
      (deps.sqliteCache.queryOne as jest.Mock).mockResolvedValue(null);

      const result = await repo.getByName('ws-1', 'Missing');
      expect(result).toBeNull();
    });
  });

  // ============================================================================
  // rowToEntity (tested indirectly)
  // ============================================================================

  describe('rowToEntity edge cases', () => {
    it('should handle null description', async () => {
      (deps.sqliteCache.queryOne as jest.Mock).mockResolvedValue({
        id: 'p1', workspaceId: 'ws-1', name: 'P', description: null,
        status: 'active', created: 1000, updated: 1000, metadataJson: null
      });

      const result = await repo.getById('p1');
      expect(result!.description).toBeUndefined();
    });

    it('should handle null metadata', async () => {
      (deps.sqliteCache.queryOne as jest.Mock).mockResolvedValue({
        id: 'p1', workspaceId: 'ws-1', name: 'P', description: null,
        status: 'active', created: 1000, updated: 1000, metadataJson: null
      });

      const result = await repo.getById('p1');
      expect(result!.metadata).toBeUndefined();
    });
  });

  // ============================================================================
  // JSONL Replay (F4)
  // ============================================================================
  // JSONL replay (rebuilding SQLite cache from event log) is handled by
  // HybridStorageAdapter, which does not yet process task/project event types
  // (task_created, project_created, etc.). Until replay logic is added for these
  // new event types, JSONL replay testing is not applicable at the repository
  // level. When HybridStorageAdapter is updated to replay task events, add
  // integration tests verifying that a sequence of JSONL events produces the
  // correct SQLite state.
});
