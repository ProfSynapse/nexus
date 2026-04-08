# Task Management

Workspace-scoped project and task management with DAG dependency tracking.

---

## Concepts

- **Projects** belong to a workspace and group related tasks
- **Tasks** belong to a project and can have subtasks, dependencies, priorities, assignees, due dates, and tags
- **Dependencies** form a directed acyclic graph (DAG) — Nexus prevents cycles and can compute next actions, blocked tasks, and topological order
- **Note linking** connects tasks to vault notes for bidirectional reference

---

## Tools

| Tool | Purpose |
|------|---------|
| `createProject` | Create a new project in a workspace |
| `listProjects` | List projects in a workspace |
| `updateProject` | Update project name, description, or status |
| `archiveProject` | Archive a project (restorable) |
| `createTask` | Create a task with optional dependencies, subtasks, priority, assignee, due date |
| `listTasks` | List tasks in a project with filtering |
| `updateTask` | Update any task field |
| `moveTask` | Move a task between projects |
| `queryTasks` | Query tasks across projects with filters (status, priority, assignee, tags, due date) |
| `linkNote` | Link a vault note to a task |

---

## Settings UI

There is also a built-in management interface in **Settings &rarr; Nexus &rarr; Workspaces**. See [Workspace Memory](workspace-memory.md#task-management-ui) for details.

---

## Data Storage

Task data is stored in `data/tasks/tasks_[workspaceId].jsonl` inside the plugin directory (event-sourced) with a SQLite cache for fast queries. Edits from chat tools and the settings UI operate on the same data.
