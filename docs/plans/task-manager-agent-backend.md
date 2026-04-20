# TaskManager Agent — Backend Coder Planning Consultation

## 1. SCOPE IN MY DOMAIN

### New Files to Create (~18 files)

**Agent layer** (4 files):
- `src/agents/taskManager/taskManager.ts` — agent class (follows memoryManager pattern)
- `src/agents/taskManager/types.ts` — agent-specific parameter/result types
- `src/agents/taskManager/services/TaskService.ts` — business logic facade
- `src/agents/taskManager/services/DAGService.ts` — DAG operations (topological sort, cycle detection, critical path, blocked task detection)

**Tool files** (10 files, grouped by subdomain):
- `src/agents/taskManager/tools/projects/createProject.ts`
- `src/agents/taskManager/tools/projects/listProjects.ts`
- `src/agents/taskManager/tools/projects/updateProject.ts`
- `src/agents/taskManager/tools/projects/archiveProject.ts`
- `src/agents/taskManager/tools/tasks/createTask.ts`
- `src/agents/taskManager/tools/tasks/listTasks.ts`
- `src/agents/taskManager/tools/tasks/updateTask.ts`
- `src/agents/taskManager/tools/tasks/moveTask.ts` (re-parent or re-project)
- `src/agents/taskManager/tools/tasks/queryTasks.ts` (DAG queries: next actions, critical path, blocked tasks)
- `src/agents/taskManager/tools/links/linkNote.ts` (bidirectional note linking)

**Database layer** (4 files):
- `src/database/repositories/ProjectRepository.ts`
- `src/database/repositories/TaskRepository.ts`
- `src/database/repositories/interfaces/IProjectRepository.ts`
- `src/database/repositories/interfaces/ITaskRepository.ts`

### Existing Files to Modify (~6 files)

- `src/database/schema/schema.ts` — add `projects`, `tasks`, `task_dependencies`, `task_note_links` tables
- `src/database/schema/SchemaMigrator.ts` — add migration v8->v9
- `src/database/interfaces/StorageEvents.ts` — add project/task event types
- `src/database/repositories/index.ts` — export new repositories
- `src/agents/index.ts` — export TaskManagerAgent
- `src/agents/baseAgent.ts` line 183 — add `'taskManager'` to the `agentNames` array for cross-agent tool lookup
- Plugin initialization (wherever agents are instantiated) — wire TaskManagerAgent with DI

### Implementation Effort

Medium-high. ~18 new files, ~6 modifications. The DAG service is the most complex piece (cycle detection, topological sort). Everything else follows established patterns closely.

---

## 2. DEPENDENCIES & INTERFACES

### Existing Services/Utilities to Reuse

- `BaseAgent` + `registerLazyTool` — agent registration pattern
- `BaseTool` + `getMergedSchema` + `prepareResult` — tool implementation pattern
- `BaseRepository` + `RepositoryDependencies` — JSONL+SQLite hybrid storage
- `JSONLWriter` + `SQLiteCacheManager` + `QueryCache` — storage infrastructure
- `WorkspaceService` — workspace context resolution (projects are workspace-scoped)
- `createServiceIntegration` from `memoryManager/services/ValidationService.ts` — service access pattern
- `createErrorMessage` from `utils/errorUtils.ts`
- `v4 as uuidv4` from `utils/uuid` — ID generation
- `CacheableEntityType` will need extension for `'project'` and `'task'`

### New Services Needed

1. **TaskService** — business logic facade (create/update/query projects and tasks, validates workspace scoping, enforces business rules like "can't close task with open dependents")
2. **DAGService** — pure computation service (no storage):
   - `validateNoCycle(taskId, proposedDependsOn[], allEdges)` — detects cycles before adding edges
   - `topologicalSort(tasks)` — execution order
   - `getNextActions(tasks)` — leaf tasks with all deps satisfied
   - `getBlockedTasks(tasks)` — tasks with unsatisfied deps
   - `getCriticalPath(tasks)` — longest path through DAG (optional, could defer)

### Integration with Agent Registration

Following the existing pattern in `src/agents/index.ts`, add:

```typescript
export * from './taskManager/taskManager';
```

Then in whatever file instantiates agents (likely plugin init), add TaskManagerAgent with DI:

```typescript
new TaskManagerAgent(app, plugin, taskService, workspaceService)
```

---

## 3. KEY DECISIONS & TRADE-OFFS

### Tool Granularity: Separate CRUD for Projects and Tasks

**Recommendation**: Separate tools per entity (projects vs tasks), but consolidate DAG queries into a single `queryTasks` tool with a `query` parameter discriminator.

**Reasoning**: Projects and tasks have different schemas, validation rules, and lifecycles. Combining them would create bloated parameter schemas. However, DAG operations (next actions, critical path, blocked) share input patterns and can be a single tool with a `queryType` enum.

### Tool Count: 10 Tools

| # | Tool | Purpose |
|---|------|---------|
| 1 | createProject | Create workspace-scoped project |
| 2 | listProjects | List/filter projects in workspace |
| 3 | updateProject | Update project metadata, status |
| 4 | archiveProject | Soft-delete project |
| 5 | createTask | Create task with deps, parent, priority |
| 6 | listTasks | List/filter tasks (by project, status, assignee) |
| 7 | updateTask | Update task fields, status transitions |
| 8 | moveTask | Re-parent task or move between projects |
| 9 | queryTasks | DAG queries: nextActions, blockedTasks, criticalPath, dependencyTree |
| 10 | linkNote | Create/remove bidirectional links between tasks and vault notes |

**Token efficiency for Two-Tool Architecture**: 10 tools is comparable to MemoryManager (8) and ContentManager (8). The `queryTasks` consolidation keeps DAG operations from inflating the tool count.

### DAG Operations Location

**Recommendation**: `DAGService` as a pure computation class (no storage access). It takes arrays of tasks/edges and returns computed results. The `TaskService` fetches data, passes it to `DAGService`, and returns results. This keeps DAG logic testable and storage-agnostic.

### Note Linking Implementation

**Recommendation**: Separate `task_note_links` junction table, NOT metadata on the task.

**Reasoning**:
- A task can link to many notes, a note can link to many tasks (M:N)
- Querying "all tasks linked to this note" requires a table, not scanning JSON blobs
- JSONL event: `task_note_linked` / `task_note_unlinked` events
- SQLite: `task_note_links(taskId, notePath, linkType, created)` with indexes on both columns
- `linkType` allows different relationship semantics: 'reference', 'deliverable', 'specification'

### Status Model

- Projects: `active` | `on_hold` | `completed` | `archived`
- Tasks: `todo` | `in_progress` | `blocked` | `done` | `cancelled`

The `blocked` status should be auto-computed from DAG state (all incomplete dependsOn tasks), not manually set. The `updateTask` tool should enforce: can't set `done` if dependents exist that aren't `done`/`cancelled`.

### Priority Model

Tasks: `critical` | `high` | `medium` | `low` (stored as integer 1-4 for sort efficiency).

---

## 4. RISKS & CONCERNS

### File Count Explosion

18 new files is significant. Mitigations:
- Follow lazy tool registration (already planned) — no instantiation cost at startup
- Keep tool files focused — most will be 150-250 lines following existing patterns
- The `DAGService` is the only file likely to approach the 500-line limit

### Keeping Tools Under 600 Lines

The `createTask` tool is the highest risk for bloat because it needs:
- Parameter validation (many fields)
- Cycle detection before adding dependsOn edges
- Workspace/project resolution
- Note auto-linking

Mitigation: Heavy validation goes in `TaskService`, not the tool. Tools stay thin (validate params -> call service -> return result).

### DAG Cycle Detection Performance

For small-to-medium task graphs (< 1000 nodes), DFS-based cycle detection is instant. No concern unless someone creates huge task DAGs. We can add a configurable limit (e.g., max 500 tasks per project).

### Schema Migration Complexity

Adding 4 new tables + migration from v8->v9 is straightforward for new installs. For existing databases, the migration just runs CREATE TABLE IF NOT EXISTS statements — no data transformation needed. Low risk.

### Integration Testing with DAG Operations

DAG operations are pure computation — highly unit-testable. The harder testing is the full flow: create tasks with deps -> verify queryTasks returns correct next actions. This can be tested with in-memory SQLite.

### CacheableEntityType Extension

`BaseRepository.ts` line 36 defines `CacheableEntityType` as a union type. We'll need to add `'project'` and `'task'` to this, plus extend `QueryCache` with `projectKey()` and `taskKey()` static methods (following the existing `workspaceKey()` pattern).

---

## 5. RECOMMENDED APPROACH

### File Structure

```
src/agents/taskManager/
  taskManager.ts                  # Agent class, lazy tool registration
  types.ts                        # Parameter/result types for all tools
  services/
    TaskService.ts                # Business logic facade
    DAGService.ts                 # Pure DAG computation
  tools/
    projects/
      createProject.ts
      listProjects.ts
      updateProject.ts
      archiveProject.ts
    tasks/
      createTask.ts
      listTasks.ts
      updateTask.ts
      moveTask.ts
      queryTasks.ts
    links/
      linkNote.ts

src/database/repositories/
  ProjectRepository.ts
  TaskRepository.ts
  interfaces/
    IProjectRepository.ts
    ITaskRepository.ts
```

### SQLite Schema (New Tables)

```sql
-- PROJECTS
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  workspaceId TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  priority INTEGER DEFAULT 3,
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
  priority INTEGER DEFAULT 3,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL,
  dueDate INTEGER,
  completedAt INTEGER,
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

### Indexes

```sql
CREATE INDEX idx_projects_workspace ON projects(workspaceId);
CREATE INDEX idx_projects_status ON projects(status);
CREATE INDEX idx_tasks_project ON tasks(projectId);
CREATE INDEX idx_tasks_workspace ON tasks(workspaceId);
CREATE INDEX idx_tasks_parent ON tasks(parentTaskId);
CREATE INDEX idx_tasks_status ON tasks(status);
CREATE INDEX idx_tasks_priority ON tasks(priority);
CREATE INDEX idx_task_deps_depends ON task_dependencies(dependsOnTaskId);
CREATE INDEX idx_task_links_note ON task_note_links(notePath);
```

### JSONL Event Types

```
project_created, project_updated, project_archived
task_created, task_updated, task_dependency_added, task_dependency_removed
task_note_linked, task_note_unlinked
```

JSONL storage: `tasks/proj_[projectId].jsonl` — one file per project containing all task events for that project. This keeps files manageable and workspace-scoped.

### Implementation Sequence

1. **Database layer first**: Schema + migrations + repositories + events (database-engineer domain)
2. **DAGService**: Pure computation, no dependencies, highly testable
3. **TaskService**: Business logic facade connecting repositories + DAGService
4. **Agent + Tools**: Thin wrappers following existing patterns
5. **Integration**: Agent registration, plugin wiring, auto-load on workspace load

### Patterns to Follow

- **MemoryManagerAgent** — constructor pattern with DI, lazy tool registration
- **CreateWorkspaceTool** — service integration, validation, prepareResult
- **WorkspaceRepository** — BaseRepository subclass with hybrid storage
- **StorageEvents** — typed events with type guards and union types

---

## Open Questions for Plan Synthesis

1. Should projects support nesting (sub-projects), or keep flat within a workspace?
2. Should task completion cascade (auto-complete parent when all children done)?
3. Is there a need for task templates (recurring project structures)?

---

## HANDOFF Summary

- **Produced**: Planning analysis (no files — consultation only)
- **Key decisions**: 10 tools, separate DAGService for computation, junction table for note links, auto-computed blocked status, JSONL per-project storage
- **Reasoning chain**: DAG ops are pure computation -> extract to service -> testable without storage -> TaskService orchestrates -> tools stay thin -> follows existing SRP pattern
- **Areas of uncertainty**:
  - [MEDIUM] Auto-load on workspace load — need to understand workspace loading lifecycle hook to inject task/project loading
  - [LOW] Critical path calculation — may be overkill for v1, could defer
  - [LOW] Whether task_dependencies should store in same JSONL as tasks or separately
- **Integration points**: WorkspaceService (workspace scoping), plugin init (DI wiring), BaseRepository (CacheableEntityType extension), QueryCache (new key helpers)
