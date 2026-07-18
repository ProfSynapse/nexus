---
name: tasks
intent: Run projects and tasks with dependencies — create, list, update, and wire up a task DAG
tools: [task create-project, task list-projects, task create, task list, task query, task update, task move, task link-note, memory list-workspaces, memory create-state]
---

# Playbook: tasks

Workspace-scoped project/task management with a dependency DAG. Use it for "start
a project," "add these tasks and their dependencies," "what's unblocked," "mark X
done." Tasks live **inside a workspace and a project**, so this playbook's first
job is getting those two ids.

## The one thing to get right: two different "workspace" values

- The **outer `--workspace` context flag** scopes traces/memory (a name).
- Task tools take an **explicit `--workspace-id` param** — the id **returned by
  `memory load-workspace`** (or `create-workspace`). Projects then return a
  **`projectId`** you pass to task calls as `--project-id`.

So: load the workspace → capture its id → create/find a project → capture its id
→ create tasks under it. Don't assume the outer `--workspace` name is accepted as
`--workspace-id`; pass the id the load returned.

## Protocol

1. **Load the workspace** (spine above) and note the **workspaceId** it returns.
2. **Get a project.** `task list-projects --workspace-id <id>` to find one, or
   `task create-project --workspace-id <id> --name "<name>"` — note the
   **projectId** it returns.
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
# 1. load the workspace — capture the workspaceId from the result
nexus use "memory load-workspace --workspace product" \
  --memory "planning the launch" --goal "load the product workspace" \
  --session launch-plan
# → result includes the workspaceId, e.g. "ws_abc123"

# 2. create a project — capture the projectId from the result
nexus use "task create-project --workspace-id ws_abc123 --name 'Q3 Launch'" \
  --workspace product --session launch-plan \
  --memory "starting the Q3 launch project" --goal "create the Q3 Launch project"
# → result includes the projectId, e.g. "proj_def456"

# 3. add tasks under that project
nexus use "task create --project-id proj_def456 --title 'Write launch copy'" \
  --workspace product --session launch-plan \
  --memory "adding launch tasks" --goal "create the copy task"

nexus use "task create --project-id proj_def456 --title 'Publish blog post'" \
  --workspace product --session launch-plan \
  --memory "adding the dependent task" --goal "create the publish task"

# 4. see the board (statuses, what's blocked)
nexus use "task list --project-id proj_def456" \
  --workspace product --session launch-plan \
  --memory "reviewing the launch tasks" --goal "list tasks in the project"

# 5. checkpoint
nexus use "memory create-state --name launch-tasks-seeded \
  --conversationContext 'created Q3 Launch project with copy + publish tasks' \
  --activeTask 'set up the launch project' \
  --activeFiles '[]' \
  --nextSteps '[wire publish to depend on copy, assign owners]'" \
  --workspace product --session launch-plan \
  --memory "project + tasks created" --goal "checkpoint the setup"
```

Run `nexus tools task create` / `task move` / `task update` for the exact fields
(dependencies, status enum, ordering) — they carry more options than shown here.

## Pitfalls

- **Passing the workspace *name* as `--workspace-id`** — use the id the load
  *returned*, not the outer `--workspace` name.
- **Creating tasks with no project** — `task create` needs `--project-id`; make or
  find the project first.
- **`task link-note` needs a real `--note-path`** — a vault-relative path to an
  existing note (same confinement rules).
- **Losing the ids** — capture `workspaceId`/`projectId` from each result; the
  next call needs them. (Use `--json` if you need to parse them out.)
- **`archive-project` is reversible** — it's the retire action, not a delete.
