/**
 * TaskRepository Unit Tests
 *
 * Tests the task repository CRUD, dependency management, note links, and DAG queries
 * with mocked SQLite and JSONL dependencies.
 *
 * Coverage target: 80%+ (repository with mocks)
 */

import { TaskRepository } from '../../src/database/repositories/TaskRepository';
import { RepositoryDependencies } from '../../src/database/repositories/base/BaseRepository';

// ============================================================================
// Mock Dependencies
// ============================================================================

function createMockDeps(): RepositoryDependencies {
  return {
    sqliteCache: {
      queryOne: jest.fn(),
      query: jest.fn().mockResolvedValue([]),
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

const sampleRow = {
  id: 'task-1',
  projectId: 'proj-1',
  workspaceId: 'ws-1',
  parentTaskId: null,
  title: 'Test Task',
  description: null,
  status: 'todo',
  priority: 'medium',
  created: 1000,
  updated: 1000,
  completedAt: null,
  dueDate: null,
  assignee: null,
  tagsJson: null,
  metadataJson: null
};

describe('TaskRepository', () => {
  let repo: TaskRepository;
  let deps: RepositoryDependencies;

  beforeEach(() => {
    deps = createMockDeps();
    repo = new TaskRepository(deps);
  });

  // ============================================================================
  // getById
  // ============================================================================

  describe('getById', () => {
    it('should return task when found', async () => {
      (deps.sqliteCache.queryOne as jest.Mock).mockResolvedValue({ ...sampleRow });

      const result = await repo.getById('task-1');

      expect(result).not.toBeNull();
      expect(result!.id).toBe('task-1');
      expect(result!.title).toBe('Test Task');
      expect(result!.status).toBe('todo');
      expect(result!.priority).toBe('medium');
    });

    it('should return null when not found', async () => {
      (deps.sqliteCache.queryOne as jest.Mock).mockResolvedValue(null);

      const result = await repo.getById('nonexistent');
      expect(result).toBeNull();
    });

    it('should parse tagsJson', async () => {
      (deps.sqliteCache.queryOne as jest.Mock).mockResolvedValue({
        ...sampleRow,
        tagsJson: '["bug","urgent"]'
      });

      const result = await repo.getById('task-1');
      expect(result!.tags).toEqual(['bug', 'urgent']);
    });

    it('should parse metadataJson', async () => {
      (deps.sqliteCache.queryOne as jest.Mock).mockResolvedValue({
        ...sampleRow,
        metadataJson: '{"priority_score":42}'
      });

      const result = await repo.getById('task-1');
      expect(result!.metadata).toEqual({ priority_score: 42 });
    });

    it('should handle malformed tagsJson gracefully', async () => {
      (deps.sqliteCache.queryOne as jest.Mock).mockResolvedValue({
        ...sampleRow,
        tagsJson: 'not-json'
      });

      const result = await repo.getById('task-1');
      expect(result!.tags).toBeUndefined();
    });

    it('should handle malformed metadataJson gracefully', async () => {
      (deps.sqliteCache.queryOne as jest.Mock).mockResolvedValue({
        ...sampleRow,
        metadataJson: '{bad}'
      });

      const result = await repo.getById('task-1');
      expect(result!.metadata).toBeUndefined();
    });

    it('should convert null optional fields to undefined', async () => {
      (deps.sqliteCache.queryOne as jest.Mock).mockResolvedValue({ ...sampleRow });

      const result = await repo.getById('task-1');
      expect(result!.parentTaskId).toBeUndefined();
      expect(result!.description).toBeUndefined();
      expect(result!.completedAt).toBeUndefined();
      expect(result!.dueDate).toBeUndefined();
      expect(result!.assignee).toBeUndefined();
    });
  });

  // ============================================================================
  // create
  // ============================================================================

  describe('create', () => {
    it('should write JSONL event and SQLite row', async () => {
      const result = await repo.create({
        projectId: 'proj-1',
        workspaceId: 'ws-1',
        title: 'New Task',
        description: 'Desc'
      });

      expect(result).toBeDefined();
      expect(typeof result).toBe('string');

      // Verify JSONL event
      expect(deps.jsonlWriter.appendEvent).toHaveBeenCalledWith(
        'tasks/tasks_ws-1.jsonl',
        expect.objectContaining({
          type: 'task_created',
          data: expect.objectContaining({
            projectId: 'proj-1',
            workspaceId: 'ws-1',
            title: 'New Task',
            status: 'todo',
            priority: 'medium'
          })
        })
      );

      // Verify SQLite insert
      expect(deps.sqliteCache.run).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO tasks'),
        expect.arrayContaining(['proj-1', 'ws-1', 'New Task'])
      );
    });

    it('should default priority to medium', async () => {
      await repo.create({
        projectId: 'proj-1',
        workspaceId: 'ws-1',
        title: 'Task'
      });

      const sqlCall = (deps.sqliteCache.run as jest.Mock).mock.calls[0];
      expect(sqlCall[1]).toContain('medium');
    });

    it('should serialize tags to JSON', async () => {
      await repo.create({
        projectId: 'proj-1',
        workspaceId: 'ws-1',
        title: 'Task',
        tags: ['a', 'b']
      });

      const sqlCall = (deps.sqliteCache.run as jest.Mock).mock.calls[0];
      expect(sqlCall[1]).toContain('["a","b"]');
    });

    it('should invalidate cache after creation', async () => {
      await repo.create({ projectId: 'proj-1', workspaceId: 'ws-1', title: 'T' });
      expect(deps.queryCache.invalidateByType).toHaveBeenCalledWith('task');
    });

    it('should propagate errors', async () => {
      (deps.sqliteCache.run as jest.Mock).mockRejectedValue(new Error('DB error'));

      await expect(
        repo.create({ projectId: 'proj-1', workspaceId: 'ws-1', title: 'T' })
      ).rejects.toThrow('DB error');
    });
  });

  // ============================================================================
  // update
  // ============================================================================

  describe('update', () => {
    beforeEach(() => {
      (deps.sqliteCache.queryOne as jest.Mock).mockResolvedValue({ ...sampleRow });
    });

    it('should write JSONL event and update SQLite', async () => {
      await repo.update('task-1', { title: 'Updated', status: 'in_progress' });

      expect(deps.jsonlWriter.appendEvent).toHaveBeenCalledWith(
        'tasks/tasks_ws-1.jsonl',
        expect.objectContaining({
          type: 'task_updated',
          taskId: 'task-1'
        })
      );

      const sqlCall = (deps.sqliteCache.run as jest.Mock).mock.calls[0];
      expect(sqlCall[0]).toContain('UPDATE tasks SET');
      expect(sqlCall[0]).toContain('title = ?');
      expect(sqlCall[0]).toContain('status = ?');
    });

    it('should throw if task not found', async () => {
      (deps.sqliteCache.queryOne as jest.Mock).mockResolvedValue(null);

      await expect(repo.update('nonexistent', { title: 'X' })).rejects.toThrow('not found');
    });

    it('should only include provided fields in update', async () => {
      await repo.update('task-1', { description: 'New desc' });

      const sqlCall = (deps.sqliteCache.run as jest.Mock).mock.calls[0];
      expect(sqlCall[0]).toContain('description = ?');
      expect(sqlCall[0]).not.toContain('title = ?');
      expect(sqlCall[0]).not.toContain('status = ?');
    });

    it('should handle completedAt update', async () => {
      await repo.update('task-1', { completedAt: 5000 });

      const sqlCall = (deps.sqliteCache.run as jest.Mock).mock.calls[0];
      expect(sqlCall[0]).toContain('completedAt = ?');
      expect(sqlCall[1]).toContain(5000);
    });

    it('should handle projectId update (for moves)', async () => {
      await repo.update('task-1', { projectId: 'proj-2' });

      const sqlCall = (deps.sqliteCache.run as jest.Mock).mock.calls[0];
      expect(sqlCall[0]).toContain('projectId = ?');
    });

    it('should handle parentTaskId update', async () => {
      await repo.update('task-1', { parentTaskId: 'parent-1' });

      const sqlCall = (deps.sqliteCache.run as jest.Mock).mock.calls[0];
      expect(sqlCall[0]).toContain('parentTaskId = ?');
    });

    it('should invalidate cache with task ID', async () => {
      await repo.update('task-1', { title: 'X' });
      expect(deps.queryCache.invalidateById).toHaveBeenCalledWith('task', 'task-1');
    });
  });

  // ============================================================================
  // delete
  // ============================================================================

  describe('delete', () => {
    beforeEach(() => {
      (deps.sqliteCache.queryOne as jest.Mock).mockResolvedValue({ ...sampleRow });
    });

    it('should write delete event and remove from SQLite', async () => {
      await repo.delete('task-1');

      expect(deps.jsonlWriter.appendEvent).toHaveBeenCalledWith(
        'tasks/tasks_ws-1.jsonl',
        expect.objectContaining({
          type: 'task_deleted',
          taskId: 'task-1'
        })
      );

      expect(deps.sqliteCache.run).toHaveBeenCalledWith(
        'DELETE FROM tasks WHERE id = ?',
        ['task-1']
      );
    });

    it('should throw if task not found', async () => {
      (deps.sqliteCache.queryOne as jest.Mock).mockResolvedValue(null);

      await expect(repo.delete('nonexistent')).rejects.toThrow('not found');
    });

    it('should invalidate full task cache', async () => {
      await repo.delete('task-1');
      expect(deps.queryCache.invalidateByType).toHaveBeenCalledWith('task');
    });
  });

  // ============================================================================
  // count
  // ============================================================================

  describe('count', () => {
    it('should count all tasks', async () => {
      (deps.sqliteCache.queryOne as jest.Mock).mockResolvedValue({ count: 10 });

      const result = await repo.count();
      expect(result).toBe(10);
    });

    it('should count with criteria', async () => {
      (deps.sqliteCache.queryOne as jest.Mock).mockResolvedValue({ count: 3 });

      await repo.count({ projectId: 'proj-1', status: 'todo' });

      const call = (deps.sqliteCache.queryOne as jest.Mock).mock.calls[0];
      expect(call[0]).toContain('projectId = ?');
      expect(call[0]).toContain('status = ?');
    });

    it('should support all criteria fields', async () => {
      (deps.sqliteCache.queryOne as jest.Mock).mockResolvedValue({ count: 1 });

      await repo.count({
        projectId: 'proj-1',
        workspaceId: 'ws-1',
        status: 'todo',
        priority: 'high',
        assignee: 'alice'
      });

      const call = (deps.sqliteCache.queryOne as jest.Mock).mock.calls[0];
      expect(call[0]).toContain('projectId = ?');
      expect(call[0]).toContain('workspaceId = ?');
      expect(call[0]).toContain('status = ?');
      expect(call[0]).toContain('priority = ?');
      expect(call[0]).toContain('assignee = ?');
    });
  });

  // ============================================================================
  // getByProject
  // ============================================================================

  describe('getByProject', () => {
    it('should query by project ID', async () => {
      (deps.sqliteCache.queryOne as jest.Mock).mockResolvedValue({ count: 1 });
      (deps.sqliteCache.query as jest.Mock).mockResolvedValue([{ ...sampleRow }]);

      const result = await repo.getByProject('proj-1');

      expect(result.items).toHaveLength(1);
      const queryCall = (deps.sqliteCache.query as jest.Mock).mock.calls[0];
      expect(queryCall[0]).toContain('t.projectId = ?');
    });

    it('should filter by status', async () => {
      (deps.sqliteCache.queryOne as jest.Mock).mockResolvedValue({ count: 0 });
      (deps.sqliteCache.query as jest.Mock).mockResolvedValue([]);

      await repo.getByProject('proj-1', { status: 'done' });

      const queryCall = (deps.sqliteCache.query as jest.Mock).mock.calls[0];
      expect(queryCall[0]).toContain('t.status = ?');
    });

    it('should filter by priority', async () => {
      (deps.sqliteCache.queryOne as jest.Mock).mockResolvedValue({ count: 0 });
      (deps.sqliteCache.query as jest.Mock).mockResolvedValue([]);

      await repo.getByProject('proj-1', { priority: 'critical' });

      const queryCall = (deps.sqliteCache.query as jest.Mock).mock.calls[0];
      expect(queryCall[0]).toContain('t.priority = ?');
    });

    it('should filter by assignee', async () => {
      (deps.sqliteCache.queryOne as jest.Mock).mockResolvedValue({ count: 0 });
      (deps.sqliteCache.query as jest.Mock).mockResolvedValue([]);

      await repo.getByProject('proj-1', { assignee: 'alice' });

      const queryCall = (deps.sqliteCache.query as jest.Mock).mock.calls[0];
      expect(queryCall[0]).toContain('t.assignee = ?');
    });

    it('should filter by parentTaskId', async () => {
      (deps.sqliteCache.queryOne as jest.Mock).mockResolvedValue({ count: 0 });
      (deps.sqliteCache.query as jest.Mock).mockResolvedValue([]);

      await repo.getByProject('proj-1', { parentTaskId: 'parent-1' });

      const queryCall = (deps.sqliteCache.query as jest.Mock).mock.calls[0];
      expect(queryCall[0]).toContain('t.parentTaskId = ?');
    });

    it('should exclude subtasks when includeSubtasks is false', async () => {
      (deps.sqliteCache.queryOne as jest.Mock).mockResolvedValue({ count: 0 });
      (deps.sqliteCache.query as jest.Mock).mockResolvedValue([]);

      await repo.getByProject('proj-1', { includeSubtasks: false });

      const queryCall = (deps.sqliteCache.query as jest.Mock).mock.calls[0];
      expect(queryCall[0]).toContain('t.parentTaskId IS NULL');
    });
  });

  // ============================================================================
  // getByWorkspace
  // ============================================================================

  describe('getByWorkspace', () => {
    it('should query by workspace ID', async () => {
      (deps.sqliteCache.queryOne as jest.Mock).mockResolvedValue({ count: 0 });
      (deps.sqliteCache.query as jest.Mock).mockResolvedValue([]);

      await repo.getByWorkspace('ws-1');

      const queryCall = (deps.sqliteCache.query as jest.Mock).mock.calls[0];
      expect(queryCall[0]).toContain('t.workspaceId = ?');
    });

    it('should apply filters', async () => {
      (deps.sqliteCache.queryOne as jest.Mock).mockResolvedValue({ count: 0 });
      (deps.sqliteCache.query as jest.Mock).mockResolvedValue([]);

      await repo.getByWorkspace('ws-1', { status: 'todo', priority: 'high', assignee: 'bob' });

      const queryCall = (deps.sqliteCache.query as jest.Mock).mock.calls[0];
      expect(queryCall[0]).toContain('t.status = ?');
      expect(queryCall[0]).toContain('t.priority = ?');
      expect(queryCall[0]).toContain('t.assignee = ?');
    });
  });

  // ============================================================================
  // getByStatus
  // ============================================================================

  describe('getByStatus', () => {
    it('should query tasks by project and status', async () => {
      (deps.sqliteCache.query as jest.Mock).mockResolvedValue([{ ...sampleRow }]);

      const result = await repo.getByStatus('proj-1', 'todo');

      expect(result).toHaveLength(1);
      expect(deps.sqliteCache.query).toHaveBeenCalledWith(
        expect.stringContaining('projectId = ?'),
        ['proj-1', 'todo']
      );
    });
  });

  // ============================================================================
  // Dependencies
  // ============================================================================

  describe('getDependencies', () => {
    it('should return tasks that the given task depends on', async () => {
      (deps.sqliteCache.query as jest.Mock).mockResolvedValue([{ ...sampleRow, id: 'dep-1' }]);

      const result = await repo.getDependencies('task-1');

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('dep-1');
      const call = (deps.sqliteCache.query as jest.Mock).mock.calls[0];
      expect(call[0]).toContain('td.taskId = ?');
      expect(call[0]).toContain('td.dependsOnTaskId = t.id');
    });
  });

  describe('getDependents', () => {
    it('should return tasks depending on the given task', async () => {
      (deps.sqliteCache.query as jest.Mock).mockResolvedValue([{ ...sampleRow, id: 'dependent-1' }]);

      const result = await repo.getDependents('task-1');

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('dependent-1');
      const call = (deps.sqliteCache.query as jest.Mock).mock.calls[0];
      expect(call[0]).toContain('td.dependsOnTaskId = ?');
    });
  });

  describe('getChildren', () => {
    it('should return child tasks', async () => {
      (deps.sqliteCache.query as jest.Mock).mockResolvedValue([{ ...sampleRow, id: 'child-1', parentTaskId: 'task-1' }]);

      const result = await repo.getChildren('task-1');

      expect(result).toHaveLength(1);
      expect(deps.sqliteCache.query).toHaveBeenCalledWith(
        expect.stringContaining('parentTaskId = ?'),
        ['task-1']
      );
    });
  });

  describe('getReadyTasks', () => {
    it('should return tasks with all deps complete', async () => {
      (deps.sqliteCache.query as jest.Mock).mockResolvedValue([{ ...sampleRow }]);

      const result = await repo.getReadyTasks('proj-1');

      expect(result).toHaveLength(1);
      const call = (deps.sqliteCache.query as jest.Mock).mock.calls[0];
      expect(call[0]).toContain('NOT EXISTS');
      expect(call[0]).toContain("t.status = 'todo'");
      expect(call[0]).toContain("dep.status NOT IN ('done', 'cancelled')");
    });
  });

  describe('addDependency', () => {
    beforeEach(() => {
      (deps.sqliteCache.queryOne as jest.Mock).mockResolvedValue({ ...sampleRow });
    });

    it('should write event and insert into SQLite', async () => {
      await repo.addDependency('task-1', 'dep-1');

      expect(deps.jsonlWriter.appendEvent).toHaveBeenCalledWith(
        'tasks/tasks_ws-1.jsonl',
        expect.objectContaining({
          type: 'task_dependency_added',
          taskId: 'task-1',
          dependsOnTaskId: 'dep-1'
        })
      );

      expect(deps.sqliteCache.run).toHaveBeenCalledWith(
        expect.stringContaining('INSERT OR IGNORE INTO task_dependencies'),
        expect.arrayContaining(['task-1', 'dep-1'])
      );
    });

    it('should throw if task not found', async () => {
      (deps.sqliteCache.queryOne as jest.Mock).mockResolvedValue(null);

      await expect(repo.addDependency('nonexistent', 'dep')).rejects.toThrow('not found');
    });

    it('should invalidate cache', async () => {
      await repo.addDependency('task-1', 'dep-1');
      expect(deps.queryCache.invalidateByType).toHaveBeenCalledWith('task');
    });
  });

  describe('removeDependency', () => {
    beforeEach(() => {
      (deps.sqliteCache.queryOne as jest.Mock).mockResolvedValue({ ...sampleRow });
    });

    it('should write event and delete from SQLite', async () => {
      await repo.removeDependency('task-1', 'dep-1');

      expect(deps.jsonlWriter.appendEvent).toHaveBeenCalledWith(
        'tasks/tasks_ws-1.jsonl',
        expect.objectContaining({
          type: 'task_dependency_removed',
          taskId: 'task-1',
          dependsOnTaskId: 'dep-1'
        })
      );

      expect(deps.sqliteCache.run).toHaveBeenCalledWith(
        expect.stringContaining('DELETE FROM task_dependencies'),
        ['task-1', 'dep-1']
      );
    });
  });

  // ============================================================================
  // Note Links
  // ============================================================================

  describe('getNoteLinks', () => {
    it('should return note links for a task', async () => {
      (deps.sqliteCache.query as jest.Mock).mockResolvedValue([
        { taskId: 'task-1', notePath: 'note.md', linkType: 'reference', created: 1000 }
      ]);

      const result = await repo.getNoteLinks('task-1');

      expect(result).toHaveLength(1);
      expect(result[0].notePath).toBe('note.md');
      expect(result[0].linkType).toBe('reference');
    });
  });

  describe('getByLinkedNote', () => {
    it('should return tasks linked to a note', async () => {
      (deps.sqliteCache.query as jest.Mock).mockResolvedValue([{ ...sampleRow }]);

      const result = await repo.getByLinkedNote('path/to/note.md');

      expect(result).toHaveLength(1);
      const call = (deps.sqliteCache.query as jest.Mock).mock.calls[0];
      expect(call[0]).toContain('tnl.notePath = ?');
    });
  });

  describe('addNoteLink', () => {
    beforeEach(() => {
      (deps.sqliteCache.queryOne as jest.Mock).mockResolvedValue({ ...sampleRow });
    });

    it('should write event and insert into SQLite', async () => {
      await repo.addNoteLink('task-1', 'note.md', 'reference');

      expect(deps.jsonlWriter.appendEvent).toHaveBeenCalledWith(
        'tasks/tasks_ws-1.jsonl',
        expect.objectContaining({
          type: 'task_note_linked',
          taskId: 'task-1',
          notePath: 'note.md',
          linkType: 'reference'
        })
      );

      expect(deps.sqliteCache.run).toHaveBeenCalledWith(
        expect.stringContaining('INSERT OR IGNORE INTO task_note_links'),
        expect.arrayContaining(['task-1', 'note.md', 'reference'])
      );
    });

    it('should throw if task not found', async () => {
      (deps.sqliteCache.queryOne as jest.Mock).mockResolvedValue(null);

      await expect(repo.addNoteLink('nonexistent', 'note.md', 'reference')).rejects.toThrow('not found');
    });

    it('should invalidate cache with task ID', async () => {
      await repo.addNoteLink('task-1', 'note.md', 'reference');
      expect(deps.queryCache.invalidateById).toHaveBeenCalledWith('task', 'task-1');
    });
  });

  describe('removeNoteLink', () => {
    beforeEach(() => {
      (deps.sqliteCache.queryOne as jest.Mock).mockResolvedValue({ ...sampleRow });
    });

    it('should write event and delete from SQLite', async () => {
      await repo.removeNoteLink('task-1', 'note.md');

      expect(deps.jsonlWriter.appendEvent).toHaveBeenCalledWith(
        'tasks/tasks_ws-1.jsonl',
        expect.objectContaining({
          type: 'task_note_unlinked',
          taskId: 'task-1',
          notePath: 'note.md'
        })
      );

      expect(deps.sqliteCache.run).toHaveBeenCalledWith(
        expect.stringContaining('DELETE FROM task_note_links'),
        ['task-1', 'note.md']
      );
    });

    it('should throw if task not found', async () => {
      (deps.sqliteCache.queryOne as jest.Mock).mockResolvedValue(null);

      await expect(repo.removeNoteLink('nonexistent', 'note.md')).rejects.toThrow('not found');
    });
  });

  // ============================================================================
  // getAllDependencyEdges
  // ============================================================================

  describe('getAllDependencyEdges', () => {
    it('should return all edges for a project', async () => {
      (deps.sqliteCache.query as jest.Mock).mockResolvedValue([
        { taskId: 'A', dependsOnTaskId: 'B' },
        { taskId: 'C', dependsOnTaskId: 'B' }
      ]);

      const result = await repo.getAllDependencyEdges('proj-1');

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ taskId: 'A', dependsOnTaskId: 'B' });
      expect(result[1]).toEqual({ taskId: 'C', dependsOnTaskId: 'B' });

      const call = (deps.sqliteCache.query as jest.Mock).mock.calls[0];
      expect(call[0]).toContain('t.projectId = ?');
    });

    it('should return empty array when no edges', async () => {
      (deps.sqliteCache.query as jest.Mock).mockResolvedValue([]);

      const result = await repo.getAllDependencyEdges('proj-1');
      expect(result).toEqual([]);
    });
  });
});
