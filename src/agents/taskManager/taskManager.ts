/**
 * Location: src/agents/taskManager/taskManager.ts
 * Purpose: TaskManager agent — workspace-scoped project and task management with DAG dependencies.
 * Extends BaseAgent with lazy tool registration following the CanvasManager pattern.
 *
 * Used by: ToolManager (Two-Tool Architecture), AgentRegistrationService, ServiceFactory
 * Dependencies: TaskService (injected via constructor)
 */

import { App } from 'obsidian';
import { BaseAgent } from '../baseAgent';
import { TaskService } from './services/TaskService';

// Project tools
import { CreateProjectTool } from './tools/projects/createProject';
import { ListProjectsTool } from './tools/projects/listProjects';
import { UpdateProjectTool } from './tools/projects/updateProject';
import { ArchiveProjectTool } from './tools/projects/archiveProject';

// Task tools
import { CreateTaskTool } from './tools/tasks/createTask';
import { ListTasksTool } from './tools/tasks/listTasks';
import { UpdateTaskTool } from './tools/tasks/updateTask';
import { MoveTaskTool } from './tools/tasks/moveTask';
import { QueryTasksTool } from './tools/tasks/queryTasks';

// Link tools
import { LinkNoteTool } from './tools/links/linkNote';

/**
 * Agent for workspace-scoped project and task management with DAG-like dependencies.
 *
 * Tools (10 total):
 * - Projects: createProject, listProjects, updateProject, archiveProject
 * - Tasks: createTask, listTasks, updateTask, moveTask, queryTasks
 * - Links: linkNote
 *
 * Data model: Workspace > Project > Task with dependsOn[] for DAG edges
 * and parentTaskId for subtask hierarchy.
 */
export class TaskManagerAgent extends BaseAgent {
  private app: App;
  private taskService: TaskService;

  constructor(app: App, plugin: any, taskService: TaskService) {
    super(
      'taskManager',
      'Workspace-scoped project and task management with DAG dependencies. Create projects, manage tasks with priorities/assignees/due dates, define dependency chains, query next actions and blockers, and link tasks to vault notes.',
      '1.0.0'
    );

    this.app = app;
    this.taskService = taskService;

    // Register project tools (4) — lazy loaded
    this.registerLazyTool({
      slug: 'createProject', name: 'Create Project',
      description: 'Create a new project within a workspace',
      version: '1.0.0',
      factory: () => new CreateProjectTool(this.taskService),
    });
    this.registerLazyTool({
      slug: 'listProjects', name: 'List Projects',
      description: 'List projects in a workspace with optional status filter',
      version: '1.0.0',
      factory: () => new ListProjectsTool(this.taskService),
    });
    this.registerLazyTool({
      slug: 'updateProject', name: 'Update Project',
      description: 'Update project metadata or status',
      version: '1.0.0',
      factory: () => new UpdateProjectTool(this.taskService),
    });
    this.registerLazyTool({
      slug: 'archiveProject', name: 'Archive Project',
      description: 'Archive a project (soft-delete)',
      version: '1.0.0',
      factory: () => new ArchiveProjectTool(this.taskService),
    });

    // Register task tools (4) — lazy loaded
    this.registerLazyTool({
      slug: 'createTask', name: 'Create Task',
      description: 'Create a task with optional dependencies, subtask parent, priority, and note links',
      version: '1.0.0',
      factory: () => new CreateTaskTool(this.taskService),
    });
    this.registerLazyTool({
      slug: 'listTasks', name: 'List Tasks',
      description: 'List tasks in a project with filters for status, priority, assignee',
      version: '1.0.0',
      factory: () => new ListTasksTool(this.taskService),
    });
    this.registerLazyTool({
      slug: 'updateTask', name: 'Update Task',
      description: 'Update task fields, status, or manage dependencies',
      version: '1.0.0',
      factory: () => new UpdateTaskTool(this.taskService),
    });
    this.registerLazyTool({
      slug: 'moveTask', name: 'Move Task',
      description: 'Move a task to a different project or change its parent task',
      version: '1.0.0',
      factory: () => new MoveTaskTool(this.taskService),
    });

    // Register query tool (1) — lazy loaded
    this.registerLazyTool({
      slug: 'queryTasks', name: 'Query Tasks',
      description: 'DAG queries: get next actionable tasks, blocked tasks, or dependency tree for a task',
      version: '1.0.0',
      factory: () => new QueryTasksTool(this.taskService),
    });

    // Register link tool (1) — lazy loaded
    this.registerLazyTool({
      slug: 'linkNote', name: 'Link Note',
      description: 'Link or unlink a vault note to/from a task',
      version: '1.0.0',
      factory: () => new LinkNoteTool(this.taskService),
    });
  }

  /**
   * Get the TaskService instance for external use (e.g., loadWorkspace integration).
   */
  getTaskService(): TaskService {
    return this.taskService;
  }

  /**
   * Get the App instance.
   */
  getApp(): App {
    return this.app;
  }
}
