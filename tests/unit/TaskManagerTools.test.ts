/**
 * TaskManager Tools Unit Tests
 *
 * Tests all 10 TaskManager tools for parameter validation, service delegation,
 * and error handling. Uses mocked TaskService.
 *
 * Coverage target: 80%+ (thin tool layer)
 */

import { CreateProjectTool } from '../../src/agents/taskManager/tools/projects/createProject';
import { ListProjectsTool } from '../../src/agents/taskManager/tools/projects/listProjects';
import { UpdateProjectTool } from '../../src/agents/taskManager/tools/projects/updateProject';
import { ArchiveProjectTool } from '../../src/agents/taskManager/tools/projects/archiveProject';
import { CreateTaskTool } from '../../src/agents/taskManager/tools/tasks/createTask';
import { ListTasksTool } from '../../src/agents/taskManager/tools/tasks/listTasks';
import { UpdateTaskTool } from '../../src/agents/taskManager/tools/tasks/updateTask';
import { MoveTaskTool } from '../../src/agents/taskManager/tools/tasks/moveTask';
import { QueryTasksTool } from '../../src/agents/taskManager/tools/tasks/queryTasks';
import { LinkNoteTool } from '../../src/agents/taskManager/tools/links/linkNote';
import { TaskService } from '../../src/agents/taskManager/services/TaskService';
import type {
  DependencyTree,
  QueryTasksParameters,
  TaskMetadata,
  TaskWithBlockers
} from '../../src/agents/taskManager/types';

// ============================================================================
// Mock TaskService
// ============================================================================

function createMockTaskService(): jest.Mocked<TaskService> {
  return {
    createProject: jest.fn(),
    listProjects: jest.fn(),
    updateProject: jest.fn(),
    archiveProject: jest.fn(),
    createTask: jest.fn(),
    listTasks: jest.fn(),
    updateTask: jest.fn(),
    moveTask: jest.fn(),
    addDependency: jest.fn(),
    removeDependency: jest.fn(),
    getNextActions: jest.fn(),
    getBlockedTasks: jest.fn(),
    getDependencyTree: jest.fn(),
    linkNote: jest.fn(),
    unlinkNote: jest.fn(),
    getTasksForNote: jest.fn(),
    getWorkspaceSummary: jest.fn()
  } as unknown as jest.Mocked<TaskService>;
}

function createTaskMetadata(overrides: Partial<TaskMetadata> = {}): TaskMetadata {
  return {
    id: 't1',
    projectId: 'proj-1',
    workspaceId: 'ws-1',
    title: 'Task 1',
    status: 'todo',
    priority: 'medium',
    created: 0,
    updated: 0,
    ...overrides
  };
}

function createTaskWithBlockers(task: TaskMetadata): TaskWithBlockers {
  return {
    task,
    blockedBy: []
  };
}

function createDependencyTree(task: TaskMetadata): DependencyTree {
  return {
    task,
    dependencies: [],
    dependents: []
  };
}

// Common params that tools extend
const baseParams = {
  context: { workspaceId: 'ws-1', sessionId: 'sess-1', memory: '', goal: 'test' }
};

describe('TaskManager Tools', () => {
  let mockService: jest.Mocked<TaskService>;

  beforeEach(() => {
    mockService = createMockTaskService();
  });

  // ============================================================================
  // CreateProjectTool
  // ============================================================================

  describe('CreateProjectTool', () => {
    let tool: CreateProjectTool;

    beforeEach(() => {
      tool = new CreateProjectTool(mockService);
    });

    it('should create project successfully', async () => {
      mockService.createProject.mockResolvedValue('proj-new');

      const result = await tool.execute({
        ...baseParams,
        workspaceId: 'ws-1',
        name: 'My Project',
        description: 'A test'
      });

      expect(result.success).toBe(true);
      expect(result.projectId).toBe('proj-new');
      expect(mockService.createProject).toHaveBeenCalledWith('ws-1', {
        name: 'My Project',
        description: 'A test',
        metadata: undefined
      });
    });

    it('should return error when workspaceId missing', async () => {
      const result = await tool.execute({
        ...baseParams,
        workspaceId: '',
        name: 'Project'
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('workspaceId');
    });

    it('should return error when name missing', async () => {
      const result = await tool.execute({
        ...baseParams,
        workspaceId: 'ws-1',
        name: ''
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('name');
    });

    it('should handle service error gracefully', async () => {
      mockService.createProject.mockRejectedValue(new Error('Duplicate name'));

      const result = await tool.execute({
        ...baseParams,
        workspaceId: 'ws-1',
        name: 'Duplicate'
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Duplicate name');
    });

    it('should return valid parameter schema', () => {
      const schema = tool.getParameterSchema();
      expect(schema.type).toBe('object');
      expect(schema.required).toContain('workspaceId');
      expect(schema.required).toContain('name');
    });

    it('should return valid result schema', () => {
      const schema = tool.getResultSchema();
      expect(schema.type).toBe('object');
    });
  });

  // ============================================================================
  // ListProjectsTool
  // ============================================================================

  describe('ListProjectsTool', () => {
    let tool: ListProjectsTool;

    beforeEach(() => {
      tool = new ListProjectsTool(mockService);
    });

    it('should list projects successfully', async () => {
      mockService.listProjects.mockResolvedValue({
        items: [{ id: 'p1', name: 'Project 1', workspaceId: 'ws-1', status: 'active', created: 0, updated: 0 }],
        totalItems: 1,
        totalPages: 1,
        currentPage: 1,
        pageSize: 20,
        hasNextPage: false
      });

      const result = await tool.execute({ ...baseParams, workspaceId: 'ws-1' });

      expect(result.success).toBe(true);
      expect(result.projects).toHaveLength(1);
    });

    it('should return error when workspaceId missing', async () => {
      const result = await tool.execute({ ...baseParams, workspaceId: '' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('workspaceId');
    });

    it('should pass filter options through', async () => {
      mockService.listProjects.mockResolvedValue({
        items: [],
        totalItems: 0,
        totalPages: 0,
        currentPage: 1,
        pageSize: 10,
        hasNextPage: false
      });

      await tool.execute({
        ...baseParams,
        workspaceId: 'ws-1',
        status: 'active',
        page: 2,
        pageSize: 10
      });

      expect(mockService.listProjects).toHaveBeenCalledWith('ws-1', expect.objectContaining({
        status: 'active',
        page: 2,
        pageSize: 10
      }));
    });
  });

  // ============================================================================
  // UpdateProjectTool
  // ============================================================================

  describe('UpdateProjectTool', () => {
    let tool: UpdateProjectTool;

    beforeEach(() => {
      tool = new UpdateProjectTool(mockService);
    });

    it('should update project successfully', async () => {
      mockService.updateProject.mockResolvedValue();

      const result = await tool.execute({
        ...baseParams,
        projectId: 'proj-1',
        name: 'Updated Name'
      });

      expect(result.success).toBe(true);
    });

    it('should return error when projectId missing', async () => {
      const result = await tool.execute({ ...baseParams, projectId: '' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('projectId');
    });

    it('should handle service error', async () => {
      mockService.updateProject.mockRejectedValue(new Error('Not found'));

      const result = await tool.execute({
        ...baseParams,
        projectId: 'nonexistent',
        name: 'X'
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Not found');
    });
  });

  // ============================================================================
  // ArchiveProjectTool
  // ============================================================================

  describe('ArchiveProjectTool', () => {
    let tool: ArchiveProjectTool;

    beforeEach(() => {
      tool = new ArchiveProjectTool(mockService);
    });

    it('should archive project successfully', async () => {
      mockService.archiveProject.mockResolvedValue();

      const result = await tool.execute({
        ...baseParams,
        projectId: 'proj-1'
      });

      expect(result.success).toBe(true);
      expect(mockService.archiveProject).toHaveBeenCalledWith('proj-1');
    });

    it('should return error when projectId missing', async () => {
      const result = await tool.execute({ ...baseParams, projectId: '' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('projectId');
    });
  });

  // ============================================================================
  // CreateTaskTool
  // ============================================================================

  describe('CreateTaskTool', () => {
    let tool: CreateTaskTool;

    beforeEach(() => {
      tool = new CreateTaskTool(mockService);
    });

    it('should create task successfully', async () => {
      mockService.createTask.mockResolvedValue('task-new');

      const result = await tool.execute({
        ...baseParams,
        projectId: 'proj-1',
        title: 'New Task',
        priority: 'high'
      });

      expect(result.success).toBe(true);
      expect(result.taskId).toBe('task-new');
    });

    it('should return error when projectId missing', async () => {
      const result = await tool.execute({
        ...baseParams,
        projectId: '',
        title: 'Task'
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('projectId');
    });

    it('should return error when title missing', async () => {
      const result = await tool.execute({
        ...baseParams,
        projectId: 'proj-1',
        title: ''
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('title');
    });

    it('should pass all optional params to service', async () => {
      mockService.createTask.mockResolvedValue('task-new');

      await tool.execute({
        ...baseParams,
        projectId: 'proj-1',
        title: 'Full Task',
        description: 'Desc',
        parentTaskId: 'parent-1',
        priority: 'critical',
        dueDate: 9999,
        assignee: 'alice',
        tags: ['bug', 'urgent'],
        dependsOn: ['dep-1'],
        linkedNotes: ['note.md'],
        metadata: { key: 'value' }
      });

      expect(mockService.createTask).toHaveBeenCalledWith('proj-1', {
        title: 'Full Task',
        description: 'Desc',
        parentTaskId: 'parent-1',
        priority: 'critical',
        dueDate: 9999,
        assignee: 'alice',
        tags: ['bug', 'urgent'],
        dependsOn: ['dep-1'],
        linkedNotes: ['note.md'],
        metadata: { key: 'value' }
      });
    });

    it('should handle cycle error from service', async () => {
      mockService.createTask.mockRejectedValue(new Error('would create a cycle'));

      const result = await tool.execute({
        ...baseParams,
        projectId: 'proj-1',
        title: 'Cyclic'
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('cycle');
    });
  });

  // ============================================================================
  // ListTasksTool
  // ============================================================================

  describe('ListTasksTool', () => {
    let tool: ListTasksTool;

    beforeEach(() => {
      tool = new ListTasksTool(mockService);
    });

    it('should list tasks successfully', async () => {
      mockService.listTasks.mockResolvedValue({
        items: [],
        totalItems: 0,
        totalPages: 0,
        currentPage: 1,
        pageSize: 20,
        hasNextPage: false
      });

      const result = await tool.execute({
        ...baseParams,
        projectId: 'proj-1'
      });

      expect(result.success).toBe(true);
    });

    it('should return error when projectId missing', async () => {
      const result = await tool.execute({ ...baseParams, projectId: '' });
      expect(result.success).toBe(false);
    });
  });

  // ============================================================================
  // UpdateTaskTool
  // ============================================================================

  describe('UpdateTaskTool', () => {
    let tool: UpdateTaskTool;

    beforeEach(() => {
      tool = new UpdateTaskTool(mockService);
    });

    it('should update task fields', async () => {
      mockService.updateTask.mockResolvedValue();

      const result = await tool.execute({
        ...baseParams,
        taskId: 'task-1',
        title: 'Updated',
        status: 'in_progress'
      });

      expect(result.success).toBe(true);
      expect(mockService.updateTask).toHaveBeenCalledWith('task-1', expect.objectContaining({
        title: 'Updated',
        status: 'in_progress'
      }));
    });

    it('should return error when taskId missing', async () => {
      const result = await tool.execute({ ...baseParams, taskId: '' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('taskId');
    });

    it('should add dependencies', async () => {
      mockService.addDependency.mockResolvedValue();

      const result = await tool.execute({
        ...baseParams,
        taskId: 'task-1',
        addDependencies: ['dep-1', 'dep-2']
      });

      expect(result.success).toBe(true);
      expect(mockService.addDependency).toHaveBeenCalledTimes(2);
      expect(mockService.addDependency).toHaveBeenCalledWith('task-1', 'dep-1');
      expect(mockService.addDependency).toHaveBeenCalledWith('task-1', 'dep-2');
    });

    it('should remove dependencies', async () => {
      mockService.removeDependency.mockResolvedValue();

      const result = await tool.execute({
        ...baseParams,
        taskId: 'task-1',
        removeDependencies: ['dep-1']
      });

      expect(result.success).toBe(true);
      expect(mockService.removeDependency).toHaveBeenCalledWith('task-1', 'dep-1');
    });

    it('should handle both add and remove dependencies', async () => {
      mockService.addDependency.mockResolvedValue();
      mockService.removeDependency.mockResolvedValue();

      const result = await tool.execute({
        ...baseParams,
        taskId: 'task-1',
        addDependencies: ['new-dep'],
        removeDependencies: ['old-dep']
      });

      expect(result.success).toBe(true);
      expect(mockService.addDependency).toHaveBeenCalledWith('task-1', 'new-dep');
      expect(mockService.removeDependency).toHaveBeenCalledWith('task-1', 'old-dep');
    });

    it('should handle dependency error', async () => {
      mockService.addDependency.mockRejectedValue(new Error('cycle detected'));

      const result = await tool.execute({
        ...baseParams,
        taskId: 'task-1',
        addDependencies: ['bad-dep']
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('cycle');
    });
  });

  // ============================================================================
  // MoveTaskTool
  // ============================================================================

  describe('MoveTaskTool', () => {
    let tool: MoveTaskTool;

    beforeEach(() => {
      tool = new MoveTaskTool(mockService);
    });

    it('should move task to new project', async () => {
      mockService.moveTask.mockResolvedValue();

      const result = await tool.execute({
        ...baseParams,
        taskId: 'task-1',
        projectId: 'proj-2'
      });

      expect(result.success).toBe(true);
      expect(mockService.moveTask).toHaveBeenCalledWith('task-1', {
        projectId: 'proj-2',
        parentTaskId: undefined
      });
    });

    it('should move task to new parent', async () => {
      mockService.moveTask.mockResolvedValue();

      const result = await tool.execute({
        ...baseParams,
        taskId: 'task-1',
        parentTaskId: 'parent-2'
      });

      expect(result.success).toBe(true);
    });

    it('should move task to top-level (null parent)', async () => {
      mockService.moveTask.mockResolvedValue();

      const result = await tool.execute({
        ...baseParams,
        taskId: 'task-1',
        parentTaskId: null
      });

      expect(result.success).toBe(true);
    });

    it('should return error when taskId missing', async () => {
      const result = await tool.execute({ ...baseParams, taskId: '' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('taskId');
    });

    it('should return error when neither projectId nor parentTaskId provided', async () => {
      const result = await tool.execute({
        ...baseParams,
        taskId: 'task-1'
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('At least one');
    });

    it('should handle cross-workspace error', async () => {
      mockService.moveTask.mockRejectedValue(new Error('different workspace'));

      const result = await tool.execute({
        ...baseParams,
        taskId: 'task-1',
        projectId: 'proj-other'
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('different workspace');
    });
  });

  // ============================================================================
  // QueryTasksTool
  // ============================================================================

  describe('QueryTasksTool', () => {
    let tool: QueryTasksTool;

    beforeEach(() => {
      tool = new QueryTasksTool(mockService);
    });

    it('should query next actions', async () => {
      const task = createTaskMetadata();
      mockService.getNextActions.mockResolvedValue([
        task
      ]);

      const result = await tool.execute({
        ...baseParams,
        projectId: 'proj-1',
        query: 'nextActions'
      });

      expect(result.success).toBe(true);
      expect(result.query).toBe('nextActions');
      expect(result.tasks).toHaveLength(1);
    });

    it('should query blocked tasks', async () => {
      const task = createTaskMetadata();
      mockService.getBlockedTasks.mockResolvedValue([
        createTaskWithBlockers(task)
      ]);

      const result = await tool.execute({
        ...baseParams,
        projectId: 'proj-1',
        query: 'blockedTasks'
      });

      expect(result.success).toBe(true);
      expect(result.query).toBe('blockedTasks');
      expect(result.blockedTasks).toHaveLength(1);
    });

    it('should query dependency tree', async () => {
      const task = createTaskMetadata();
      mockService.getDependencyTree.mockResolvedValue({
        ...createDependencyTree(task)
      });

      const result = await tool.execute({
        ...baseParams,
        projectId: 'proj-1',
        query: 'dependencyTree',
        taskId: 't1'
      });

      expect(result.success).toBe(true);
      expect(result.query).toBe('dependencyTree');
      expect(result.tree).toBeDefined();
    });

    it('should return error when projectId missing', async () => {
      const result = await tool.execute({
        ...baseParams,
        projectId: '',
        query: 'nextActions'
      });
      expect(result.success).toBe(false);
    });

    it('should return error when query missing', async () => {
      const result = await tool.execute({
        ...baseParams,
        projectId: 'proj-1',
        query: '' as unknown as QueryTasksParameters['query']
      });
      expect(result.success).toBe(false);
    });

    it('should return error for dependencyTree without taskId', async () => {
      const result = await tool.execute({
        ...baseParams,
        projectId: 'proj-1',
        query: 'dependencyTree'
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('taskId');
    });

    it('should return error for unknown query type', async () => {
      const result = await tool.execute({
        ...baseParams,
        projectId: 'proj-1',
        query: 'unknownQuery' as unknown as QueryTasksParameters['query']
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Unknown query type');
    });
  });

  // ============================================================================
  // LinkNoteTool
  // ============================================================================

  describe('LinkNoteTool', () => {
    let tool: LinkNoteTool;

    beforeEach(() => {
      tool = new LinkNoteTool(mockService);
    });

    it('should link note with default type', async () => {
      mockService.linkNote.mockResolvedValue();

      const result = await tool.execute({
        ...baseParams,
        taskId: 'task-1',
        notePath: 'path/to/note.md'
      });

      expect(result.success).toBe(true);
      expect(mockService.linkNote).toHaveBeenCalledWith('task-1', 'path/to/note.md', 'reference');
    });

    it('should link note with explicit type', async () => {
      mockService.linkNote.mockResolvedValue();

      const result = await tool.execute({
        ...baseParams,
        taskId: 'task-1',
        notePath: 'output.md',
        linkType: 'output'
      });

      expect(result.success).toBe(true);
      expect(mockService.linkNote).toHaveBeenCalledWith('task-1', 'output.md', 'output');
    });

    it('should unlink note', async () => {
      mockService.unlinkNote.mockResolvedValue();

      const result = await tool.execute({
        ...baseParams,
        taskId: 'task-1',
        notePath: 'path.md',
        action: 'unlink'
      });

      expect(result.success).toBe(true);
      expect(mockService.unlinkNote).toHaveBeenCalledWith('task-1', 'path.md');
    });

    it('should return error when taskId missing', async () => {
      const result = await tool.execute({
        ...baseParams,
        taskId: '',
        notePath: 'note.md'
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('taskId');
    });

    it('should return error when notePath missing', async () => {
      const result = await tool.execute({
        ...baseParams,
        taskId: 'task-1',
        notePath: ''
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('notePath');
    });

    it('should handle service error', async () => {
      mockService.linkNote.mockRejectedValue(new Error('Task not found'));

      const result = await tool.execute({
        ...baseParams,
        taskId: 'nonexistent',
        notePath: 'note.md'
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Task not found');
    });
  });
});
