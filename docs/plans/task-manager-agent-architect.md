# TaskManager Agent - Architect Planning Consultation

**Specialist**: Architect
**Date**: 2026-03-08
**Status**: Planning consultation only (no implementation)

---

## 1. SCOPE IN MY DOMAIN

### Components/Modules Needed

**Agent Layer** (following existing agent pattern):

```
src/agents/taskManager/
  taskManager.ts              # TaskManagerAgent extends BaseAgent
  types.ts                    # TaskManager-specific types
  tools/
    projects/
      createProject.ts        # Create a project in a workspace
      listProjects.ts         # List projects (filtered by workspace, status)
      getProject.ts           # Get project details with task summary
      updateProject.ts        # Update project metadata
      archiveProject.ts       # Soft-delete project
    tasks/
      createTask.ts           # Create task with optional deps/parent
      listTasks.ts            # List tasks (filtered by project, status, assignee)
      getTask.ts              # Get task details with dependency graph
      updateTask.ts           # Update task fields (including status transitions)
      deleteTask.ts           # Soft-delete task
      addDependency.ts        # Add DAG edge (with cycle detection)
      removeDependency.ts     # Remove DAG edge
    queries/
      getTaskGraph.ts         # Get full DAG for a project (topological view)
      getReadyTasks.ts        # Get tasks whose dependencies are all complete
      getCriticalPath.ts      # Compute critical path through DAG
  services/
    TaskService.ts            # Business logic: status propagation, DAG validation
    DAGService.ts             # Cycle detection, topological sort, critical path
```

**Repository Layer** (following existing BaseRepository pattern):

```
src/database/repositories/
  ProjectRepository.ts        # Extends BaseRepository<ProjectMetadata>
  TaskRepository.ts           # Extends BaseRepository<TaskMetadata>
  interfaces/
    IProjectRepository.ts     # Project-specific query interface
    ITaskRepository.ts        # Task-specific query interface (DAG queries)
```

**Type Definitions**:

```
src/types/storage/TaskTypes.ts   # ProjectMetadata, TaskMetadata, TaskStatus, etc.
```

**Events** (additions to StorageEvents.ts):
- ProjectCreatedEvent
- ProjectUpdatedEvent
- ProjectDeletedEvent
- TaskCreatedEvent
- TaskUpdatedEvent
- TaskDeletedEvent
- DependencyAddedEvent
- DependencyRemovedEvent

### Design Patterns Applied

1. **Repository Pattern** -- Consistent with WorkspaceRepository, SessionRepository
2. **Service Layer** -- TaskService for business logic, DAGService for graph algorithms (keeps repos thin)
3. **Event Sourcing** -- JSONL events for all mutations (following existing pattern)
4. **Lazy Tool Registration** -- `registerLazyTool()` for all tools (following MemoryManagerAgent)
5. **Dependency Injection** -- TaskService + DAGService injected into agent constructor
6. **Template Method** -- BaseRepository's abstract methods (rowToEntity, jsonlPath, etc.)

### Estimated Effort

- **Types + Events**: Small (1 file + additions to StorageEvents.ts)
- **Repositories (2)**: Medium (following WorkspaceRepository template closely)
- **Services (2)**: Medium-Large (DAGService is the novel piece)
- **Agent + Tools (15 tools)**: Medium (repetitive pattern, well-templated)
- **Schema migration**: Small (3 new tables, indexes, FTS)
- **Total**: ~20-25 files, roughly a medium-complexity feature

---

## 2. DEPENDENCIES AND INTERFACES

### Integration with Existing Agents

**MemoryManager (workspace loading)**:
- `loadWorkspace` should include a `taskSummary` field in its response:
  ```typescript
  taskSummary?: {
    activeProjects: number;
    openTasks: number;
    readyTasks: number;  // tasks with all deps satisfied
    blockedTasks: number;
  }
  ```
- Implementation: LoadWorkspaceTool calls `TaskService.getWorkspaceSummary(workspaceId)`
- This is a lightweight JOIN query, not a full DAG traversal

**SearchManager**:
- Add FTS5 virtual tables for `projects` and `tasks` (name, description columns)
- searchContent tool could be extended to search tasks, or a dedicated `searchTasks` tool added to TaskManager

**ToolManager**:
- TaskManager registers with ToolManager like all other agents -- no special integration needed
- Agent name added to `agentNames` array in `baseAgent.ts:182` and `AgentRegistrationService.ts:128`

### Interface Contracts

**IProjectRepository**:

```typescript
interface IProjectRepository extends IRepository<ProjectMetadata> {
  getByWorkspace(workspaceId: string, options?: QueryOptions): Promise<PaginatedResult<ProjectMetadata>>;
  getByName(workspaceId: string, name: string): Promise<ProjectMetadata | null>;
  search(query: string, workspaceId?: string): Promise<ProjectMetadata[]>;
}
```

**ITaskRepository**:

```typescript
interface ITaskRepository extends IRepository<TaskMetadata> {
  getByProject(projectId: string, options?: QueryOptions): Promise<PaginatedResult<TaskMetadata>>;
  getByStatus(projectId: string, status: TaskStatus): Promise<TaskMetadata[]>;
  getDependencies(taskId: string): Promise<TaskMetadata[]>;    // tasks this depends ON
  getDependents(taskId: string): Promise<TaskMetadata[]>;      // tasks depending ON this
  getChildren(taskId: string): Promise<TaskMetadata[]>;        // subtasks
  getReadyTasks(projectId: string): Promise<TaskMetadata[]>;   // deps all complete
  addDependency(taskId: string, dependsOnId: string): Promise<void>;
  removeDependency(taskId: string, dependsOnId: string): Promise<void>;
  getByLinkedNote(notePath: string): Promise<TaskMetadata[]>;
}
```

**TaskService** (business logic):

```typescript
interface ITaskService {
  createTask(data: CreateTaskData): Promise<string>;
  updateTaskStatus(taskId: string, status: TaskStatus): Promise<void>;
  getWorkspaceSummary(workspaceId: string): Promise<TaskSummary>;
  validateDependency(taskId: string, dependsOnId: string): Promise<{ valid: boolean; error?: string }>;
}
```

**DAGService** (graph algorithms):

```typescript
interface IDAGService {
  detectCycle(taskId: string, dependsOnId: string, existingEdges: DependencyEdge[]): boolean;
  topologicalSort(projectId: string): Promise<TaskMetadata[]>;
  getCriticalPath(projectId: string): Promise<TaskMetadata[]>;
  getAncestors(taskId: string): Promise<Set<string>>;
  getDescendants(taskId: string): Promise<Set<string>>;
}
```

### Project-Workspace Relationship

Project belongs to a Workspace (foreign key). A workspace can have 0..N projects. This mirrors the Session-Workspace pattern already in the codebase.

### loadWorkspace Extension

The LoadWorkspaceTool would add an optional `includeTaskSummary` flag (default true). When true, it calls `TaskService.getWorkspaceSummary(workspaceId)` and includes the summary in the response. This is a small additive change -- no breaking changes to existing loadWorkspace callers.

---

## 3. KEY DECISIONS AND TRADE-OFFS

### Cycle Detection: Service Layer (RECOMMENDED)

**Decision**: Cycle detection belongs in `DAGService`, called by `TaskService.validateDependency()`.

**Rationale**:
- Repository should be a dumb data access layer (consistent with existing repos)
- Cycle detection requires reading the full dependency graph -- that is business logic
- `addDependency` tool calls `TaskService.validateDependency()` before `TaskRepository.addDependency()`
- If validation passes, repo writes the JSONL event + SQLite row
- Kahn's algorithm or DFS-based detection -- both O(V+E), Kahn's preferred because it also gives topological order

### Project: First-Class Entity (RECOMMENDED)

**Decision**: Project as a first-class entity with its own table, repository, and JSONL files.

**Rationale**:
- Tags are too loose for scoping DAG boundaries -- a DAG needs a clear container
- Projects provide natural scope for topological sort, critical path, "ready tasks" queries
- Projects have their own metadata (name, description, status, dates) that does not fit tag semantics
- Aligns with Workspace-to-Session pattern (Workspace-to-Project is the analog)
- Cross-project dependencies are explicitly prohibited to keep DAGs manageable

### Repository Design: Separate Repositories (RECOMMENDED)

**Decision**: Separate `ProjectRepository` and `TaskRepository`.

**Rationale**:
- Single Responsibility -- projects and tasks have different query patterns
- Tasks need graph queries (dependencies, dependents, topological sort) that projects do not
- Consistent with existing codebase (WorkspaceRepository, SessionRepository, StateRepository are all separate)
- Shared BaseRepository handles common JSONL/SQLite mechanics

### JSONL File Strategy: Per-Project (RECOMMENDED)

**Decision**: One JSONL file per project at `.nexus/projects/proj_[id].jsonl`.

**Rationale**:
- **Per-task**: Too many files. A project with 50 tasks = 50 JSONL files. File proliferation is a real concern with Obsidian Sync.
- **Per-workspace**: Too coarse. Multiple projects in one file makes replaying events harder and creates contention.
- **Per-project**: Right granularity. A project and all its tasks, dependencies, and status changes are a cohesive unit. One file per project. File count grows linearly with projects, not tasks.
- All task events (created, updated, dependency_added, etc.) go into the parent project's JSONL file.
- Project lifecycle events (created, updated, archived) also go in the same file.

### Status Propagation: Explicit, Not Automatic (RECOMMENDED)

**Decision**: No automatic parent completion. Provide a query ("are all children done?") instead.

**Rationale**:
- Automatic propagation is surprising behavior -- what if the user wants to add more subtasks later?
- The `getReadyTasks` query already tells the user which tasks are unblocked
- A `getProject` response can include `{ totalTasks, completedTasks, progress% }` for visibility
- If users want auto-complete, it can be added later as an opt-in project setting
- Fewer side effects = fewer bugs, more predictable system

---

## 4. RISKS AND CONCERNS

### DAG Traversal Performance at Scale

**Risk**: A project with 500+ tasks could make topological sort or cycle detection slow.

**Mitigation**:
- Load the full adjacency list from `task_dependencies` table (simple JOIN, indexed) into memory
- Run Kahn's algorithm in-memory -- O(V+E) is fast even for 1000 tasks
- Cache topological order in QueryCache with invalidation on dependency mutations
- For `getReadyTasks`, a single SQL query with NOT EXISTS suffices -- no full traversal needed:

```sql
SELECT t.* FROM tasks t
WHERE t.projectId = ? AND t.status = 'open'
AND NOT EXISTS (
  SELECT 1 FROM task_dependencies td
  JOIN tasks dep ON dep.id = td.dependsOnId
  WHERE td.taskId = t.id AND dep.status != 'completed'
)
```

### JSONL File Size

**Risk**: Long-running projects accumulate many events per file.

**Mitigation**:
- Task status updates are small events (~200 bytes each)
- A project with 100 tasks and 500 status changes is approximately 100KB -- well within acceptable range
- JSONL rebuild from file is fast (sequential read)
- If needed later, compaction can be added (replay events then write single snapshot)

### Cross-Workspace Task References

**Decision**: Prohibit. Tasks reference tasks within the same project only.

**Rationale**:
- Cross-workspace references break workspace isolation (existing design principle)
- Would complicate workspace deletion cascading
- Would require cross-file JSONL lookups during validation
- If cross-project (within same workspace) references are needed, it can be scoped as a later enhancement

### Workspace Deletion Cascading

**Decision**: Cascade delete projects and tasks when a workspace is deleted.

**Implementation**:
- SQLite `ON DELETE CASCADE` foreign key (consistent with sessions, states, traces)
- JSONL files for projects under that workspace can be cleaned up asynchronously
- No orphan tasks possible by design

### Bidirectional Note Linking

**Risk**: Note paths change (rename/move) and break links.

**Mitigation**:
- Store `linkedNotes: string[]` as paths in task metadata
- On note rename, search `tasks` table for old path and update (can hook into Obsidian's `vault.on('rename')`)
- This is the same challenge the rest of the plugin faces -- not unique to TaskManager
- Initial implementation: store paths, no auto-update. Add rename hook in a follow-up if needed.

---

## 5. RECOMMENDED APPROACH

### Data Model (SQLite Schema Addition -- Migration v9)

```sql
-- ==================== PROJECTS ====================

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  workspaceId TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'active',  -- active, completed, archived
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL,
  metadataJson TEXT,
  FOREIGN KEY(workspaceId) REFERENCES workspaces(id) ON DELETE CASCADE,
  UNIQUE(workspaceId, name)
);

CREATE INDEX IF NOT EXISTS idx_projects_workspace ON projects(workspaceId);
CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);
CREATE INDEX IF NOT EXISTS idx_projects_updated ON projects(updated);

-- ==================== TASKS ====================

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  projectId TEXT NOT NULL,
  workspaceId TEXT NOT NULL,  -- denormalized for faster queries
  parentTaskId TEXT,          -- subtask hierarchy (nullable = root task)
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'open',  -- open, in_progress, completed, blocked, cancelled
  priority TEXT DEFAULT 'medium',       -- low, medium, high, critical
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL,
  dueDate INTEGER,
  assignee TEXT,              -- free-form text (user/agent name)
  linkedNotesJson TEXT,       -- JSON array of vault note paths
  tagsJson TEXT,              -- JSON array of string tags
  metadataJson TEXT,          -- extensible JSON metadata
  FOREIGN KEY(projectId) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY(workspaceId) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY(parentTaskId) REFERENCES tasks(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(projectId);
CREATE INDEX IF NOT EXISTS idx_tasks_workspace ON tasks(workspaceId);
CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parentTaskId);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_priority ON tasks(priority);
CREATE INDEX IF NOT EXISTS idx_tasks_updated ON tasks(updated);
CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(dueDate);

-- ==================== TASK DEPENDENCIES (DAG edges) ====================

CREATE TABLE IF NOT EXISTS task_dependencies (
  taskId TEXT NOT NULL,
  dependsOnId TEXT NOT NULL,
  created INTEGER NOT NULL,
  PRIMARY KEY(taskId, dependsOnId),
  FOREIGN KEY(taskId) REFERENCES tasks(id) ON DELETE CASCADE,
  FOREIGN KEY(dependsOnId) REFERENCES tasks(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_task_deps_task ON task_dependencies(taskId);
CREATE INDEX IF NOT EXISTS idx_task_deps_depends ON task_dependencies(dependsOnId);

-- ==================== FTS for search ====================

CREATE VIRTUAL TABLE IF NOT EXISTS project_fts USING fts5(
  id, name, description,
  content='projects', content_rowid='rowid'
);

-- FTS triggers for projects (following workspace_fts pattern)
CREATE TRIGGER IF NOT EXISTS project_fts_insert AFTER INSERT ON projects BEGIN
  INSERT INTO project_fts(rowid, id, name, description)
  VALUES (new.rowid, new.id, new.name, new.description);
END;

CREATE TRIGGER IF NOT EXISTS project_fts_delete AFTER DELETE ON projects BEGIN
  INSERT INTO project_fts(project_fts, rowid, id, name, description)
  VALUES ('delete', old.rowid, old.id, old.name, old.description);
END;

CREATE TRIGGER IF NOT EXISTS project_fts_update AFTER UPDATE ON projects BEGIN
  INSERT INTO project_fts(project_fts, rowid, id, name, description)
  VALUES ('delete', old.rowid, old.id, old.name, old.description);
  INSERT INTO project_fts(rowid, id, name, description)
  VALUES (new.rowid, new.id, new.name, new.description);
END;

CREATE VIRTUAL TABLE IF NOT EXISTS task_fts USING fts5(
  id, title, description,
  content='tasks', content_rowid='rowid'
);

-- FTS triggers for tasks
CREATE TRIGGER IF NOT EXISTS task_fts_insert AFTER INSERT ON tasks BEGIN
  INSERT INTO task_fts(rowid, id, title, description)
  VALUES (new.rowid, new.id, new.title, new.description);
END;

CREATE TRIGGER IF NOT EXISTS task_fts_delete AFTER DELETE ON tasks BEGIN
  INSERT INTO task_fts(task_fts, rowid, id, title, description)
  VALUES ('delete', old.rowid, old.id, old.title, old.description);
END;

CREATE TRIGGER IF NOT EXISTS task_fts_update AFTER UPDATE ON tasks BEGIN
  INSERT INTO task_fts(task_fts, rowid, id, title, description)
  VALUES ('delete', old.rowid, old.id, old.title, old.description);
  INSERT INTO task_fts(rowid, id, title, description)
  VALUES (new.rowid, new.id, new.title, new.description);
END;
```

### Type Definitions

```typescript
// src/types/storage/TaskTypes.ts

export type ProjectStatus = 'active' | 'completed' | 'archived';
export type TaskStatus = 'open' | 'in_progress' | 'completed' | 'blocked' | 'cancelled';
export type TaskPriority = 'low' | 'medium' | 'high' | 'critical';

export interface ProjectMetadata {
  id: string;
  workspaceId: string;
  name: string;
  description?: string;
  status: ProjectStatus;
  created: number;
  updated: number;
  metadata?: Record<string, unknown>;
}

export interface TaskMetadata {
  id: string;
  projectId: string;
  workspaceId: string;
  parentTaskId?: string;
  title: string;
  description?: string;
  status: TaskStatus;
  priority: TaskPriority;
  created: number;
  updated: number;
  dueDate?: number;
  assignee?: string;
  linkedNotes?: string[];
  tags?: string[];
  dependsOn?: string[];    // populated from task_dependencies JOIN
  metadata?: Record<string, unknown>;
}

export interface TaskSummary {
  activeProjects: number;
  totalTasks: number;
  openTasks: number;
  inProgressTasks: number;
  completedTasks: number;
  blockedTasks: number;
  readyTasks: number;
}

export interface DependencyEdge {
  taskId: string;
  dependsOnId: string;
}

export interface CreateProjectData {
  id?: string;
  workspaceId: string;
  name: string;
  description?: string;
  metadata?: Record<string, unknown>;
}

export interface UpdateProjectData {
  name?: string;
  description?: string;
  status?: ProjectStatus;
  metadata?: Record<string, unknown>;
}

export interface CreateTaskData {
  projectId: string;
  workspaceId: string;
  parentTaskId?: string;
  title: string;
  description?: string;
  priority?: TaskPriority;
  dueDate?: number;
  assignee?: string;
  linkedNotes?: string[];
  tags?: string[];
  dependsOn?: string[];
  metadata?: Record<string, unknown>;
}

export interface UpdateTaskData {
  title?: string;
  description?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  dueDate?: number;
  assignee?: string;
  linkedNotes?: string[];
  tags?: string[];
  metadata?: Record<string, unknown>;
}
```

### Component Diagram (C4 Level 3)

```
+---------------------------------------------------------------+
|                    TaskManager Agent                           |
|  +-----------+  +-----------+  +-----------+  +-------------+ |
|  | Project   |  |  Task     |  |  Query    |  |  Dependency | |
|  | Tools (5) |  | Tools (5) |  | Tools (3) |  |  Tools (2)  | |
|  +-----------+  +-----------+  +-----------+  +-------------+ |
|        |              |              |              |          |
|        v              v              v              v          |
|  +----------------------------------------------------------+ |
|  |                    TaskService                            | |
|  |  - createTask()       - updateStatus()                    | |
|  |  - validateDependency()  - getWorkspaceSummary()          | |
|  +----------------------------------------------------------+ |
|        |                                   |                   |
|        v                                   v                   |
|  +-------------------+         +---------------------+        |
|  |   DAGService      |         | ProjectRepository   |        |
|  | - detectCycle()    |         | - getByWorkspace()  |        |
|  | - topoSort()      |         | - getByName()       |        |
|  | - criticalPath()  |         +---------------------+        |
|  +-------------------+                  |                      |
|        |                                v                      |
|        v                    +-----------------------+          |
|  +-------------------+     |   BaseRepository       |          |
|  |  TaskRepository   |---->| - writeEvent()         |          |
|  | - getDependencies |     | - queryPaginated()     |          |
|  | - getReadyTasks   |     | - getCachedOrFetch()   |          |
|  | - addDependency   |     +-----------------------+          |
|  +-------------------+            |            |               |
|                               JSONL         SQLite             |
+---------------------------------------------------------------+

Integration Points:
  LoadWorkspaceTool -----> TaskService.getWorkspaceSummary()
  SearchManager    -----> task_fts / project_fts
  AgentRegistration ----> Phase 2 (with memoryManager)
```

### Registration in AgentRegistrationService

TaskManager has no dependencies on other agents, so it can initialize in **Phase 1** (parallel with contentManager, storageManager, canvasManager) or **Phase 2** (if it needs WorkspaceService). Since it needs `RepositoryDependencies` (SQLite + JSONL), it should go in Phase 2 alongside memoryManager.

### CacheableEntityType Extension

`BaseRepository.ts:36` -- add `'project' | 'task'` to the `CacheableEntityType` union. Add `QueryCache.projectKey()` and `QueryCache.taskKey()` static methods following the existing pattern.

---

## SUMMARY OF RECOMMENDATIONS

| Decision | Recommendation | Confidence |
|----------|----------------|------------|
| Project entity type | First-class (own table + repo) | High |
| JSONL granularity | One file per project | High |
| DAG validation location | DAGService (service layer) | High |
| Status auto-propagation | No -- explicit queries instead | High |
| Cross-workspace deps | Prohibit | High |
| Cross-project deps | Prohibit initially, can add later | Medium |
| Cascade on workspace delete | Yes (SQL + async JSONL cleanup) | High |
| Note link update on rename | Store paths only initially | Medium |
| Separate task_dependencies table | Yes (normalized, indexed) | High |
| Number of tools | 15 (5 project + 5 task + 3 query + 2 dependency) | Medium |

## OPEN QUESTIONS

1. Should `getTaskGraph` return an adjacency list or a flattened topological list?
2. Should critical path calculation account for estimated duration (needs a new field) or just count edges?
