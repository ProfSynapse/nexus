# Database Engineer Planning Consultation: TaskManager Agent

## 1. SCOPE & EFFORT

**Deliverables**: 4 new SQLite tables with 13 indexes, 10 JSONL event types, DAG queries via recursive CTEs, schema migration v8->v9, TaskEventApplier for SyncCoordinator, ProjectRepository + TaskRepository.

**Estimated effort**: Medium (~4-6 hours implementation). Schema is straightforward; the DAG queries are the interesting part.

---

## 2. SCHEMA DESIGN

### Decision: Adjacency List with Separate Dependency Table (not Closure Table)

Rationale:
- SQLite recursive CTEs handle transitive queries efficiently at expected scale (100-500 tasks/workspace)
- Closure tables add O(N^2) storage and complex insert/delete trigger maintenance for marginal gains
- Matches existing codebase's simple relational patterns

### Full DDL

```sql
-- ==================== PROJECTS ====================
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  workspaceId TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'active',   -- 'active', 'completed', 'archived'
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL,
  metadataJson TEXT,
  FOREIGN KEY(workspaceId) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_projects_workspace ON projects(workspaceId);
CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);
CREATE INDEX IF NOT EXISTS idx_projects_name ON projects(workspaceId, name);

-- ==================== TASKS ====================
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  projectId TEXT NOT NULL,
  workspaceId TEXT NOT NULL,          -- denormalized (follows states/traces pattern)
  parentTaskId TEXT,                   -- subtask hierarchy (NULL = top-level)
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'pending',  -- 'pending', 'in_progress', 'completed', 'blocked', 'cancelled'
  priority TEXT DEFAULT 'medium',      -- 'low', 'medium', 'high', 'critical'
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL,
  completedAt INTEGER,
  dueDate INTEGER,
  assignee TEXT,
  tagsJson TEXT,                       -- JSON array of string tags
  metadataJson TEXT,                   -- extensible metadata
  FOREIGN KEY(projectId) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY(workspaceId) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY(parentTaskId) REFERENCES tasks(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(projectId);
CREATE INDEX IF NOT EXISTS idx_tasks_workspace ON tasks(workspaceId);
CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parentTaskId);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_priority ON tasks(priority);
CREATE INDEX IF NOT EXISTS idx_tasks_workspace_status ON tasks(workspaceId, status);

-- ==================== TASK DEPENDENCIES (DAG EDGES) ====================
CREATE TABLE IF NOT EXISTS task_dependencies (
  taskId TEXT NOT NULL,                -- the task that depends on another
  dependsOnTaskId TEXT NOT NULL,       -- the task that must complete first
  created INTEGER NOT NULL,
  PRIMARY KEY(taskId, dependsOnTaskId),
  FOREIGN KEY(taskId) REFERENCES tasks(id) ON DELETE CASCADE,
  FOREIGN KEY(dependsOnTaskId) REFERENCES tasks(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_task_deps_task ON task_dependencies(taskId);
CREATE INDEX IF NOT EXISTS idx_task_deps_depends ON task_dependencies(dependsOnTaskId);

-- ==================== TASK-NOTE LINKS ====================
CREATE TABLE IF NOT EXISTS task_note_links (
  taskId TEXT NOT NULL,
  notePath TEXT NOT NULL,
  linkType TEXT NOT NULL DEFAULT 'reference',  -- 'reference', 'output', 'input'
  created INTEGER NOT NULL,
  PRIMARY KEY(taskId, notePath),
  FOREIGN KEY(taskId) REFERENCES tasks(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_task_notes_task ON task_note_links(taskId);
CREATE INDEX IF NOT EXISTS idx_task_notes_path ON task_note_links(notePath);
```

### Design Decision Rationale

1. **Separate `task_dependencies` table over inline JSON array**: Required for recursive CTE JOINs in cycle detection (`json_each()` not reliably available in WASM SQLite). Also gives cascade DELETE, bidirectional indexes, and composite PK preventing duplicates.

2. **Separate `task_note_links` table over JSON column**: Enables bidirectional queries (task->notes AND note->tasks) without full-table scans.

3. **`workspaceId` denormalized on tasks**: Follows `states` and `memory_traces` pattern. Avoids JOIN through projects for workspace-scoped queries (most common access pattern).

4. **`parentTaskId` ON DELETE SET NULL**: Children become top-level when parent deleted. Safer than CASCADE -- user explicitly deletes subtasks if desired.

---

## 3. JSONL EVENT CATALOG

### File Organization

**Per-workspace**: `.nexus/tasks/tasks_[workspaceId].jsonl`

Rationale: Matches existing `workspaces/ws_[id].jsonl` pattern. Per-project or per-task would fragment into too many small files. Projects and tasks co-located since both are workspace-scoped.

### Event Types

| Event Type | Description |
|------------|-------------|
| `project_created` | New project with initial metadata |
| `project_updated` | Project metadata/status changes |
| `project_deleted` | Project removal |
| `task_created` | New task with all initial fields |
| `task_updated` | Task status/metadata/field changes |
| `task_deleted` | Task removal |
| `task_dependency_added` | DAG edge created (taskId depends on dependsOnTaskId) |
| `task_dependency_removed` | DAG edge removed |
| `task_note_linked` | Note linked to task with linkType |
| `task_note_unlinked` | Note unlinked from task |

---

## 4. KEY QUERIES

### Get tasks by project with dependency status
```sql
SELECT t.*,
  CASE
    WHEN EXISTS (
      SELECT 1 FROM task_dependencies td
      JOIN tasks dep ON dep.id = td.dependsOnTaskId
      WHERE td.taskId = t.id AND dep.status != 'completed'
    ) THEN 1 ELSE 0
  END as isBlocked
FROM tasks t
WHERE t.projectId = ?
ORDER BY t.priority DESC, t.created ASC;
```

### Get blocked tasks with unmet dependency IDs
```sql
SELECT t.*, GROUP_CONCAT(td.dependsOnTaskId) as blockedByIds
FROM tasks t
JOIN task_dependencies td ON td.taskId = t.id
JOIN tasks dep ON dep.id = td.dependsOnTaskId
WHERE t.workspaceId = ? AND dep.status != 'completed'
GROUP BY t.id;
```

### DAG cycle detection (run BEFORE inserting an edge)
```sql
-- Check: does adding edge (newTaskId depends on newDependsOnId) create a cycle?
-- Walk newDependsOnId's ancestor chain; if newTaskId appears, it's a cycle.
WITH RECURSIVE ancestors(id) AS (
  SELECT dependsOnTaskId AS id
  FROM task_dependencies
  WHERE taskId = ?            -- param 1: newDependsOnId
  UNION ALL
  SELECT td.dependsOnTaskId
  FROM task_dependencies td
  JOIN ancestors a ON a.id = td.taskId
)
SELECT EXISTS(
  SELECT 1 FROM ancestors WHERE id = ?  -- param 2: newTaskId
) AS hasCycle;
```
Plus simple self-reference guard: `newTaskId != newDependsOnId`.

### Topological sort (execution order)
```sql
WITH RECURSIVE topo(id, depth) AS (
  SELECT t.id, 0
  FROM tasks t
  WHERE t.projectId = ?
    AND NOT EXISTS (SELECT 1 FROM task_dependencies td WHERE td.taskId = t.id)
  UNION ALL
  SELECT t.id, topo.depth + 1
  FROM tasks t
  JOIN task_dependencies td ON td.taskId = t.id
  JOIN topo ON topo.id = td.dependsOnTaskId
  WHERE t.projectId = ?
)
SELECT id, MAX(depth) as execOrder FROM topo GROUP BY id ORDER BY execOrder;
```

### Get next actionable tasks (ready to work on)
```sql
SELECT t.* FROM tasks t
WHERE t.projectId = ?
  AND t.status = 'pending'
  AND NOT EXISTS (
    SELECT 1 FROM task_dependencies td
    JOIN tasks dep ON dep.id = td.dependsOnTaskId
    WHERE td.taskId = t.id AND dep.status != 'completed'
  )
ORDER BY t.priority DESC, t.created ASC;
```

### Get subtree (task + all descendants via parentTaskId)
```sql
WITH RECURSIVE subtree(id, depth) AS (
  SELECT id, 0 FROM tasks WHERE id = ?
  UNION ALL
  SELECT t.id, subtree.depth + 1
  FROM tasks t
  JOIN subtree ON t.parentTaskId = subtree.id
)
SELECT t.* FROM tasks t JOIN subtree s ON t.id = s.id ORDER BY s.depth;
```

### Find tasks linked to a vault note
```sql
SELECT t.* FROM tasks t
JOIN task_note_links tnl ON tnl.taskId = t.id
WHERE tnl.notePath = ?
ORDER BY t.updated DESC;
```

---

## 5. INDEX STRATEGY

| Index | Purpose | Query Pattern |
|-------|---------|---------------|
| `idx_projects_workspace` | List projects by workspace | `WHERE workspaceId = ?` |
| `idx_projects_status` | Filter by status | `WHERE status = ?` |
| `idx_projects_name` | Name lookup within workspace | `WHERE workspaceId = ? AND name = ?` |
| `idx_tasks_project` | List tasks by project | `WHERE projectId = ?` |
| `idx_tasks_workspace` | Workspace-scoped queries | `WHERE workspaceId = ?` |
| `idx_tasks_parent` | Subtask tree traversal | `WHERE parentTaskId = ?` |
| `idx_tasks_status` | Status filtering | `WHERE status = ?` |
| `idx_tasks_priority` | Priority sorting | `ORDER BY priority` |
| `idx_tasks_workspace_status` | Composite filter | `WHERE workspaceId = ? AND status = ?` |
| `idx_task_deps_task` | Dependencies of a task | `WHERE taskId = ?` |
| `idx_task_deps_depends` | Dependents of a task | `WHERE dependsOnTaskId = ?` |
| `idx_task_notes_task` | Notes for a task | `WHERE taskId = ?` |
| `idx_task_notes_path` | Tasks for a note | `WHERE notePath = ?` |

No FTS needed initially -- task text fields are short; LIKE suffices. Can add later if search becomes a bottleneck.

---

## 6. MIGRATION & INTEGRATION

### Schema Migration v8 -> v9
- All CREATE TABLE IF NOT EXISTS + CREATE INDEX IF NOT EXISTS (no ALTER TABLE needed)
- Update `CURRENT_SCHEMA_VERSION` to 9 in SchemaMigrator.ts
- Add same DDL to `SCHEMA_SQL` in schema.ts for fresh installs
- Confirm no version conflicts with other pending work

### SyncCoordinator
- New `TaskEventApplier` following `WorkspaceEventApplier` pattern
- Register in SyncCoordinator constructor
- Extend `IJSONLWriter.listFiles()` to accept `'tasks'` category

### Repository Pattern
- `ProjectRepository extends BaseRepository<Project>` -- standard CRUD
- `TaskRepository extends BaseRepository<Task>` -- CRUD + dependency management + DAG queries
- Consider separate `TaskDependencyService` for cycle detection and topological operations

### Storage Adapter
- Create parallel `TaskStorageAdapter` rather than expanding existing `HybridStorageAdapter` (already large)

---

## 7. RISKS & MITIGATIONS

| Risk | Severity | Mitigation |
|------|----------|------------|
| DAG cycle detection in WASM SQLite | Low | Recursive CTEs work; depth limit 1000 far above task DAG needs. Check BEFORE insert. |
| Performance at scale (100+ tasks) | Low | Adjacency list + indexes = O(1) per recursion step. SQLite handles 10K+ nodes. |
| JSONL replay for large task histories | Low | 1000+ events replay in <1s. Conversations are typically larger. |
| Cross-device sync creating cycles | Medium | Re-run cycle detection during SyncCoordinator replay; skip conflicting edges with warning log. |
| Cascade deletes | Low | Project->Task CASCADE intentional. ParentTask->Child SET NULL is safe. JSONL preserves history. |

---

## 8. OPEN QUESTIONS

1. **Derived vs stored `blocked` status**: Recommend derived (computed in queries via isBlocked subquery) to avoid state synchronization issues between dependency changes and task status.

2. **FTS for tasks**: Not needed initially. Can add later if search becomes a bottleneck.

3. **Schema version**: Need to confirm v9 doesn't conflict with other pending work on the branch.
