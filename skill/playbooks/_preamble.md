# Nexus playbook

This is a task primer. Below, in order, you get: **this spine**, **your
workspaces**, the **recipe**, and the **tools it needs (already discovered)** —
so you can go straight to `nexus use` without a separate `nexus tools` call.

**Every playbook starts the same way:**

1. **Pick a workspace and load it.** Choose from *Your workspaces* below and run
   `nexus use "memory loadWorkspace --workspace <name>" --memory … --goal …`. If
   none fits, create one with `memory createWorkspace`. Loading scopes your traces
   and auto-loads that workspace's task summary. (This playbook only *lists*
   workspaces — loading is your call, since only you know which one.)
2. **Thread the workspace** into every following call with `--workspace <name>`
   (the outer context flag), and keep a stable `--session <name>` for the task.
3. **Always pass real `--memory` and `--goal`** — a running summary and the
   current objective. Placeholders are rejected.
4. **Checkpoint at milestones** with `memory createState` so the work is
   restorable (archive is reversible; there is no destructive delete). It needs a
   few fields — `name`, `conversationContext`, `activeTask`, `activeFiles` (array),
   `nextSteps` (array); run `nexus tools memory createState` for the full schema.

Paths are vault-relative and confined — no `..`, `~`, or absolute escapes.
