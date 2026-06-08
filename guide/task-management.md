# Task Management

Workspace-scoped project and task management with DAG dependency tracking.

---

## Concepts

- **Projects** belong to a workspace and group related tasks
- **Tasks** belong to a project and can have subtasks, dependencies, priorities, assignees, due dates, and tags
- **Dependencies** form a directed acyclic graph (DAG) — Nexus prevents cycles and can compute next actions, blocked tasks, and topological order
- **Short task refs** give each task a compact human-facing alias like `T-1a2b3c4d` while the full UUID remains the storage key
- **Note linking** connects tasks to vault notes with a typed relationship, and the AI can now *read* those links when it lists or queries tasks

---

## Tools

| Tool | Purpose |
|------|---------|
| `createProject` | Create a new project in a workspace |
| `listProjects` | List projects in a workspace |
| `updateProject` | Update project name, description, or status |
| `archiveProject` | Archive a project (restorable) |
| `createTask` | Create a task with optional dependencies, subtasks, priority, assignee, due date, and linked notes (with link type) |
| `listTasks` | List tasks in a project with filtering — returns each task's linked notes |
| `updateTask` | Update any task field, including adding note links |
| `moveTask` | Move a task between projects |
| `queryTasks` | Query tasks across projects with filters (status, priority, assignee, tags, due date) — returns each task's linked notes |
| `linkNote` | Link a vault note to a task with a relationship type |

---

## Short Task References

Task read surfaces now include a `taskRef` such as `T-1a2b3c4d`.

- `createTask` returns both the internal `taskId` and the short `taskRef`
- `listTasks` and `queryTasks` include `taskRef` on each returned task
- Prefer `taskRef` over the raw UUID when you call `updateTask`, `moveTask`, `linkNote`, or dependency-related operations

Nexus accepts either the full internal task ID or the short ref in the task operations that target an existing task, so you can keep later tool calls readable.

---

## Linked Notes

A task can point at vault notes, and each link carries a **type** describing the relationship:

| Link type | Meaning |
|-----------|---------|
| `input` | The task **consumes** the note — required source material or a precondition (a data-flow source) |
| `output` | The task **produces** the note — the artifact or result (a data-flow result) |
| `reference` | A related or contextual note the task does **not** consume — association only (the default) |

Set the type when you create a task (`linkedNotes` accepts either a plain path string, which defaults to `reference`, or an object `{ notePath, linkType }`), add or change links later with `linkNote` or `updateTask`, or manage them in the Task detail page's **Linked notes** section. Linked notes surface to the AI through `listTasks`, `queryTasks`, and when a workspace loads — so the model sees not just *which* notes relate to a task but *how*.

---

## Settings UI

There is also a built-in management interface in **Settings &rarr; Nexus &rarr; Workspaces**. See [Workspace Memory](workspace-memory.md#task-management-ui) for details.

---

## Data Storage

Task data is stored in `data/tasks/tasks_[workspaceId].jsonl` inside the plugin directory (event-sourced) with a SQLite cache for fast queries. Edits from chat tools and the settings UI operate on the same data.
