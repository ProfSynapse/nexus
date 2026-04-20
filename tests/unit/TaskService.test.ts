/**
 * TaskService Unit Tests
 *
 * Tests the business logic facade that orchestrates repositories and DAGService.
 * Uses mocked repositories for isolation.
 *
 * Coverage target: 80%+ (service with mocks)
 */

import { TaskService } from '../../src/agents/taskManager/services/TaskService';
import { DAGService } from '../../src/agents/taskManager/services/DAGService';
import type { IProjectRepository, ProjectMetadata } from '../../src/database/repositories/interfaces/IProjectRepository';
import type { ITaskRepository, TaskMetadata } from '../../src/database/repositories/interfaces/ITaskRepository';
import { PaginatedResult } from '../../src/types/pagination/PaginationTypes';

// ============================================================================
// Mock Factories
// ============================================================================

function createMockProject(overrides: Partial<ProjectMetadata> = {}): ProjectMetadata {
  return {
    id: 'proj-1',
    workspaceId: 'ws-1',
    name: 'Test Project',
    status: 'active',
    created: 1000,
    updated: 1000,
    ...overrides
  };
}

function createMockTask(overrides: Partial<TaskMetadata> = {}): TaskMetadata {
  return {
    id: 'task-1',
    projectId: 'proj-1',
    workspaceId: 'ws-1',
    title: 'Test Task',
    status: 'todo',
    priority: 'medium',
    created: 1000,
    updated: 1000,
    ...overrides
  };
}

function paginatedResult<T>(items: T[]): PaginatedResult<T> {
  return {
    items,
    totalItems: items.length,
    totalPages: 1,
    currentPage: 1,
    pageSize: 100,
    hasNextPage: false
  };
}

function createMockProjectRepo(): jest.Mocked<IProjectRepository> {
  return {
    getById: jest.fn(),
    getAll: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    count: jest.fn(),
    getByWorkspace: jest.fn(),
    getByName: jest.fn()
  };
}

function createMockTaskRepo(): jest.Mocked<ITaskRepository> {
  return {
    getById: jest.fn(),
    getAll: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    count: jest.fn(),
    getByProject: jest.fn(),
    getByWorkspace: jest.fn(),
    getByStatus: jest.fn(),
    getDependencies: jest.fn(),
    getDependents: jest.fn(),
    getChildren: jest.fn(),
    getReadyTasks: jest.fn(),
    addDependency: jest.fn(),
    removeDependency: jest.fn(),
    getNoteLinks: jest.fn(),
    getByLinkedNote: jest.fn(),
    addNoteLink: jest.fn(),
    removeNoteLink: jest.fn(),
    getAllDependencyEdges: jest.fn()
  };
}

describe('TaskService', () => {
  let service: TaskService;
  let projectRepo: jest.Mocked<IProjectRepository>;
  let taskRepo: jest.Mocked<ITaskRepository>;
  let dagService: DAGService;
  let waitForQueryReady: jest.Mock<Promise<boolean>, []>;

  beforeEach(() => {
    projectRepo = createMockProjectRepo();
    taskRepo = createMockTaskRepo();
    dagService = new DAGService();
    waitForQueryReady = jest.fn().mockResolvedValue(true);
    service = new TaskService(projectRepo, taskRepo, dagService, undefined, undefined, waitForQueryReady);
  });

  describe('query readiness gating', () => {
    it('waits for query readiness before reads', async () => {
      projectRepo.getByWorkspace.mockResolvedValue(paginatedResult([]));

      await service.listProjects('ws-1');

      expect(waitForQueryReady).toHaveBeenCalled();
      expect(projectRepo.getByWorkspace).toHaveBeenCalledWith('ws-1', expect.any(Object));
    });

    it('throws when query readiness does not complete', async () => {
      waitForQueryReady.mockResolvedValue(false);

      await expect(service.listProjects('ws-1')).rejects.toThrow('Task storage is not ready yet');
      expect(projectRepo.getByWorkspace).not.toHaveBeenCalled();
    });
  });

  // ============================================================================
  // Projects
  // ============================================================================

  describe('createProject', () => {
    it('should create a project successfully', async () => {
      projectRepo.getByName.mockResolvedValue(null);
      projectRepo.create.mockResolvedValue('proj-new');

      const result = await service.createProject('ws-1', {
        name: 'New Project',
        description: 'A test project'
      });

      expect(result).toBe('proj-new');
      expect(projectRepo.getByName).toHaveBeenCalledWith('ws-1', 'New Project');
      expect(projectRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'New Project',
          description: 'A test project',
          workspaceId: 'ws-1'
        })
      );
    });

    it('should reject duplicate project names in workspace', async () => {
      projectRepo.getByName.mockResolvedValue(createMockProject());

      await expect(
        service.createProject('ws-1', { name: 'Test Project' })
      ).rejects.toThrow('already exists');
    });

    it('should pass metadata through', async () => {
      projectRepo.getByName.mockResolvedValue(null);
      projectRepo.create.mockResolvedValue('proj-new');

      await service.createProject('ws-1', {
        name: 'New Project',
        metadata: { color: 'blue' }
      });

      expect(projectRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: { color: 'blue' }
        })
      );
    });
  });

  describe('listProjects', () => {
    it('should delegate to repository', async () => {
      const projects = [createMockProject()];
      projectRepo.getByWorkspace.mockResolvedValue(paginatedResult(projects));

      const result = await service.listProjects('ws-1');

      expect(result.items).toEqual(projects);
      expect(projectRepo.getByWorkspace).toHaveBeenCalledWith('ws-1', expect.any(Object));
    });

    it('should pass filter options', async () => {
      projectRepo.getByWorkspace.mockResolvedValue(paginatedResult([]));

      await service.listProjects('ws-1', { status: 'active', page: 2, pageSize: 10 });

      expect(projectRepo.getByWorkspace).toHaveBeenCalledWith('ws-1', {
        page: 2,
        pageSize: 10,
        status: 'active'
      });
    });
  });

  describe('updateProject', () => {
    it('should update project fields', async () => {
      projectRepo.getById.mockResolvedValue(createMockProject());

      await service.updateProject('proj-1', { description: 'Updated' });

      expect(projectRepo.update).toHaveBeenCalledWith('proj-1', expect.objectContaining({
        description: 'Updated'
      }));
    });

    it('should throw if project not found', async () => {
      projectRepo.getById.mockResolvedValue(null);

      await expect(
        service.updateProject('nonexistent', { name: 'New Name' })
      ).rejects.toThrow('not found');
    });

    it('should reject rename to duplicate name', async () => {
      projectRepo.getById.mockResolvedValue(createMockProject({ name: 'Original' }));
      projectRepo.getByName.mockResolvedValue(createMockProject({ name: 'Duplicate' }));

      await expect(
        service.updateProject('proj-1', { name: 'Duplicate' })
      ).rejects.toThrow('already exists');
    });

    it('should allow rename if no duplicate exists', async () => {
      projectRepo.getById.mockResolvedValue(createMockProject({ name: 'Original' }));
      projectRepo.getByName.mockResolvedValue(null);

      await service.updateProject('proj-1', { name: 'New Unique Name' });

      expect(projectRepo.update).toHaveBeenCalled();
    });

    it('should not check for duplicate if name unchanged', async () => {
      projectRepo.getById.mockResolvedValue(createMockProject({ name: 'Same' }));

      await service.updateProject('proj-1', { description: 'Changed desc' });

      expect(projectRepo.getByName).not.toHaveBeenCalled();
    });
  });

  describe('archiveProject', () => {
    it('should set status to archived', async () => {
      projectRepo.getById.mockResolvedValue(createMockProject());

      await service.archiveProject('proj-1');

      expect(projectRepo.update).toHaveBeenCalledWith('proj-1', expect.objectContaining({
        status: 'archived'
      }));
    });

    it('should throw if project not found', async () => {
      projectRepo.getById.mockResolvedValue(null);

      await expect(service.archiveProject('nonexistent')).rejects.toThrow('not found');
    });
  });

  describe('deleteProject', () => {
    it('should delete an existing project', async () => {
      projectRepo.getById.mockResolvedValue(createMockProject());
      projectRepo.delete.mockResolvedValue();

      await service.deleteProject('proj-1');

      expect(projectRepo.delete).toHaveBeenCalledWith('proj-1');
    });

    it('should throw when deleting a missing project', async () => {
      projectRepo.getById.mockResolvedValue(null);

      await expect(service.deleteProject('missing')).rejects.toThrow('Project "missing" not found');
      expect(projectRepo.delete).not.toHaveBeenCalled();
    });
  });

  // ============================================================================
  // Tasks
  // ============================================================================

  describe('createTask', () => {
    it('should create a task in existing project', async () => {
      projectRepo.getById.mockResolvedValue(createMockProject());
      taskRepo.create.mockResolvedValue('task-new');

      const result = await service.createTask('proj-1', {
        title: 'New Task'
      });

      expect(result).toBe('task-new');
      expect(taskRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: 'proj-1',
          workspaceId: 'ws-1',
          title: 'New Task',
          priority: 'medium'
        })
      );
    });

    it('should throw if project not found', async () => {
      projectRepo.getById.mockResolvedValue(null);

      await expect(
        service.createTask('nonexistent', { title: 'Task' })
      ).rejects.toThrow('not found');
    });

    it('should validate parent task exists', async () => {
      projectRepo.getById.mockResolvedValue(createMockProject());
      taskRepo.getById.mockResolvedValue(null);

      await expect(
        service.createTask('proj-1', { title: 'Sub', parentTaskId: 'nonexistent' })
      ).rejects.toThrow('Parent task');
    });

    it('should reject parent task in different project', async () => {
      projectRepo.getById.mockResolvedValue(createMockProject());
      taskRepo.getById.mockResolvedValue(createMockTask({ projectId: 'other-proj' }));

      await expect(
        service.createTask('proj-1', { title: 'Sub', parentTaskId: 'task-1' })
      ).rejects.toThrow('same project');
    });

    it('should create initial dependency edges', async () => {
      projectRepo.getById.mockResolvedValue(createMockProject());
      taskRepo.create.mockResolvedValue('task-new');
      taskRepo.getById.mockResolvedValue(createMockTask({ id: 'dep-1', projectId: 'proj-1' }));
      taskRepo.getAllDependencyEdges.mockResolvedValue([]);

      await service.createTask('proj-1', {
        title: 'Task with deps',
        dependsOn: ['dep-1']
      });

      expect(taskRepo.addDependency).toHaveBeenCalledWith('task-new', 'dep-1');
    });

    it('should reject dependency that would create cycle', async () => {
      projectRepo.getById.mockResolvedValue(createMockProject());
      taskRepo.create.mockResolvedValue('task-A');
      taskRepo.getById.mockResolvedValue(createMockTask({ id: 'task-B', projectId: 'proj-1' }));
      // Existing edge: task-B depends on task-A
      taskRepo.getAllDependencyEdges.mockResolvedValue([
        { taskId: 'task-B', dependsOnTaskId: 'task-A' }
      ]);

      // task-A depends on task-B would be a cycle
      // But since task-A was just created by taskRepo.create, the cycle check is:
      // validateNoCycle('task-A', 'task-B', existingEdges)
      // existingEdges has task-B->task-A, so DFS from task-B reaches task-A via edges. Cycle!
      await expect(
        service.createTask('proj-1', {
          title: 'Cyclic task',
          dependsOn: ['task-B']
        })
      ).rejects.toThrow('cycle');
    });

    it('should reject dependency task not found', async () => {
      projectRepo.getById.mockResolvedValue(createMockProject());
      taskRepo.create.mockResolvedValue('task-new');
      taskRepo.getAllDependencyEdges.mockResolvedValue([]);
      taskRepo.getById.mockResolvedValue(null);

      await expect(
        service.createTask('proj-1', { title: 'Task', dependsOn: ['nonexistent'] })
      ).rejects.toThrow('not found');
    });

    it('should reject dependency in different project', async () => {
      projectRepo.getById.mockResolvedValue(createMockProject());
      taskRepo.create.mockResolvedValue('task-new');
      taskRepo.getAllDependencyEdges.mockResolvedValue([]);
      taskRepo.getById.mockResolvedValue(createMockTask({ id: 'dep-1', projectId: 'other-proj' }));

      await expect(
        service.createTask('proj-1', { title: 'Task', dependsOn: ['dep-1'] })
      ).rejects.toThrow('different project');
    });

    it('should create initial note links', async () => {
      projectRepo.getById.mockResolvedValue(createMockProject());
      taskRepo.create.mockResolvedValue('task-new');

      await service.createTask('proj-1', {
        title: 'Task with notes',
        linkedNotes: ['path/to/note1.md', 'path/to/note2.md']
      });

      expect(taskRepo.addNoteLink).toHaveBeenCalledTimes(2);
      expect(taskRepo.addNoteLink).toHaveBeenCalledWith('task-new', 'path/to/note1.md', 'reference');
      expect(taskRepo.addNoteLink).toHaveBeenCalledWith('task-new', 'path/to/note2.md', 'reference');
    });

    it('should set default priority to medium', async () => {
      projectRepo.getById.mockResolvedValue(createMockProject());
      taskRepo.create.mockResolvedValue('task-new');

      await service.createTask('proj-1', { title: 'Task' });

      expect(taskRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ priority: 'medium' })
      );
    });

    it('should respect explicit priority', async () => {
      projectRepo.getById.mockResolvedValue(createMockProject());
      taskRepo.create.mockResolvedValue('task-new');

      await service.createTask('proj-1', { title: 'Critical Task', priority: 'critical' });

      expect(taskRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ priority: 'critical' })
      );
    });
  });

  describe('listTasks', () => {
    it('should delegate to repository with options', async () => {
      taskRepo.getByProject.mockResolvedValue(paginatedResult([]));

      await service.listTasks('proj-1', { status: 'todo', priority: 'high' });

      expect(taskRepo.getByProject).toHaveBeenCalledWith('proj-1', expect.objectContaining({
        status: 'todo',
        priority: 'high'
      }));
    });
  });

  describe('updateTask', () => {
    it('should update task fields', async () => {
      taskRepo.getById.mockResolvedValue(createMockTask());

      await service.updateTask('task-1', { title: 'Updated Title' });

      expect(taskRepo.update).toHaveBeenCalledWith('task-1', expect.objectContaining({
        title: 'Updated Title'
      }));
    });

    it('should throw if task not found', async () => {
      taskRepo.getById.mockResolvedValue(null);

      await expect(
        service.updateTask('nonexistent', { title: 'X' })
      ).rejects.toThrow('not found');
    });

    it('should set completedAt when marking done', async () => {
      taskRepo.getById.mockResolvedValue(createMockTask({ status: 'todo' }));

      await service.updateTask('task-1', { status: 'done' });

      expect(taskRepo.update).toHaveBeenCalledWith('task-1', expect.objectContaining({
        status: 'done',
        completedAt: expect.any(Number)
      }));
    });

    it('should clear completedAt when re-opening from done', async () => {
      taskRepo.getById.mockResolvedValue(createMockTask({ status: 'done', completedAt: 5000 }));

      await service.updateTask('task-1', { status: 'todo' });

      expect(taskRepo.update).toHaveBeenCalledWith('task-1', expect.objectContaining({
        status: 'todo',
        completedAt: undefined
      }));
    });

    it('should not set completedAt when moving to in_progress', async () => {
      taskRepo.getById.mockResolvedValue(createMockTask({ status: 'todo' }));

      await service.updateTask('task-1', { status: 'in_progress' });

      const updateCall = taskRepo.update.mock.calls[0][1];
      expect(updateCall.completedAt).toBeUndefined();
    });

    it('should not clear completedAt when already not done', async () => {
      taskRepo.getById.mockResolvedValue(createMockTask({ status: 'todo' }));

      await service.updateTask('task-1', { status: 'in_progress' });

      const updateCall = taskRepo.update.mock.calls[0][1];
      expect(updateCall.completedAt).toBeUndefined();
    });

    it('should set completedAt when transitioning from cancelled to done', async () => {
      taskRepo.getById.mockResolvedValue(createMockTask({ status: 'cancelled' }));

      await service.updateTask('task-1', { status: 'done' });

      expect(taskRepo.update).toHaveBeenCalledWith('task-1', expect.objectContaining({
        status: 'done',
        completedAt: expect.any(Number)
      }));
    });
  });

  describe('moveTask', () => {
    it('should move task to different project in same workspace', async () => {
      taskRepo.getById.mockResolvedValue(createMockTask({ workspaceId: 'ws-1' }));
      projectRepo.getById.mockResolvedValue(createMockProject({ id: 'proj-2', workspaceId: 'ws-1' }));

      await service.moveTask('task-1', { projectId: 'proj-2' });

      expect(taskRepo.update).toHaveBeenCalledWith('task-1', expect.objectContaining({
        projectId: 'proj-2'
      }));
    });

    it('should throw if task not found', async () => {
      taskRepo.getById.mockResolvedValue(null);

      await expect(
        service.moveTask('nonexistent', { projectId: 'proj-2' })
      ).rejects.toThrow('not found');
    });

    it('should throw if target project not found', async () => {
      taskRepo.getById.mockResolvedValue(createMockTask());
      projectRepo.getById.mockResolvedValue(null);

      await expect(
        service.moveTask('task-1', { projectId: 'nonexistent' })
      ).rejects.toThrow('not found');
    });

    it('should reject cross-workspace moves', async () => {
      taskRepo.getById.mockResolvedValue(createMockTask({ workspaceId: 'ws-1' }));
      projectRepo.getById.mockResolvedValue(createMockProject({ id: 'proj-2', workspaceId: 'ws-2' }));

      await expect(
        service.moveTask('task-1', { projectId: 'proj-2' })
      ).rejects.toThrow('different workspace');
    });

    it('should move task to top-level (null parent)', async () => {
      taskRepo.getById.mockResolvedValue(createMockTask({ parentTaskId: 'parent-1' }));

      await service.moveTask('task-1', { parentTaskId: null });

      expect(taskRepo.update).toHaveBeenCalledWith('task-1', expect.objectContaining({
        parentTaskId: undefined
      }));
    });

    it('should move task to new parent', async () => {
      taskRepo.getById
        .mockResolvedValueOnce(createMockTask()) // the task being moved
        .mockResolvedValueOnce(createMockTask({ id: 'parent-2' })); // the new parent

      await service.moveTask('task-1', { parentTaskId: 'parent-2' });

      expect(taskRepo.update).toHaveBeenCalledWith('task-1', expect.objectContaining({
        parentTaskId: 'parent-2'
      }));
    });

    it('should reject self-parenting', async () => {
      taskRepo.getById.mockResolvedValue(createMockTask({ id: 'task-1' }));

      await expect(
        service.moveTask('task-1', { parentTaskId: 'task-1' })
      ).rejects.toThrow('own parent');
    });

    it('should throw if new parent not found', async () => {
      taskRepo.getById
        .mockResolvedValueOnce(createMockTask())
        .mockResolvedValueOnce(null); // parent not found

      await expect(
        service.moveTask('task-1', { parentTaskId: 'nonexistent' })
      ).rejects.toThrow('not found');
    });
  });

  describe('deleteTask', () => {
    it('should delete an existing task', async () => {
      taskRepo.getById.mockResolvedValue(createMockTask());
      taskRepo.delete.mockResolvedValue();

      await service.deleteTask('task-1');

      expect(taskRepo.delete).toHaveBeenCalledWith('task-1');
    });

    it('should throw when deleting a missing task', async () => {
      taskRepo.getById.mockResolvedValue(null);

      await expect(service.deleteTask('missing')).rejects.toThrow('Task "missing" not found');
      expect(taskRepo.delete).not.toHaveBeenCalled();
    });
  });

  // ============================================================================
  // Dependencies
  // ============================================================================

  describe('addDependency', () => {
    it('should add dependency when valid', async () => {
      const taskA = createMockTask({ id: 'A', projectId: 'proj-1' });
      const taskB = createMockTask({ id: 'B', projectId: 'proj-1' });
      taskRepo.getById
        .mockResolvedValueOnce(taskA)
        .mockResolvedValueOnce(taskB);
      taskRepo.getAllDependencyEdges.mockResolvedValue([]);

      await service.addDependency('A', 'B');

      expect(taskRepo.addDependency).toHaveBeenCalledWith('A', 'B');
    });

    it('should throw if task not found', async () => {
      taskRepo.getById.mockResolvedValue(null);

      await expect(service.addDependency('A', 'B')).rejects.toThrow('not found');
    });

    it('should throw if dependency task not found', async () => {
      taskRepo.getById
        .mockResolvedValueOnce(createMockTask({ id: 'A' }))
        .mockResolvedValueOnce(null);

      await expect(service.addDependency('A', 'B')).rejects.toThrow('not found');
    });

    it('should reject cross-project dependencies', async () => {
      taskRepo.getById
        .mockResolvedValueOnce(createMockTask({ id: 'A', projectId: 'proj-1' }))
        .mockResolvedValueOnce(createMockTask({ id: 'B', projectId: 'proj-2' }));

      await expect(service.addDependency('A', 'B')).rejects.toThrow('same project');
    });

    it('should reject cycle-creating dependency', async () => {
      const taskA = createMockTask({ id: 'A', projectId: 'proj-1' });
      const taskB = createMockTask({ id: 'B', projectId: 'proj-1' });
      taskRepo.getById
        .mockResolvedValueOnce(taskA)
        .mockResolvedValueOnce(taskB);
      taskRepo.getAllDependencyEdges.mockResolvedValue([
        { taskId: 'B', dependsOnTaskId: 'A' }
      ]);

      // Adding A depends on B would create cycle: A->B->A
      await expect(service.addDependency('A', 'B')).rejects.toThrow('cycle');
    });
  });

  describe('removeDependency', () => {
    it('should delegate to repository', async () => {
      await service.removeDependency('A', 'B');
      expect(taskRepo.removeDependency).toHaveBeenCalledWith('A', 'B');
    });
  });

  // ============================================================================
  // DAG Queries
  // ============================================================================

  describe('getNextActions', () => {
    it('should return ready tasks sorted by priority', async () => {
      const tasks = [
        createMockTask({ id: 't1', status: 'todo', priority: 'low', created: 100 }),
        createMockTask({ id: 't2', status: 'todo', priority: 'critical', created: 200 }),
        createMockTask({ id: 't3', status: 'todo', priority: 'high', created: 50 })
      ];
      taskRepo.getByProject.mockResolvedValue(paginatedResult(tasks));
      taskRepo.getAllDependencyEdges.mockResolvedValue([]);

      const result = await service.getNextActions('proj-1');

      expect(result).toHaveLength(3);
      expect(result[0].id).toBe('t2'); // critical
      expect(result[1].id).toBe('t3'); // high
      expect(result[2].id).toBe('t1'); // low
    });

    it('should sort by creation date within same priority', async () => {
      const tasks = [
        createMockTask({ id: 't1', status: 'todo', priority: 'medium', created: 300 }),
        createMockTask({ id: 't2', status: 'todo', priority: 'medium', created: 100 }),
        createMockTask({ id: 't3', status: 'todo', priority: 'medium', created: 200 })
      ];
      taskRepo.getByProject.mockResolvedValue(paginatedResult(tasks));
      taskRepo.getAllDependencyEdges.mockResolvedValue([]);

      const result = await service.getNextActions('proj-1');

      expect(result[0].id).toBe('t2'); // oldest first
      expect(result[1].id).toBe('t3');
      expect(result[2].id).toBe('t1');
    });

    it('should exclude tasks blocked by incomplete deps', async () => {
      const tasks = [
        createMockTask({ id: 'dep', status: 'in_progress' }),
        createMockTask({ id: 'blocked', status: 'todo' })
      ];
      taskRepo.getByProject.mockResolvedValue(paginatedResult(tasks));
      taskRepo.getAllDependencyEdges.mockResolvedValue([
        { taskId: 'blocked', dependsOnTaskId: 'dep' }
      ]);

      const result = await service.getNextActions('proj-1');
      expect(result).toHaveLength(0);
    });
  });

  describe('getBlockedTasks', () => {
    it('should return blocked tasks with blocker details', async () => {
      const depTask = createMockTask({ id: 'dep', status: 'in_progress', title: 'Blocker' });
      const blockedTask = createMockTask({ id: 'blocked', status: 'todo', title: 'Blocked' });
      taskRepo.getByProject.mockResolvedValue(paginatedResult([depTask, blockedTask]));
      taskRepo.getAllDependencyEdges.mockResolvedValue([
        { taskId: 'blocked', dependsOnTaskId: 'dep' }
      ]);

      const result = await service.getBlockedTasks('proj-1');

      expect(result).toHaveLength(1);
      expect(result[0].task.id).toBe('blocked');
      expect(result[0].blockedBy).toHaveLength(1);
      expect(result[0].blockedBy[0].id).toBe('dep');
    });

    it('should return empty for no blocked tasks', async () => {
      taskRepo.getByProject.mockResolvedValue(paginatedResult([
        createMockTask({ id: 'A', status: 'done' }),
        createMockTask({ id: 'B', status: 'todo' })
      ]));
      taskRepo.getAllDependencyEdges.mockResolvedValue([
        { taskId: 'B', dependsOnTaskId: 'A' }
      ]);

      const result = await service.getBlockedTasks('proj-1');
      expect(result).toHaveLength(0);
    });
  });

  describe('getDependencyTree', () => {
    it('should return tree with task metadata', async () => {
      const rootTask = createMockTask({ id: 'root', projectId: 'proj-1' });
      const depTask = createMockTask({ id: 'dep', projectId: 'proj-1' });
      const dependentTask = createMockTask({ id: 'dependent', projectId: 'proj-1' });

      taskRepo.getById.mockResolvedValue(rootTask);
      taskRepo.getByProject.mockResolvedValue(paginatedResult([rootTask, depTask, dependentTask]));
      taskRepo.getAllDependencyEdges.mockResolvedValue([
        { taskId: 'root', dependsOnTaskId: 'dep' },
        { taskId: 'dependent', dependsOnTaskId: 'root' }
      ]);

      const result = await service.getDependencyTree('root');

      expect(result.task.id).toBe('root');
      expect(result.dependencies).toHaveLength(1);
      expect(result.dependencies[0].task.id).toBe('dep');
      expect(result.dependents).toHaveLength(1);
      expect(result.dependents[0].task.id).toBe('dependent');
    });

    it('should throw if task not found', async () => {
      taskRepo.getById.mockResolvedValue(null);

      await expect(service.getDependencyTree('nonexistent')).rejects.toThrow('not found');
    });
  });

  // ============================================================================
  // Note Links
  // ============================================================================

  describe('linkNote', () => {
    it('should link note to task', async () => {
      taskRepo.getById.mockResolvedValue(createMockTask());

      await service.linkNote('task-1', 'path/to/note.md', 'reference');

      expect(taskRepo.addNoteLink).toHaveBeenCalledWith('task-1', 'path/to/note.md', 'reference');
    });

    it('should throw if task not found', async () => {
      taskRepo.getById.mockResolvedValue(null);

      await expect(
        service.linkNote('nonexistent', 'path.md', 'reference')
      ).rejects.toThrow('not found');
    });

    it('should support different link types', async () => {
      taskRepo.getById.mockResolvedValue(createMockTask());

      await service.linkNote('task-1', 'output.md', 'output');

      expect(taskRepo.addNoteLink).toHaveBeenCalledWith('task-1', 'output.md', 'output');
    });
  });

  describe('unlinkNote', () => {
    it('should delegate to repository', async () => {
      await service.unlinkNote('task-1', 'path.md');
      expect(taskRepo.removeNoteLink).toHaveBeenCalledWith('task-1', 'path.md');
    });
  });

  describe('getTasksForNote', () => {
    it('should delegate to repository', async () => {
      const tasks = [createMockTask()];
      taskRepo.getByLinkedNote.mockResolvedValue(tasks);

      const result = await service.getTasksForNote('path.md');
      expect(result).toEqual(tasks);
    });
  });

  // ============================================================================
  // Workspace Summary
  // ============================================================================

  describe('getWorkspaceSummary', () => {
    it('should return summary with projects and tasks', async () => {
      const project = createMockProject({ id: 'proj-1', status: 'active' });
      const tasks = [
        createMockTask({ id: 't1', status: 'todo', priority: 'high', projectId: 'proj-1' }),
        createMockTask({ id: 't2', status: 'done', completedAt: 5000, projectId: 'proj-1' }),
        createMockTask({ id: 't3', status: 'in_progress', projectId: 'proj-1' })
      ];

      projectRepo.getByWorkspace.mockResolvedValue(paginatedResult([project]));
      taskRepo.getByWorkspace.mockResolvedValue(paginatedResult(tasks));
      taskRepo.getByProject.mockResolvedValue(paginatedResult(tasks));
      taskRepo.getAllDependencyEdges.mockResolvedValue([]);

      const result = await service.getWorkspaceSummary('ws-1');

      expect(result.projects.total).toBe(1);
      expect(result.projects.active).toBe(1);
      expect(result.projects.items[0].name).toBe('Test Project');
      expect(result.tasks.total).toBe(3);
      expect(result.tasks.byStatus.todo).toBe(1);
      expect(result.tasks.byStatus.done).toBe(1);
      expect(result.tasks.byStatus.in_progress).toBe(1);
    });

    it('should count overdue tasks', async () => {
      const now = Date.now();
      const tasks = [
        createMockTask({ status: 'todo', dueDate: now - 100000 }), // overdue
        createMockTask({ status: 'todo', dueDate: now + 100000 }), // not overdue
        createMockTask({ status: 'done', dueDate: now - 100000 })  // done, not overdue
      ];

      projectRepo.getByWorkspace.mockResolvedValue(paginatedResult([]));
      taskRepo.getByWorkspace.mockResolvedValue(paginatedResult(tasks));

      const result = await service.getWorkspaceSummary('ws-1');
      expect(result.tasks.overdue).toBe(1);
    });

    it('should exclude archived projects from items', async () => {
      const projects = [
        createMockProject({ id: 'p1', status: 'active' }),
        createMockProject({ id: 'p2', status: 'archived' })
      ];

      projectRepo.getByWorkspace.mockResolvedValue(paginatedResult(projects));
      taskRepo.getByWorkspace.mockResolvedValue(paginatedResult([]));
      taskRepo.getAllDependencyEdges.mockResolvedValue([]);

      const result = await service.getWorkspaceSummary('ws-1');
      expect(result.projects.active).toBe(1);
      expect(result.projects.items).toHaveLength(1);
    });

    it('should not count completed projects as active', async () => {
      const projects = [
        createMockProject({ id: 'p1', status: 'active' }),
        createMockProject({ id: 'p2', status: 'completed' }),
        createMockProject({ id: 'p3', status: 'archived' })
      ];

      projectRepo.getByWorkspace.mockResolvedValue(paginatedResult(projects));
      taskRepo.getByWorkspace.mockResolvedValue(paginatedResult([]));
      taskRepo.getAllDependencyEdges.mockResolvedValue([]);

      const result = await service.getWorkspaceSummary('ws-1');
      expect(result.projects.total).toBe(3);          // all projects including archived
      expect(result.projects.active).toBe(1);          // only status === 'active'
      expect(result.projects.items).toHaveLength(2);   // active + completed visible, archived excluded
    });

    it('should limit next actions to 5', async () => {
      const project = createMockProject({ status: 'active' });
      const tasks = Array.from({ length: 10 }, (_, i) =>
        createMockTask({ id: `t${i}`, status: 'todo', priority: 'medium', created: i })
      );

      projectRepo.getByWorkspace.mockResolvedValue(paginatedResult([project]));
      taskRepo.getByWorkspace.mockResolvedValue(paginatedResult(tasks));
      taskRepo.getByProject.mockResolvedValue(paginatedResult(tasks));
      taskRepo.getAllDependencyEdges.mockResolvedValue([]);

      const result = await service.getWorkspaceSummary('ws-1');
      expect(result.tasks.nextActions.length).toBeLessThanOrEqual(5);
    });

    it('should limit recently completed to 5', async () => {
      const tasks = Array.from({ length: 10 }, (_, i) =>
        createMockTask({ id: `t${i}`, status: 'done', completedAt: i * 1000 })
      );

      projectRepo.getByWorkspace.mockResolvedValue(paginatedResult([]));
      taskRepo.getByWorkspace.mockResolvedValue(paginatedResult(tasks));

      const result = await service.getWorkspaceSummary('ws-1');
      expect(result.tasks.recentlyCompleted.length).toBeLessThanOrEqual(5);
    });

    it('should sort recently completed by completedAt descending', async () => {
      const tasks = [
        createMockTask({ id: 't1', status: 'done', completedAt: 1000 }),
        createMockTask({ id: 't2', status: 'done', completedAt: 3000 }),
        createMockTask({ id: 't3', status: 'done', completedAt: 2000 })
      ];

      projectRepo.getByWorkspace.mockResolvedValue(paginatedResult([]));
      taskRepo.getByWorkspace.mockResolvedValue(paginatedResult(tasks));

      const result = await service.getWorkspaceSummary('ws-1');
      expect(result.tasks.recentlyCompleted[0].id).toBe('t2');
      expect(result.tasks.recentlyCompleted[1].id).toBe('t3');
      expect(result.tasks.recentlyCompleted[2].id).toBe('t1');
    });

    it('should handle empty workspace', async () => {
      projectRepo.getByWorkspace.mockResolvedValue(paginatedResult([]));
      taskRepo.getByWorkspace.mockResolvedValue(paginatedResult([]));

      const result = await service.getWorkspaceSummary('ws-1');

      expect(result.projects.total).toBe(0);
      expect(result.projects.active).toBe(0);
      expect(result.tasks.total).toBe(0);
      expect(result.tasks.overdue).toBe(0);
      expect(result.tasks.nextActions).toEqual([]);
      expect(result.tasks.recentlyCompleted).toEqual([]);
    });
  });
});
