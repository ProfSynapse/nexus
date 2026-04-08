# Workspace Memory

All Nexus data lives inside the plugin directory:

```
.obsidian/plugins/<plugin-folder>/
├── data/
│   ├── conversations/*.jsonl   # Chat history (syncs across devices)
│   ├── workspaces/*.jsonl      # Workspace events
│   └── tasks/tasks_*.jsonl     # Task/project events per workspace
└── cache.db                    # SQLite cache (auto-rebuilt, not synced)
```

JSONL files are the source of truth (sync-friendly). SQLite is a local performance cache that rebuilds automatically. Because the `data/` folder lives inside the plugin directory, Obsidian Sync includes it automatically.

---

## Workspaces

Workspaces scope your sessions, traces, and operations. Every tool call is tagged to a workspace via the context schema.

- Create and load workspaces via tools or the chat UI
- **Save states** to capture a point-in-time view of your workspace context
- Archive workspaces and states for cold storage (restorable)
- No external database required

---

## Workflows

Use workflows when you want reusable, workspace-scoped operating procedures instead of one-off prompts.

Each workflow can:
- Describe **when** it should be used
- Store **steps** in plain language
- Bind an optional **saved prompt or agent**
- Run immediately with **Run now**
- Run automatically on a **recurring schedule**

### Supported Schedules

| Schedule | Configuration |
|----------|---------------|
| Hourly | Every N hours |
| Daily | At a selected hour and minute |
| Weekly | On a selected weekday, hour, and minute |
| Monthly | On a selected day of month, hour, and minute |

### Catch-Up Behavior

When Obsidian was closed during a scheduled run:

| Mode | Behavior |
|------|----------|
| Skip missed runs | Ignore missed schedule slots |
| Run latest missed | One catch-up run for the newest missed slot |
| Run all missed | One run per missed slot, in order |

### Triggering Workflows Via Tools

AI agents can trigger workflows programmatically using `memoryManager.runWorkflow`:

- `workspaceId` — target workspace
- `workflowId` or `workflowName` — which workflow to run
- `openInChat` (optional) — open the resulting conversation

Scheduled and manual runs create a fresh chat conversation titled `[workspace - workflow - YYYY-MM-DD HH:mm]`.

---

## Task Management UI

In addition to the [task management tools](task-management.md), Nexus has a built-in settings UI.

Open **Settings &rarr; Nexus &rarr; Workspaces**, then:

1. Click **Manage Projects**
2. Open a project card
3. Review tasks in the project task table
4. Use the checkbox to mark tasks done or reopen them
5. Click **Edit** to open the full task editor

### UI Structure

- **Workspace detail** &rarr; project/task entrypoint
- **Project cards** &rarr; one card per workspace project
- **Project detail** &rarr; task table with status, priority, due date, assignee, actions
- **Task detail** &rarr; editor for title, description, status, priority, due date, assignee, tags, project, parent task

The database is the source of truth. Edits made in chat and in settings operate on the same underlying data.
