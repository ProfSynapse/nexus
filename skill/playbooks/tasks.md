---
name: tasks
intent: Run projects and tasks with dependencies — create, list, update, and wire up a task DAG
tools: [task create-project, task list-projects, task create, task list, task query, task update, task move, task link-note, memory list-workspaces, memory create-state]
---

# Playbook: tasks

Workspace-scoped project/task management with a dependency DAG. Use it for "start
a project," "add these tasks and their dependencies," "what's unblocked," "mark X
done." Tasks live **inside a workspace, under a project** — so the flow is: load
the workspace, get or create a project (capture its `projectId`), then add tasks.

## The one thing to get right: workspace vs project

- **Workspace** comes from the **top-level `--workspace <name-or-id>` context
  flag** — the same flag you pass on every call, set to the workspace you loaded.
  Task tools read their workspace scope from it automatically. **Do not** put
  `--workspace-id` *inside* the tool string — it's a reserved context field and
  is rejected there.
- **Project** is identified by a **`projectId`** that `task create-project` (or
  `task list-projects`) returns. Capture it and pass it to task calls as
  `--project-id`.

So: load the workspace → thread `--workspace` on every call → create/find a
project → capture its `projectId` → create tasks with `--project-id`.

## Protocol

1. **Load the workspace** (spine above); thread `--workspace <name-or-id>` on
   every following call.
2. **Get a project.** `task list-projects` (scoped by `--workspace`) to find one,
   or `task create-project --name "<name>"` — note the **projectId** it returns.
3. **Add tasks.** `task create --project-id <projectId> --title "<title>"` (add
   `--description`, dependencies, etc. — see `nexus tools task create`).
4. **Wire dependencies / reorganize.** `task move` to reparent or reorder in the
   DAG; `task link-note --note-path <path>` to attach a note to a task.
5. **Track.** `task list` / `task query` to see status, what's blocked vs
   unblocked.
6. **Update.** `task update` to change status/fields. `task archive-project` when
   a project is done (reversible).
7. **Checkpoint** with `memory create-state` at milestones.

## Worked example — new project, two tasks, one depends on the other

```
# 1. load the workspace — thread --workspace (name or id) on every later call
nexus use \
  --memory "planning the launch" --goal "load the product workspace" \
  --session launch-plan \
  -- memory load-workspace --workspace product

# 2. create a project — workspace comes from --workspace; capture the projectId
nexus use \
  --workspace product --session launch-plan \
  --memory "starting the Q3 launch project" --goal "create the Q3 Launch project" \
  -- task create-project --name "Q3 Launch"
# → result includes the projectId, e.g. "proj_def456"

# 3. add tasks under that project
nexus use \
  --workspace product --session launch-plan \
  --memory "adding launch tasks" --goal "create the copy task" \
  -- task create --project-id proj_def456 --title "Write launch copy"

nexus use \
  --workspace product --session launch-plan \
  --memory "adding the dependent task" --goal "create the publish task" \
  -- task create --project-id proj_def456 --title "Publish blog post"

# 4. see the board (statuses, what's blocked)
nexus use \
  --workspace product --session launch-plan \
  --memory "reviewing the launch tasks" --goal "list tasks in the project" \
  -- task list --project-id proj_def456

# 5. checkpoint
nexus use \
  --workspace product --session launch-plan \
  --memory "project + tasks created" --goal "checkpoint the setup" \
  -- memory create-state --name launch-tasks-seeded \
  --conversation-context "created Q3 Launch project with copy + publish tasks" \
  --active-task "set up the launch project" \
  --active-files "[]" \
  --next-steps "[wire publish to depend on copy, assign owners]"
```

Run `nexus tools task create` / `task move` / `task update` for the exact fields
(dependencies, status enum, ordering) — they carry more options than shown here.

## Pitfalls

- **Putting `--workspace-id` inside the tool string** — rejected as a reserved
  context field. Scope task tools with the top-level `--workspace <name-or-id>`
  flag instead (the workspace you loaded); it accepts a name *or* an id.
- **Creating tasks with no project** — `task create` needs `--project-id`; make or
  find the project first and capture the id it returns.
- **`task link-note` needs a real `--note-path`** — a vault-relative path to an
  existing note (same confinement rules).
- **Losing the projectId** — capture it from `create-project`/`list-projects`; the
  task calls need it. (Use `--json` if you need to parse it out.)
- **`archive-project` is reversible** — it's the retire action, not a delete.
