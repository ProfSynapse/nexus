# TaskManager Agent: Architecture Specification

> Validated against approved plan (`docs/plans/task-manager-agent-plan.md`) and PREPARE research (`docs/preparation/task-manager-agent-research.md`)
> Date: 2026-03-08

---

## 1. Executive Summary

A new **TaskManager** agent providing workspace-scoped project and task management with DAG-like dependencies. Data model: Workspace > Project > Task with `dependsOn[]` for DAG edges and `parentTaskId` for subtask hierarchy. Storage follows the existing JSONL + SQLite hybrid pattern. 10 tools exposed via the Two-Tool Architecture.

**Plan validation result**: The approved plan holds. PREPARE findings confirm all integration points are safe. Three adjustments identified (see Section 10).

---

## 2. Component Diagram

### Files to Create (~18 files)

```
src/agents/taskManager/
  taskManager.ts                          # Agent class, extends BaseAgent, lazy tool registration
  types.ts                                # Parameter/result types for all 10 tools
  services/
    TaskService.ts                        # Business logic facade (ITaskService)
    DAGService.ts                         # Pure computation, no storage (IDAGService)
  tools/
    projects/
      createProject.ts                    # Create workspace-scoped project
      listProjects.ts                     # List/filter projects
      updateProject.ts                    # Update project metadata/status
      archiveProject.ts                   # Soft-delete (status -> archived)
    tasks/
      createTask.ts                       # Create task with deps, parent, priority
      listTasks.ts                        # List/filter by project, status, assignee
      updateTask.ts                       # Update fields, manage deps
      moveTask.ts                         # Re-parent or move between projects
      queryTasks.ts                       # DAG queries: nextActions, blockedTasks, dependencyTree
    links/
      linkNote.ts                         # Bidirectional note linking

src/database/repositories/
  ProjectRepository.ts                    # Extends BaseRepository<ProjectMetadata>
  TaskRepository.ts                       # Extends BaseRepository<TaskMetadata>
  interfaces/
    IProjectRepository.ts                 # Project-specific query interface
    ITaskRepository.ts                    # Task-specific query interface
```

### Files to Modify (~8 files)

| File | Change | Details |
|------|--------|---------|
| `src/database/schema/schema.ts` | Add DDL | 4 tables + 13 indexes (see Section 5) |
| `src/database/schema/SchemaMigrator.ts` | Add migration | v8 -> v9, `CURRENT_SCHEMA_VERSION = 9` |
| `src/database/repositories/base/BaseRepository.ts` | Extend union | Add `'project' \| 'task'` to `CacheableEntityType` (line 36) + update guard (line 219) |
| `src/database/optimizations/QueryCache.ts` | Add methods + extend signatures | `projectKey()`, `taskKey()` static methods; extend `invalidateByType`/`invalidateById` parameter unions (lines 246, 263-264) |
| `src/agents/index.ts` | Add export | `export * from './taskManager/taskManager';` |
| `src/agents/baseAgent.ts` | Add to array | Add `'taskManager'` to `agentNames` array (line 181) |
| `src/core/ServiceFactory.ts` | Add factory | New `TaskManagerAgentFactory` class + register in `AgentFactoryRegistry` constructor |
| `src/services/agent/AgentRegistrationService.ts` | Add to agent list | Add `'taskManager'` to `agentNames` array (line 128) |
| `src/agents/memoryManager/tools/workspaces/loadWorkspace.ts` | Add task summary | Inject `taskSummary` via conditional spread at line 182 |

### C4 Level 3 — Component Diagram

```
+---------------------------------------------------------------+
|                     TaskManager Agent                          |
|  +-----------+  +-----------+  +-----------+  +-------------+ |
|  | Project   |  |  Task     |  | Query     |  |  Link       | |
|  | Tools (4) |  | Tools (4) |  | Tools (1) |  |  Tools (1)  | |
|  +-----------+  +-----------+  +-----------+  +-------------+ |
|        |              |              |              |          |
|        v              v              v              v          |
|  +----------------------------------------------------------+ |
|  |                    TaskService                            | |
|  |  - createProject()    - createTask()   - updateTask()     | |
|  |  - moveTask()         - addDependency()                   | |
|  |  - getWorkspaceSummary()                                  | |
|  +----------------------------------------------------------+ |
|        |                                   |                   |
|        v                                   v                   |
|  +-------------------+         +---------------------+        |
|  |   DAGService      |         | ProjectRepository   |        |
|  | (pure computation)|         |  extends             |        |
|  | - validateNoCycle()|         |  BaseRepository      |        |
|  | - topologicalSort()|         +---------------------+        |
|  | - getNextActions() |                                        |
|  | - getBlockedTasks()|                                        |
|  | - getDependencyTree|         +---------------------+        |
|  +-------------------+         | TaskRepository      |        |
|                                |  extends             |        |
|                                |  BaseRepository      |        |
|                                +---------------------+        |
|                                     |            |             |
|                                  JSONL        SQLite           |
+---------------------------------------------------------------+

Integration Points:
  loadWorkspace -----> TaskService.getWorkspaceSummary()
  ServiceFactory ----> TaskManagerAgentFactory
  AgentRegistry ----> Phase 2 (alongside memoryManager)
```

---

## 3. Interface Contracts

### ITaskService (Business Logic Facade)

```typescript
interface ITaskService {
  // Projects
  createProject(workspaceId: string, data: CreateProjectData): Promise<string>;
  listProjects(workspaceId: string, options?: ListOptions): Promise<PaginatedResult<Project>>;
  updateProject(projectId: string, data: UpdateProjectData): Promise<void>;
  archiveProject(projectId: string): Promise<void>;

  // Tasks
  createTask(projectId: string, data: CreateTaskData): Promise<string>;
  listTasks(projectId: string, options?: TaskListOptions): Promise<PaginatedResult<Task>>;
  updateTask(taskId: string, data: UpdateTaskData): Promise<void>;
  moveTask(taskId: string, target: { projectId?: string; parentTaskId?: string | null }): Promise<void>;

  // Dependencies (DAG)
  addDependency(taskId: string, dependsOnTaskId: string): Promise<void>;
  removeDependency(taskId: string, dependsOnTaskId: string): Promise<void>;

  // Queries
  getNextActions(projectId: string): Promise<Task[]>;
  getBlockedTasks(projectId: string): Promise<TaskWithBlockers[]>;
  getDependencyTree(taskId: string): Promise<DependencyTree>;

  // Note Links
  linkNote(taskId: string, notePath: string, linkType: LinkType): Promise<void>;
  unlinkNote(taskId: string, notePath: string): Promise<void>;
  getTasksForNote(notePath: string): Promise<Task[]>;

  // Workspace Integration
  getWorkspaceSummary(workspaceId: string): Promise<WorkspaceTaskSummary>;
}
```

### IDAGService (Pure Computation)

All methods are pure functions — they take data in and return results. No storage access.

```typescript
interface IDAGService {
  validateNoCycle(taskId: string, dependsOnTaskId: string, allEdges: Edge[]): boolean;
  topologicalSort(tasks: TaskNode[], edges: Edge[]): TaskNode[];
  getNextActions(tasks: TaskNode[], edges: Edge[]): TaskNode[];
  getBlockedTasks(tasks: TaskNode[], edges: Edge[]): TaskNode[];
  getDependencyTree(rootTaskId: string, tasks: TaskNode[], edges: Edge[]): DependencyTree;
}
```

### IProjectRepository

```typescript
interface IProjectRepository extends IRepository<ProjectMetadata> {
  getByWorkspace(workspaceId: string, options?: QueryOptions): Promise<PaginatedResult<ProjectMetadata>>;
  getByName(workspaceId: string, name: string): Promise<ProjectMetadata | null>;
}
```

### ITaskRepository

```typescript
interface ITaskRepository extends IRepository<TaskMetadata> {
  getByProject(projectId: string, options?: QueryOptions): Promise<PaginatedResult<TaskMetadata>>;
  getByWorkspace(workspaceId: string, options?: QueryOptions): Promise<PaginatedResult<TaskMetadata>>;
  getByStatus(projectId: string, status: TaskStatus): Promise<TaskMetadata[]>;
  getDependencies(taskId: string): Promise<TaskMetadata[]>;    // tasks this depends ON
  getDependents(taskId: string): Promise<TaskMetadata[]>;      // tasks depending ON this
  getChildren(taskId: string): Promise<TaskMetadata[]>;        // subtasks
  getReadyTasks(projectId: string): Promise<TaskMetadata[]>;   // deps all complete
  addDependency(taskId: string, dependsOnTaskId: string): Promise<void>;
  removeDependency(taskId: string, dependsOnTaskId: string): Promise<void>;
  getNoteLinks(taskId: string): Promise<NoteLink[]>;
  getByLinkedNote(notePath: string): Promise<TaskMetadata[]>;
  addNoteLink(taskId: string, notePath: string, linkType: LinkType): Promise<void>;
  removeNoteLink(taskId: string, notePath: string): Promise<void>;
}
```

### WorkspaceTaskSummary (auto-load response)

```typescript
interface WorkspaceTaskSummary {
  projects: {
    total: number;
    active: number;
    items: ProjectSummary[];  // Active projects with task counts
  };
  tasks: {
    total: number;
    byStatus: Record<TaskStatus, number>;
    overdue: number;
    nextActions: Task[];       // Top 5 ready-to-work tasks
    recentlyCompleted: Task[]; // Last 5 completed
  };
}

interface ProjectSummary {
  id: string;
  name: string;
  taskCount: number;
  status: ProjectStatus;
}
```

---

## 4. Data Model

### Type Definitions

```typescript
// Status & Priority enums
type ProjectStatus = 'active' | 'completed' | 'archived';
type TaskStatus = 'todo' | 'in_progress' | 'done' | 'cancelled';  // 'blocked' is DERIVED, not stored
type TaskPriority = 'critical' | 'high' | 'medium' | 'low';
type LinkType = 'reference' | 'output' | 'input';

// Entities
interface ProjectMetadata {
  id: string;
  workspaceId: string;
  name: string;
  description?: string;
  status: ProjectStatus;
  created: number;
  updated: number;
  metadata?: Record<string, unknown>;
}

interface TaskMetadata {
  id: string;
  projectId: string;
  workspaceId: string;         // denormalized for fast workspace queries
  parentTaskId?: string;       // subtask hierarchy (null = top-level)
  title: string;
  description?: string;
  status: TaskStatus;
  priority: TaskPriority;
  created: number;
  updated: number;
  completedAt?: number;
  dueDate?: number;
  assignee?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

// DAG types
interface Edge {
  taskId: string;
  dependsOnTaskId: string;
}

interface TaskNode {
  id: string;
  status: TaskStatus;
}

interface DependencyTree {
  task: TaskMetadata;
  dependencies: DependencyTree[];
  dependents: DependencyTree[];
}

interface TaskWithBlockers {
  task: TaskMetadata;
  blockedBy: TaskMetadata[];
}

// Note links
interface NoteLink {
  taskId: string;
  notePath: string;
  linkType: LinkType;
  created: number;
}

// CRUD DTOs
interface CreateProjectData {
  name: string;
  description?: string;
  metadata?: Record<string, unknown>;
}

interface UpdateProjectData {
  name?: string;
  description?: string;
  status?: ProjectStatus;
  metadata?: Record<string, unknown>;
}

interface CreateTaskData {
  title: string;
  description?: string;
  parentTaskId?: string;
  priority?: TaskPriority;
  dueDate?: number;
  assignee?: string;
  tags?: string[];
  dependsOn?: string[];        // Task IDs to create initial edges
  linkedNotes?: string[];      // Note paths to auto-link
  metadata?: Record<string, unknown>;
}

interface UpdateTaskData {
  title?: string;
  description?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  dueDate?: number;
  assignee?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

// Query options
interface TaskListOptions extends PaginationParams {
  status?: TaskStatus;
  priority?: TaskPriority;
  assignee?: string;
  parentTaskId?: string;
  includeSubtasks?: boolean;
}

interface ListOptions extends PaginationParams {
  status?: ProjectStatus;
}
```

---

## 5. SQLite Schema (Migration v8 -> v9)

### DDL (add to `schema.ts`)

```sql
-- PROJECTS
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  workspaceId TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL,
  metadataJson TEXT,
  FOREIGN KEY(workspaceId) REFERENCES workspaces(id) ON DELETE CASCADE,
  UNIQUE(workspaceId, name)
);

-- TASKS
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  projectId TEXT NOT NULL,
  workspaceId TEXT NOT NULL,
  parentTaskId TEXT,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'todo',
  priority TEXT DEFAULT 'medium',
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL,
  completedAt INTEGER,
  dueDate INTEGER,
  assignee TEXT,
  tagsJson TEXT,
  metadataJson TEXT,
  FOREIGN KEY(projectId) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY(workspaceId) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY(parentTaskId) REFERENCES tasks(id) ON DELETE SET NULL
);

-- TASK DEPENDENCIES (DAG edges)
CREATE TABLE IF NOT EXISTS task_dependencies (
  taskId TEXT NOT NULL,
  dependsOnTaskId TEXT NOT NULL,
  created INTEGER NOT NULL,
  PRIMARY KEY(taskId, dependsOnTaskId),
  FOREIGN KEY(taskId) REFERENCES tasks(id) ON DELETE CASCADE,
  FOREIGN KEY(dependsOnTaskId) REFERENCES tasks(id) ON DELETE CASCADE
);

-- TASK-NOTE LINKS (bidirectional)
CREATE TABLE IF NOT EXISTS task_note_links (
  taskId TEXT NOT NULL,
  notePath TEXT NOT NULL,
  linkType TEXT NOT NULL DEFAULT 'reference',
  created INTEGER NOT NULL,
  PRIMARY KEY(taskId, notePath),
  FOREIGN KEY(taskId) REFERENCES tasks(id) ON DELETE CASCADE
);
```

### Indexes (13)

```sql
CREATE INDEX IF NOT EXISTS idx_projects_workspace ON projects(workspaceId);
CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);
CREATE INDEX IF NOT EXISTS idx_projects_updated ON projects(updated);

CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(projectId);
CREATE INDEX IF NOT EXISTS idx_tasks_workspace ON tasks(workspaceId);
CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parentTaskId);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_priority ON tasks(priority);
CREATE INDEX IF NOT EXISTS idx_tasks_updated ON tasks(updated);
CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(dueDate);

CREATE INDEX IF NOT EXISTS idx_task_deps_task ON task_dependencies(taskId);
CREATE INDEX IF NOT EXISTS idx_task_deps_depends ON task_dependencies(dependsOnTaskId);

CREATE INDEX IF NOT EXISTS idx_task_links_note ON task_note_links(notePath);
```

### Migration (SchemaMigrator.ts)

```typescript
{
  version: 9,
  description: 'Add task management tables (projects, tasks, task_dependencies, task_note_links)',
  sql: [
    // Projects table
    `CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      workspaceId TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      created INTEGER NOT NULL,
      updated INTEGER NOT NULL,
      metadataJson TEXT,
      FOREIGN KEY(workspaceId) REFERENCES workspaces(id) ON DELETE CASCADE,
      UNIQUE(workspaceId, name)
    )`,
    // Tasks table
    `CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      projectId TEXT NOT NULL,
      workspaceId TEXT NOT NULL,
      parentTaskId TEXT,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'todo',
      priority TEXT DEFAULT 'medium',
      created INTEGER NOT NULL,
      updated INTEGER NOT NULL,
      completedAt INTEGER,
      dueDate INTEGER,
      assignee TEXT,
      tagsJson TEXT,
      metadataJson TEXT,
      FOREIGN KEY(projectId) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY(workspaceId) REFERENCES workspaces(id) ON DELETE CASCADE,
      FOREIGN KEY(parentTaskId) REFERENCES tasks(id) ON DELETE SET NULL
    )`,
    // Task dependencies
    `CREATE TABLE IF NOT EXISTS task_dependencies (
      taskId TEXT NOT NULL,
      dependsOnTaskId TEXT NOT NULL,
      created INTEGER NOT NULL,
      PRIMARY KEY(taskId, dependsOnTaskId),
      FOREIGN KEY(taskId) REFERENCES tasks(id) ON DELETE CASCADE,
      FOREIGN KEY(dependsOnTaskId) REFERENCES tasks(id) ON DELETE CASCADE
    )`,
    // Task-note links
    `CREATE TABLE IF NOT EXISTS task_note_links (
      taskId TEXT NOT NULL,
      notePath TEXT NOT NULL,
      linkType TEXT NOT NULL DEFAULT 'reference',
      created INTEGER NOT NULL,
      PRIMARY KEY(taskId, notePath),
      FOREIGN KEY(taskId) REFERENCES tasks(id) ON DELETE CASCADE
    )`,
    // Indexes
    'CREATE INDEX IF NOT EXISTS idx_projects_workspace ON projects(workspaceId)',
    'CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status)',
    'CREATE INDEX IF NOT EXISTS idx_projects_updated ON projects(updated)',
    'CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(projectId)',
    'CREATE INDEX IF NOT EXISTS idx_tasks_workspace ON tasks(workspaceId)',
    'CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parentTaskId)',
    'CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)',
    'CREATE INDEX IF NOT EXISTS idx_tasks_priority ON tasks(priority)',
    'CREATE INDEX IF NOT EXISTS idx_tasks_updated ON tasks(updated)',
    'CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(dueDate)',
    'CREATE INDEX IF NOT EXISTS idx_task_deps_task ON task_dependencies(taskId)',
    'CREATE INDEX IF NOT EXISTS idx_task_deps_depends ON task_dependencies(dependsOnTaskId)',
    'CREATE INDEX IF NOT EXISTS idx_task_links_note ON task_note_links(notePath)',
  ]
}
```

---

## 6. JSONL Event Sourcing

### Storage Path

`tasks/tasks_[workspaceId].jsonl` — per-workspace, matching existing `workspaces/ws_[id].jsonl` pattern.

### Event Catalog

| Event Type | Fields | Description |
|------------|--------|-------------|
| `project_created` | id, workspaceId, name, description, status, created, updated | New project |
| `project_updated` | id, [changed fields], updated | Project metadata/status change |
| `project_deleted` | id | Project removal (CASCADE deletes tasks) |
| `task_created` | id, projectId, workspaceId, title, status, priority, ... | New task |
| `task_updated` | id, [changed fields], updated | Task field/status change |
| `task_deleted` | id | Task removal (CASCADE removes edges) |
| `task_dependency_added` | taskId, dependsOnTaskId | DAG edge created |
| `task_dependency_removed` | taskId, dependsOnTaskId | DAG edge removed |
| `task_note_linked` | taskId, notePath, linkType | Note linked to task |
| `task_note_unlinked` | taskId, notePath | Note unlinked from task |

### Repository JSONL Path Configuration

```typescript
// ProjectRepository
protected readonly jsonlPath = (workspaceId: string) => `tasks/tasks_${workspaceId}.jsonl`;

// TaskRepository — shares the same JSONL file as projects (per-workspace)
protected readonly jsonlPath = (workspaceId: string) => `tasks/tasks_${workspaceId}.jsonl`;
```

**Note**: Both ProjectRepository and TaskRepository write to the same per-workspace JSONL file. This is a departure from the 1-file-per-entity pattern used by WorkspaceRepository. The rationale is that tasks and projects within a workspace form a cohesive unit and per-project files would fragment too much. The repositories differentiate by event type prefix (`project_*` vs `task_*`).

---

## 7. Integration Point Specifications

### 7.1 loadWorkspace Integration

**File**: `src/agents/memoryManager/tools/workspaces/loadWorkspace.ts`

**Step 1**: Fetch task summary (around lines 118-155, alongside other data fetching):

```typescript
let taskSummary = null;
try {
  const taskService = this.agent.getTaskService?.();
  if (taskService) {
    taskSummary = await taskService.getWorkspaceSummary(workspace.id);
  }
} catch { /* TaskManager not initialized — skip */ }
```

**Step 2**: Inject into response (line 182, after prompt spread):

```typescript
...(workspacePrompt && { prompt: workspacePrompt }),
...(taskSummary && { taskSummary })
```

**Step 3**: Add `getTaskService()` accessor to MemoryManagerAgent (or use plugin service registry). This method does not exist yet. Implementation options:
- **Option A** (recommended): Add `getTaskService(): TaskService | null` to `MemoryManagerAgent` class, populated during plugin init via a setter or constructor parameter
- **Option B**: Access via `ServiceManager.resolve('taskService')` if ServiceManager is available in the tool context

**Step 4**: Update `LoadWorkspaceResult` type in `src/database/types/workspace/ParameterTypes.ts` (around line 117):

```typescript
taskSummary?: WorkspaceTaskSummary;
```

**Step 5**: Update `getResultSchema()` in loadWorkspace.ts (around line 427) to include `taskSummary` in the JSON Schema.

### 7.2 CacheableEntityType Extension

**3 synchronized update points:**

1. **`BaseRepository.ts` line 36** — Union type:
   ```typescript
   export type CacheableEntityType = 'workspace' | 'session' | 'state' | 'conversation' | 'message' | 'project' | 'task';
   ```

2. **`BaseRepository.ts` line 219** — Guard function:
   ```typescript
   return ['workspace', 'session', 'state', 'conversation', 'message', 'project', 'task'].includes(type);
   ```

3. **`QueryCache.ts` lines 246, 263-264** — Method signatures:
   ```typescript
   invalidateByType(type: 'workspace' | 'session' | 'state' | 'conversation' | 'message' | 'project' | 'task'): number {
   // ...
   invalidateById(
     type: 'workspace' | 'session' | 'state' | 'conversation' | 'message' | 'project' | 'task',
     id: string
   ): number {
   ```

**New static methods on QueryCache** (following existing pattern):

```typescript
static projectKey(workspaceId: string, projectId?: string, queryType: string = 'get'): string {
  return projectId
    ? `project:${queryType}:${workspaceId}:${projectId}`
    : `project:${queryType}:${workspaceId}:all`;
}

static taskKey(projectId: string, taskId?: string, queryType: string = 'get'): string {
  return taskId
    ? `task:${queryType}:${projectId}:${taskId}`
    : `task:${queryType}:${projectId}:all`;
}
```

**Safety**: Extending the union is backward-compatible. `TraceRepository` already uses the pattern-based fallback for non-cacheable types, confirming no breakage risk.

### 7.3 Agent Registration

**4 registration points:**

1. **`src/agents/index.ts`** — Add export:
   ```typescript
   export * from './taskManager/taskManager';
   ```

2. **`src/agents/baseAgent.ts` line 181** — Add to cross-agent lookup array:
   ```typescript
   const agentNames = ['storageManager', 'contentManager', 'searchManager', 'memoryManager', 'promptManager', 'canvasManager', 'taskManager'];
   ```

3. **`src/services/agent/AgentRegistrationService.ts` line 128** — Add to init array:
   ```typescript
   const agentNames = ['contentManager', 'storageManager', 'searchManager', 'memoryManager', 'promptManager', 'canvasManager', 'taskManager'];
   ```

4. **`src/core/ServiceFactory.ts`** — New factory + registration:
   ```typescript
   export class TaskManagerAgentFactory extends BaseAgentFactory<TaskManagerAgent> {
     constructor() {
       super('taskManager', ['taskService', 'workspaceService']);
     }

     async create(dependencies: Map<string, any>, app: App, plugin: Plugin): Promise<TaskManagerAgent> {
       const taskService = this.getDependency<TaskService>(dependencies, 'taskService');
       const workspaceService = this.getDependency<any>(dependencies, 'workspaceService');
       return new TaskManagerAgent(app, plugin, taskService, workspaceService);
     }
   }
   ```

   In `AgentFactoryRegistry` constructor:
   ```typescript
   this.registerFactory(new TaskManagerAgentFactory());
   ```

**Registration phase**: Phase 2 (alongside memoryManager) because TaskManager needs `RepositoryDependencies` (SQLite + JSONL).

### 7.4 TaskService Registration with ServiceManager

TaskService must be registered with the ServiceManager so it can be resolved as a dependency:

```typescript
// In ServiceDefinitions.ts or ServiceRegistrar.ts
serviceManager.registerFactory('taskService', (container) => {
  const sqliteCache = container.resolve('sqliteCacheManager');
  const jsonlWriter = container.resolve('jsonlWriter');
  const queryCache = container.resolve('queryCache');
  const repoDeps = { sqliteCache, jsonlWriter, queryCache };
  const projectRepo = new ProjectRepository(repoDeps);
  const taskRepo = new TaskRepository(repoDeps);
  const dagService = new DAGService();
  return new TaskService(projectRepo, taskRepo, dagService);
});
```

---

## 8. Key DAG Queries (SQL)

### Cycle Detection (before inserting edge)

```sql
WITH RECURSIVE ancestors(id) AS (
  SELECT dependsOnTaskId FROM task_dependencies WHERE taskId = :newDependsOnTaskId
  UNION ALL
  SELECT td.dependsOnTaskId FROM task_dependencies td
  JOIN ancestors a ON a.id = td.taskId
)
SELECT EXISTS(SELECT 1 FROM ancestors WHERE id = :newTaskId) AS hasCycle;
```

**Note**: Cycle detection runs in DAGService as pure TypeScript (not SQL). The service loads all edges for the project, then runs DFS or Kahn's. SQL is available as fallback but pure TS is preferred for testability.

### Next Actionable Tasks

```sql
SELECT t.* FROM tasks t
WHERE t.projectId = ? AND t.status = 'todo'
  AND NOT EXISTS (
    SELECT 1 FROM task_dependencies td
    JOIN tasks dep ON dep.id = td.dependsOnTaskId
    WHERE td.taskId = t.id AND dep.status NOT IN ('done', 'cancelled')
  )
ORDER BY
  CASE t.priority
    WHEN 'critical' THEN 1
    WHEN 'high' THEN 2
    WHEN 'medium' THEN 3
    WHEN 'low' THEN 4
  END,
  t.created ASC;
```

### Blocked Tasks (with blocker details)

```sql
SELECT t.*, GROUP_CONCAT(td.dependsOnTaskId) as blockedByIds
FROM tasks t
JOIN task_dependencies td ON td.taskId = t.id
JOIN tasks dep ON dep.id = td.dependsOnTaskId
WHERE t.projectId = ? AND t.status IN ('todo', 'in_progress')
  AND dep.status NOT IN ('done', 'cancelled')
GROUP BY t.id;
```

---

## 9. Implementation Roadmap

### Commit Sequence

| # | Scope | Description | Dependencies |
|---|-------|-------------|--------------|
| 1 | Database | Schema v9: 4 tables, 13 indexes, migration in SchemaMigrator.ts | None |
| 2 | Database | ProjectRepository + TaskRepository (extends BaseRepository) | Commit 1 |
| 3 | Database | CacheableEntityType extension (BaseRepository + QueryCache) | Commit 1 |
| 4 | Service | DAGService (pure computation, no storage) | None |
| 5 | Service | TaskService facade (orchestrates repos + DAGService) | Commits 2, 4 |
| 6 | Agent | TaskManagerAgent + project tools (4 tools) | Commit 5 |
| 7 | Agent | Task CRUD tools (4 tools) | Commit 5 |
| 8 | Agent | queryTasks + linkNote tools (2 tools) | Commit 5 |
| 9 | Integration | Agent registration (index, baseAgent, ServiceFactory, AgentRegistrationService) | Commit 6 |
| 10 | Integration | loadWorkspace extension (task summary injection) | Commit 5 |

**Parallelism opportunities**:
- Commits 1-3 (database layer) can run in parallel with Commit 4 (DAGService — no deps)
- Commits 6-8 (tools) can run in parallel once Commit 5 is done

---

## 10. Adjustments from PREPARE Findings

### Adjustment 1: `getTaskService()` Accessor (NEW requirement)

The approved plan mentioned modifying `loadWorkspace.ts` but did not specify how the tool obtains a TaskService reference. PREPARE found that no `getTaskService()` method exists on any agent or service registry.

**Resolution**: TaskManagerAgent factory registers `taskService` with ServiceManager. MemoryManagerAgent gets a `setTaskService(ts: TaskService)` method called during plugin init, or resolves via ServiceManager. The loadWorkspace tool then calls `this.agent.getTaskService()`.

### Adjustment 2: `LoadWorkspaceResult` Type Gap

PREPARE found that the `prompt` field is already conditionally added at runtime but missing from the `LoadWorkspaceResult` type definition. The `taskSummary` field will have the same pattern.

**Resolution**: When adding `taskSummary?` to the type, also add `prompt?` to fix the existing gap. This is an additive, non-breaking change. Both fields are optional.

### Adjustment 3: Column Naming Standardization

The plan uses `dependsOnTaskId` in the schema and interfaces. The architect consultation used `dependsOnId`. These must be consistent.

**Resolution**: Use `dependsOnTaskId` everywhere (matches the approved plan, is more descriptive, follows the `parentTaskId` naming convention in the same table).

---

## 11. Decisions Confirmed from Plan

| Decision | Status | Notes |
|----------|--------|-------|
| DAG storage: adjacency list | Confirmed | Recursive CTEs handle transitive queries |
| Cycle detection: DAGService (pure TS) | Confirmed | Maximally testable without mocks |
| Project: first-class entity | Confirmed | Own table, lifecycle, FK to workspace |
| Separate Project + Task repos | Confirmed | Different query patterns, SRP |
| JSONL: per-workspace | Confirmed | `tasks/tasks_[workspaceId].jsonl` |
| Note links: junction table | Confirmed | Enables bidirectional queries |
| `blocked` status: derived, not stored | Confirmed | Avoids state sync issues |
| Parent auto-complete: independent | Confirmed | No unexpected behavior |
| Delete project: CASCADE | Confirmed | FK handles it; JSONL preserves history |
| Delete task with dependents: CASCADE | Confirmed | FK removes edges automatically |
| Cross-workspace references: prohibited | Confirmed | Workspace isolation preserved |
| FTS5 tables: deferred | Confirmed | Task fields are short; LIKE suffices for v1 |
| Tool count: 10 | Confirmed | Token-efficient for Two-Tool Architecture |

---

## 12. Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| DAG cycle detection incorrect | Low | High | Pure functions in DAGService; exhaustive unit tests |
| Schema migration breaks existing data | Low | High | CREATE TABLE IF NOT EXISTS only; no ALTER TABLE |
| JSONL replay creates cycles | Medium | Medium | Re-run cycle detection during replay; skip conflicting edges |
| loadWorkspace response bloat | Low | Medium | Limit to top 5 next actions + counts |
| Shared JSONL file between repos | Low | Medium | Event type prefix distinguishes; replay differentiates by prefix |
| `getTaskService()` wiring fails at runtime | Low | Medium | Try-catch guard in loadWorkspace; taskSummary is optional |
