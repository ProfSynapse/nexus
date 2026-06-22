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
import type { TaskBoardNotifier } from '../../src/agents/taskManager/services/TaskService';

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

function paginatedResult<T>(
  items: T[],
  overrides: Partial<Omit<PaginatedResult<T>, 'items'>> = {}
): PaginatedResult<T> {
  const page = overrides.page ?? 0;
  const pageSize = overrides.pageSize ?? 100;
  const totalItems = overrides.totalItems ?? items.length;
  const totalPages = overrides.totalPages ?? Math.ceil(totalItems / pageSize);

  return {
    items,
    page,
    pageSize,
    totalItems,
    totalPages,
    hasNextPage: overrides.hasNextPage ?? page < totalPages - 1,
    hasPreviousPage: overrides.hasPreviousPage ?? page > 0,
    nextCursor: overrides.nextCursor,
    previousCursor: overrides.previousCursor
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
    getByIdPrefix: jest.fn(),
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
  let taskBoardNotifier: jest.Mocked<TaskBoardNotifier>;

  beforeEach(() => {
    projectRepo = createMockProjectRepo();
    taskRepo = createMockTaskRepo();
    dagService = new DAGService();
    waitForQueryReady = jest.fn().mockResolvedValue(true);
    taskBoardNotifier = {
      notify: jest.fn()
    };
    // Read surfaces (listTasks, getNextActions, getBlockedTasks, getDependencyTree,
    // getWorkspaceSummary) enrich tasks with note links via getNoteLinks; default to
    // an empty array so unrelated tests don't trip the enrichment. Tests that assert
    // noteLinks override this per-task.
    taskRepo.getNoteLinks.mockResolvedValue([]);
    service = new TaskService(projectRepo, taskRepo, dagService, undefined, taskBoardNotifier, waitForQueryReady);
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

    it('should create note links from object form with explicit linkType', async () => {
      projectRepo.getById.mockResolvedValue(createMockProject());
      taskRepo.create.mockResolvedValue('task-new');

      await service.createTask('proj-1', {
        title: 'Task with typed notes',
        linkedNotes: [
          { notePath: 'src.md', linkType: 'input' },
          { notePath: 'out.md', linkType: 'output' },
          { notePath: 'ctx.md', linkType: 'reference' }
        ]
      });

      expect(taskRepo.addNoteLink).toHaveBeenCalledTimes(3);
      expect(taskRepo.addNoteLink).toHaveBeenCalledWith('task-new', 'src.md', 'input');
      expect(taskRepo.addNoteLink).toHaveBeenCalledWith('task-new', 'out.md', 'output');
      expect(taskRepo.addNoteLink).toHaveBeenCalledWith('task-new', 'ctx.md', 'reference');
    });

    it('should default object-form linkType to reference when omitted', async () => {
      projectRepo.getById.mockResolvedValue(createMockProject());
      taskRepo.create.mockResolvedValue('task-new');

      await service.createTask('proj-1', {
        title: 'Task',
        linkedNotes: [{ notePath: 'note.md' }]
      });

      expect(taskRepo.addNoteLink).toHaveBeenCalledWith('task-new', 'note.md', 'reference');
    });

    it('should handle a mixed array of string and object note links', async () => {
      projectRepo.getById.mockResolvedValue(createMockProject());
      taskRepo.create.mockResolvedValue('task-new');

      await service.createTask('proj-1', {
        title: 'Task with mixed notes',
        linkedNotes: [
          'plain.md',
          { notePath: 'consumed.md', linkType: 'input' },
          { notePath: 'untyped.md' }
        ]
      });

      expect(taskRepo.addNoteLink).toHaveBeenCalledTimes(3);
      expect(taskRepo.addNoteLink).toHaveBeenCalledWith('task-new', 'plain.md', 'reference');
      expect(taskRepo.addNoteLink).toHaveBeenCalledWith('task-new', 'consumed.md', 'input');
      expect(taskRepo.addNoteLink).toHaveBeenCalledWith('task-new', 'untyped.md', 'reference');
    });

    it('should throw when an object-form note link is missing notePath', async () => {
      projectRepo.getById.mockResolvedValue(createMockProject());
      taskRepo.create.mockResolvedValue('task-new');

      await expect(
        service.createTask('proj-1', {
          title: 'Task',
          // notePath omitted on the object form — must not silently persist an empty link
          linkedNotes: [{ linkType: 'input' } as unknown as { notePath: string; linkType: 'input' }]
        })
      ).rejects.toThrow('notePath is required');

      expect(taskRepo.addNoteLink).not.toHaveBeenCalled();
    });

    it('should throw when an object-form note link has an empty/whitespace notePath', async () => {
      projectRepo.getById.mockResolvedValue(createMockProject());
      taskRepo.create.mockResolvedValue('task-new');

      await expect(
        service.createTask('proj-1', {
          title: 'Task',
          linkedNotes: [{ notePath: '   ', linkType: 'input' }]
        })
      ).rejects.toThrow('notePath is required');

      expect(taskRepo.addNoteLink).not.toHaveBeenCalled();
    });

    it('should throw when a string-form note link is empty/whitespace', async () => {
      projectRepo.getById.mockResolvedValue(createMockProject());
      taskRepo.create.mockResolvedValue('task-new');

      await expect(
        service.createTask('proj-1', {
          title: 'Task',
          linkedNotes: ['  ']
        })
      ).rejects.toThrow('notePath is required');

      expect(taskRepo.addNoteLink).not.toHaveBeenCalled();
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

  // ============================================================================
  // Note Links enrichment on AI-facing read surfaces
  // ============================================================================

  describe('noteLinks enrichment on read surfaces', () => {
    it('listTasks attaches noteLinks (notePath + linkType) to each task', async () => {
      taskRepo.getByProject.mockResolvedValue(paginatedResult([
        createMockTask({ id: 't1' })
      ]));
      taskRepo.getNoteLinks.mockResolvedValue([
        { taskId: 't1', notePath: 'notes/source.md', linkType: 'input', created: 1 },
        { taskId: 't1', notePath: 'notes/result.md', linkType: 'output', created: 2 }
      ]);

      const result = await service.listTasks('proj-1');

      expect(taskRepo.getNoteLinks).toHaveBeenCalledWith('t1');
      expect(result.items[0].taskRef).toBe('T-t1');
      expect(result.items[0].noteLinks).toEqual([
        { notePath: 'notes/source.md', linkType: 'input' },
        { notePath: 'notes/result.md', linkType: 'output' }
      ]);
    });

    it('listTasks returns an empty noteLinks array when a task has no links', async () => {
      taskRepo.getByProject.mockResolvedValue(paginatedResult([createMockTask({ id: 't1' })]));
      taskRepo.getNoteLinks.mockResolvedValue([]);

      const result = await service.listTasks('proj-1');

      expect(result.items[0].noteLinks).toEqual([]);
    });

    it('listTasks falls back to an empty noteLinks array when the lookup rejects', async () => {
      taskRepo.getByProject.mockResolvedValue(paginatedResult([createMockTask({ id: 't1' })]));
      taskRepo.getNoteLinks.mockRejectedValue(new Error('lookup failed'));

      const result = await service.listTasks('proj-1');

      expect(result.items[0].noteLinks).toEqual([]);
    });

    it('getNextActions attaches noteLinks to ready tasks', async () => {
      taskRepo.getByProject.mockResolvedValue(paginatedResult([
        createMockTask({ id: 't1', status: 'todo', priority: 'high' })
      ]));
      taskRepo.getAllDependencyEdges.mockResolvedValue([]);
      taskRepo.getNoteLinks.mockResolvedValue([
        { taskId: 't1', notePath: 'spec.md', linkType: 'reference', created: 1 }
      ]);

      const result = await service.getNextActions('proj-1');

      expect(result[0].noteLinks).toEqual([{ notePath: 'spec.md', linkType: 'reference' }]);
    });

    it('getBlockedTasks attaches noteLinks to both the blocked task and its blockers', async () => {
      const depTask = createMockTask({ id: 'dep', status: 'in_progress' });
      const blockedTask = createMockTask({ id: 'blocked', status: 'todo' });
      taskRepo.getByProject.mockResolvedValue(paginatedResult([depTask, blockedTask]));
      taskRepo.getAllDependencyEdges.mockResolvedValue([
        { taskId: 'blocked', dependsOnTaskId: 'dep' }
      ]);
      taskRepo.getNoteLinks.mockImplementation(async (taskId: string) =>
        taskId === 'blocked'
          ? [{ taskId: 'blocked', notePath: 'out.md', linkType: 'output', created: 1 }]
          : [{ taskId: 'dep', notePath: 'in.md', linkType: 'input', created: 1 }]
      );

      const result = await service.getBlockedTasks('proj-1');

      expect(result[0].task.noteLinks).toEqual([{ notePath: 'out.md', linkType: 'output' }]);
      expect(result[0].blockedBy[0].noteLinks).toEqual([{ notePath: 'in.md', linkType: 'input' }]);
    });

    it('getDependencyTree attaches noteLinks to root, dependencies, and dependents', async () => {
      const rootTask = createMockTask({ id: 'root', projectId: 'proj-1' });
      const depTask = createMockTask({ id: 'dep', projectId: 'proj-1' });
      const dependentTask = createMockTask({ id: 'dependent', projectId: 'proj-1' });

      taskRepo.getById.mockResolvedValue(rootTask);
      taskRepo.getByProject.mockResolvedValue(paginatedResult([rootTask, depTask, dependentTask]));
      taskRepo.getAllDependencyEdges.mockResolvedValue([
        { taskId: 'root', dependsOnTaskId: 'dep' },
        { taskId: 'dependent', dependsOnTaskId: 'root' }
      ]);
      taskRepo.getNoteLinks.mockResolvedValue([
        { taskId: 'x', notePath: 'n.md', linkType: 'reference', created: 1 }
      ]);

      const result = await service.getDependencyTree('root');

      expect(result.task.noteLinks).toEqual([{ notePath: 'n.md', linkType: 'reference' }]);
      expect(result.dependencies[0].task.noteLinks).toEqual([{ notePath: 'n.md', linkType: 'reference' }]);
      expect(result.dependents[0].task.noteLinks).toEqual([{ notePath: 'n.md', linkType: 'reference' }]);
    });

    it('getWorkspaceSummary attaches noteLinks to nextActions and recentlyCompleted', async () => {
      const project = createMockProject({ id: 'proj-1', status: 'active' });
      const tasks = [
        createMockTask({ id: 'ready', status: 'todo', priority: 'high', projectId: 'proj-1' }),
        createMockTask({ id: 'done', status: 'done', completedAt: 5000, projectId: 'proj-1' })
      ];

      projectRepo.getByWorkspace.mockResolvedValue(paginatedResult([project]));
      taskRepo.getByWorkspace.mockResolvedValue(paginatedResult(tasks));
      taskRepo.getByProject.mockResolvedValue(paginatedResult(tasks));
      taskRepo.getAllDependencyEdges.mockResolvedValue([]);
      taskRepo.getNoteLinks.mockResolvedValue([
        { taskId: 'x', notePath: 'doc.md', linkType: 'reference', created: 1 }
      ]);

      const result = await service.getWorkspaceSummary('ws-1');

      expect(result.tasks.nextActions[0].noteLinks).toEqual([{ notePath: 'doc.md', linkType: 'reference' }]);
      expect(result.tasks.recentlyCompleted[0].noteLinks).toEqual([{ notePath: 'doc.md', linkType: 'reference' }]);
    });

    // F1: getBlockedTasks/getDependencyTree must enrich ONLY the tasks they actually
    // return, not every task in the project (getByProject pageSize 10000). These assert
    // the getNoteLinks fan-out is bounded by the returned subset.

    it('getBlockedTasks calls getNoteLinks only for blocked tasks and their blockers, not unrelated project tasks', async () => {
      const depTask = createMockTask({ id: 'dep', status: 'in_progress' });
      const blockedTask = createMockTask({ id: 'blocked', status: 'todo' });
      // Two unrelated tasks that exist in the project but are neither blocked nor blockers.
      const unrelated1 = createMockTask({ id: 'unrelated1', status: 'todo' });
      const unrelated2 = createMockTask({ id: 'unrelated2', status: 'done' });
      taskRepo.getByProject.mockResolvedValue(
        paginatedResult([depTask, blockedTask, unrelated1, unrelated2])
      );
      taskRepo.getAllDependencyEdges.mockResolvedValue([
        { taskId: 'blocked', dependsOnTaskId: 'dep' }
      ]);
      taskRepo.getNoteLinks.mockResolvedValue([]);

      await service.getBlockedTasks('proj-1');

      // Only 'blocked' (returned) + 'dep' (its blocker) should be enriched.
      const enrichedIds = taskRepo.getNoteLinks.mock.calls.map(call => call[0]).sort();
      expect(enrichedIds).toEqual(['blocked', 'dep']);
      expect(taskRepo.getNoteLinks).not.toHaveBeenCalledWith('unrelated1');
      expect(taskRepo.getNoteLinks).not.toHaveBeenCalledWith('unrelated2');
    });

    it('getDependencyTree calls getNoteLinks only for the root, dependencies, and dependents, not unrelated project tasks', async () => {
      const rootTask = createMockTask({ id: 'root', projectId: 'proj-1' });
      const depTask = createMockTask({ id: 'dep', projectId: 'proj-1' });
      const dependentTask = createMockTask({ id: 'dependent', projectId: 'proj-1' });
      // Unrelated task in the same project but not in root's dependency tree.
      const unrelated = createMockTask({ id: 'unrelated', projectId: 'proj-1' });

      taskRepo.getById.mockResolvedValue(rootTask);
      taskRepo.getByProject.mockResolvedValue(
        paginatedResult([rootTask, depTask, dependentTask, unrelated])
      );
      taskRepo.getAllDependencyEdges.mockResolvedValue([
        { taskId: 'root', dependsOnTaskId: 'dep' },
        { taskId: 'dependent', dependsOnTaskId: 'root' }
      ]);
      taskRepo.getNoteLinks.mockResolvedValue([]);

      await service.getDependencyTree('root');

      const enrichedIds = taskRepo.getNoteLinks.mock.calls.map(call => call[0]).sort();
      expect(enrichedIds).toEqual(['dep', 'dependent', 'root']);
      expect(taskRepo.getNoteLinks).not.toHaveBeenCalledWith('unrelated');
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

    it('should resolve a short taskRef before updating status', async () => {
      const task = createMockTask({ id: '12345678-90ab-cdef-1234-567890abcdef' });
      taskRepo.getById.mockImplementation(async (id: string) => (
        id === task.id ? task : null
      ));
      taskRepo.getByIdPrefix.mockResolvedValue([task]);

      await service.updateTask('T-12345678', { status: 'in_progress' });

      expect(taskRepo.getByIdPrefix).toHaveBeenCalledWith('12345678');
      expect(taskRepo.update).toHaveBeenCalledWith(task.id, expect.objectContaining({
        status: 'in_progress'
      }));
    });

    it('should reject ambiguous short taskRefs', async () => {
      taskRepo.getById.mockResolvedValue(null);
      taskRepo.getByIdPrefix.mockResolvedValue([
        createMockTask({ id: '12345678-0000-0000-0000-000000000000' }),
        createMockTask({ id: '12345678-ffff-ffff-ffff-ffffffffffff' })
      ]);

      await expect(
        service.updateTask('T-12345678', { status: 'done' })
      ).rejects.toThrow('ambiguous');

      expect(taskRepo.update).not.toHaveBeenCalled();
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

      // Must be null (not undefined): the repository's "no change" guards drop
      // undefined before it reaches the JSONL event / SQLite, so undefined would
      // leave the stale timestamp in place. null is the explicit-clear sentinel.
      expect(taskRepo.update).toHaveBeenCalledWith('task-1', expect.objectContaining({
        status: 'todo',
        completedAt: null
      }));
    });

    it('should heal a stale completedAt on a non-done task even when status is unchanged', async () => {
      // Reporter's case: task is in_progress but carries a leftover completedAt.
      taskRepo.getById.mockResolvedValue(createMockTask({ status: 'in_progress', completedAt: 5000 }));

      await service.updateTask('task-1', { status: 'in_progress' });

      const updateCall = taskRepo.update.mock.calls[0][1];
      expect(updateCall.completedAt).toBeNull();
    });

    it('should heal a stale completedAt when updating an unrelated field on a non-done task', async () => {
      // No status passed at all — the stale timestamp should still be cleared.
      taskRepo.getById.mockResolvedValue(createMockTask({ status: 'in_progress', completedAt: 5000 }));

      await service.updateTask('task-1', { title: 'Renamed' });

      const updateCall = taskRepo.update.mock.calls[0][1];
      expect(updateCall.completedAt).toBeNull();
    });

    it('should preserve completedAt when updating an unrelated field on a done task', async () => {
      taskRepo.getById.mockResolvedValue(createMockTask({ status: 'done', completedAt: 5000 }));

      await service.updateTask('task-1', { title: 'Renamed' });

      // Invariant holds (status still done) — leave the timestamp untouched.
      const updateCall = taskRepo.update.mock.calls[0][1];
      expect(updateCall.completedAt).toBeUndefined();
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
      expect(taskBoardNotifier.notify).toHaveBeenCalledWith({
        workspaceId: 'ws-1',
        entity: 'task',
        action: 'updated',
        taskId: 'task-1',
        projectId: 'proj-1'
      });
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
      taskRepo.getById.mockResolvedValue(createMockTask());

      await service.unlinkNote('task-1', 'path.md');

      expect(taskRepo.removeNoteLink).toHaveBeenCalledWith('task-1', 'path.md');
      expect(taskBoardNotifier.notify).toHaveBeenCalledWith({
        workspaceId: 'ws-1',
        entity: 'task',
        action: 'updated',
        taskId: 'task-1',
        projectId: 'proj-1'
      });
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

    it('should drain all task pages before computing counts and summaries (>200 truncation guard)', async () => {
      const activeProject = createMockProject({ id: 'active-project', status: 'active' });
      const archivedProject = createMockProject({ id: 'archived-project', status: 'archived' });
      const archivedTask = createMockTask({
        id: 'archived-task',
        projectId: 'archived-project',
        status: 'done',
        completedAt: 1000
      });
      const activeTask = createMockTask({
        id: 'active-task',
        projectId: 'active-project',
        status: 'todo',
        priority: 'high',
        created: 1
      });

      projectRepo.getByWorkspace.mockResolvedValue(paginatedResult([activeProject, archivedProject]));
      // Two task pages: the archived-project task lands on page 0, the active task
      // on page 1. A consumer that stopped after page 0 would miss the active task
      // entirely (issue #272) and would wrongly count the archived-project task.
      taskRepo.getByWorkspace
        .mockResolvedValueOnce(paginatedResult([archivedTask], {
          page: 0,
          pageSize: 200,
          totalItems: 2,
          totalPages: 2,
          hasNextPage: true
        }))
        .mockResolvedValueOnce(paginatedResult([activeTask], {
          page: 1,
          pageSize: 200,
          totalItems: 2,
          totalPages: 2,
          hasNextPage: false,
          hasPreviousPage: true
        }));
      taskRepo.getAllDependencyEdges.mockResolvedValue([]);

      const result = await service.getWorkspaceSummary('ws-1');

      // Both pages were drained.
      expect(taskRepo.getByWorkspace).toHaveBeenCalledTimes(2);
      expect(taskRepo.getByWorkspace).toHaveBeenNthCalledWith(1, 'ws-1', { page: 0, pageSize: 200 });
      expect(taskRepo.getByWorkspace).toHaveBeenNthCalledWith(2, 'ws-1', { page: 1, pageSize: 200 });
      // Archived-project task excluded; per-project count reflects only the visible task.
      expect(result.projects.items).toEqual([
        expect.objectContaining({ id: 'active-project', taskCount: 1, status: 'active' })
      ]);
      // tasks.total is visible-only and consistent with byStatus.
      expect(result.tasks.total).toBe(1);
      expect(result.tasks.byStatus.todo).toBe(1);
      expect(result.tasks.byStatus.done).toBe(0);
      expect(result.tasks.nextActions.map(task => task.id)).toEqual(['active-task']);
      expect(result.tasks.recentlyCompleted).toEqual([]);
      // projects.total stays the TRUE count (includes the archived project).
      expect(result.projects.total).toBe(2);
    });

    it('should keep projects.total as the true count while tasks.total is visible-only (intentional asymmetry)', async () => {
      const activeProject = createMockProject({ id: 'active-project', status: 'active' });
      const archivedProject = createMockProject({ id: 'archived-project', status: 'archived' });
      const visibleTask = createMockTask({ id: 'visible', projectId: 'active-project', status: 'todo' });
      const archivedProjectTask = createMockTask({ id: 'hidden', projectId: 'archived-project', status: 'todo' });

      projectRepo.getByWorkspace.mockResolvedValue(paginatedResult([activeProject, archivedProject]));
      taskRepo.getByWorkspace.mockResolvedValue(paginatedResult([visibleTask, archivedProjectTask]));
      taskRepo.getAllDependencyEdges.mockResolvedValue([]);

      const result = await service.getWorkspaceSummary('ws-1');

      expect(result.projects.total).toBe(2);  // includes archived project
      expect(result.tasks.total).toBe(1);      // excludes archived-project task
      expect(result.tasks.byStatus.todo).toBe(1);
    });

    it('should not count archived-project tasks when every project is archived (orphan-only visibility)', async () => {
      const archivedProject = createMockProject({ id: 'archived-project', status: 'archived' });
      const archivedProjectTask = createMockTask({ id: 'in-archived', projectId: 'archived-project', status: 'todo' });
      const orphanTask = createMockTask({ id: 'orphan', projectId: 'no-such-project', status: 'todo' });

      projectRepo.getByWorkspace.mockResolvedValue(paginatedResult([archivedProject]));
      taskRepo.getByWorkspace.mockResolvedValue(paginatedResult([archivedProjectTask, orphanTask]));
      taskRepo.getAllDependencyEdges.mockResolvedValue([]);

      const result = await service.getWorkspaceSummary('ws-1');

      // Archived-project task is excluded; the genuinely projectless task stays visible.
      expect(result.tasks.total).toBe(1);
      expect(result.tasks.byStatus.todo).toBe(1);
      expect(result.projects.items).toHaveLength(0);  // no visible projects
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
