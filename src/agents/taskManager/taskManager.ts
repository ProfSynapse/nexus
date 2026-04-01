/**
 * Location: src/agents/taskManager/taskManager.ts
 * Purpose: TaskManager agent — workspace-scoped project and task management with DAG dependencies.
 * Extends BaseAgent with lazy tool registration following the CanvasManager pattern.
 *
 * Used by: ToolManager (Two-Tool Architecture), AgentRegistrationService
 * Dependencies: TaskService (injected via constructor)
 */

import { App } from 'obsidian';
import type NexusPlugin from '../../main';
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
import { OpenTasksTool } from './tools/tasks/openTasks';
import { UpdateTaskTool } from './tools/tasks/updateTask';
import { MoveTaskTool } from './tools/tasks/moveTask';
import { QueryTasksTool } from './tools/tasks/queryTasks';

// Link tools
import { LinkNoteTool } from './tools/links/linkNote';

/**
 * Agent for workspace-scoped project and task management with DAG-like dependencies.
 *
 * Tools (11 total):
 * - Projects: createProject, listProjects, updateProject, archiveProject
 * - Tasks: createTask, listTasks, openTasks, updateTask, moveTask, queryTasks
 * - Links: linkNote
 *
 * Data model: Workspace > Project > Task with dependsOn[] for DAG edges
 * and parentTaskId for subtask hierarchy.
 */
export class TaskManagerAgent extends BaseAgent {
  private app: App;
  private taskService: TaskService;

  constructor(app: App, plugin: NexusPlugin, taskService: TaskService) {
    super(
      'taskManager',
      'Workspace-scoped project and task management with DAG dependencies. Data model: Workspace → Project → Task. Two relationship types: dependsOn[] creates DAG edges between tasks (task cannot start until dependencies are done; cycles are rejected), parentTaskId nests subtasks under a parent (organizational hierarchy). Typical workflow: loadWorkspace → listProjects → createProject → createTask → queryTasks (nextActions) to find ready work, or openTasks for the visual board. 11 tools: createProject, listProjects, updateProject, archiveProject, createTask, listTasks, openTasks, updateTask, moveTask, queryTasks, linkNote.',
      '1.0.0'
    );

    void plugin;
    this.app = app;
    this.taskService = taskService;

    // Register project tools (4) — lazy loaded
    this.registerLazyTool({
      slug: 'createProject', name: 'Create Project',
      description: 'Create a new project within a workspace. Projects organize tasks and must have a unique name per workspace. Requires a workspaceId (from loadWorkspace or createWorkspace). Returns the new projectId.',
      version: '1.0.0',
      factory: () => new CreateProjectTool(this.taskService),
    });
    this.registerLazyTool({
      slug: 'listProjects', name: 'List Projects',
      description: 'List projects in a workspace with optional status filter (active/completed/archived). Returns paginated project objects with id, name, description, status, and timestamps. Use to discover projectIds for task operations.',
      version: '1.0.0',
      factory: () => new ListProjectsTool(this.taskService),
    });
    this.registerLazyTool({
      slug: 'updateProject', name: 'Update Project',
      description: 'Update a project\'s name, description, status (active/completed/archived), or custom metadata. Requires a projectId (from createProject or listProjects).',
      version: '1.0.0',
      factory: () => new UpdateProjectTool(this.taskService),
    });
    this.registerLazyTool({
      slug: 'archiveProject', name: 'Archive Project',
      description: 'Archive a project by setting its status to \'archived\' (soft-delete). The project and its tasks remain queryable but are excluded from active listings. Requires a projectId (from createProject or listProjects).',
      version: '1.0.0',
      factory: () => new ArchiveProjectTool(this.taskService),
    });

    // Register task tools (4) — lazy loaded
    this.registerLazyTool({
      slug: 'createTask', name: 'Create Task',
      description: 'Create a task within a project. Requires a projectId (from createProject or listProjects). Supports optional priority (critical/high/medium/low), assignee, dueDate, tags, dependsOn[] for DAG edges (cycles rejected), parentTaskId for subtask nesting, and linkedNotes[] for vault note links. Returns the new taskId.',
      version: '1.0.0',
      factory: () => new CreateTaskTool(this.taskService),
    });
    this.registerLazyTool({
      slug: 'listTasks', name: 'List Tasks',
      description: 'List tasks in a project with optional filters for status (todo/in_progress/done/cancelled), priority, assignee, and parentTaskId. Returns paginated task objects with full metadata including dependencies and timestamps.',
      version: '1.0.0',
      factory: () => new ListTasksTool(this.taskService),
    });
    this.registerLazyTool({
      slug: 'openTasks', name: 'Open Tasks',
      description: 'Open the native Task Board workspace view in Obsidian. Optional filters let you preselect a workspace, project, or search query before the board is shown.',
      version: '1.0.0',
      factory: () => new OpenTasksTool(this.app),
    });
    this.registerLazyTool({
      slug: 'updateTask', name: 'Update Task',
      description: 'Update task fields (title, description, status, priority, dueDate, assignee, tags), manage DAG dependencies (addDependencies/removeDependencies), and manage note links (addNoteLinks/removeNoteLinks). Dependency additions are validated for cycles. Requires a taskId (from createTask or listTasks).',
      version: '1.0.0',
      factory: () => new UpdateTaskTool(this.taskService),
    });
    this.registerLazyTool({
      slug: 'moveTask', name: 'Move Task',
      description: 'Move a task to a different project within the same workspace, or change its parent task (set parentTaskId to nest as subtask, null to make top-level). Requires a taskId (from createTask or listTasks).',
      version: '1.0.0',
      factory: () => new MoveTaskTool(this.taskService),
    });

    // Register query tool (1) — lazy loaded
    this.registerLazyTool({
      slug: 'queryTasks', name: 'Query Tasks',
      description: 'DAG-aware queries on a project\'s tasks. Three query types: nextActions returns tasks ready to start (status=todo and all dependencies done), blockedTasks returns tasks waiting on incomplete dependencies with their blocker details, dependencyTree returns the full upstream/downstream dependency graph for a specific task. Requires projectId; dependencyTree also requires taskId.',
      version: '1.0.0',
      factory: () => new QueryTasksTool(this.taskService),
    });

    // Register link tool (1) — lazy loaded
    this.registerLazyTool({
      slug: 'linkNote', name: 'Link Note',
      description: 'Create or remove a bidirectional link between a vault note and a task. Link types: reference (related note), output (task produces this note), input (task consumes this note). Use action=unlink to remove an existing link.',
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
