# Workspace Memory

Synced Nexus data lives under the storage root configured in settings:

```
<storage-root>/
├── data/
│   ├── conversations/<id>/shard-*.jsonl
│   ├── workspaces/<id>/shard-*.jsonl
│   └── tasks/<workspace-id>/shard-*.jsonl
└── skills/<provider>/<name>/SKILL.md
```

JSONL files are the source of truth. SQLite is a local, rebuildable performance cache. Skill folders hold their instructions and resources; category overrides and skill archive preferences are saved with plugin settings and survive cache rebuilds. Copying a skill folder alone does not copy those preferences.

---

## Workspaces

Workspaces scope your sessions, traces, and operations. Every tool call is tagged to a workspace via the context schema.

- Create and load workspaces via tools or the chat UI
- **Search by name fragment** instead of listing everything — `memory search-workspaces "research"` ranks matches across name, description, and folder, and `--load` opens the workspace directly when exactly one matches
- **Save states** to capture a point-in-time view of your workspace context
- Archive workspaces and states for cold storage (restorable)
- No external database required

When a workspace loads, its **recent activity** is grouped by session and carries the memory, goal, and constraints captured with each trace — so the AI sees not just *what* happened recently but *why*.

---

## Workflows

Use workflows when you want reusable, workspace-scoped operating procedures instead of one-off prompts.

Each workflow can:

- Describe **when** it should be used
- Store **steps** in plain language
- Bind an optional **saved prompt**
- Attach skills by their **provider and folder name**
- Preload tools by an **agent or agent/tool selector**
- Run immediately with **Run now**
- Run automatically on a **recurring schedule**

### Preloading a workflow

Workspace lists and discovery show their available workflows. Load one explicitly with:

```text
memory load-workspace "Research" --workflow "Review evidence"
```

This prepares the selected workflow's prompt, steps, skill instructions, resource locations, and full required tool schemas. It does not execute the instructions, tools, or an LLM run. A missing, archived, or unavailable dependency fails preparation without changing the current selection.

There is no default workflow. Loading a workspace without `--workflow` clears the active workflow setup; ordinary internal refreshes preserve it. `memory run`, **Run now**, and schedules execute workflows using the same preparation logic.

### Instruction library

**Settings -> Nexus -> Instructions** combines the browsing and editing surface for prompts and skills. Filter by type, category, or source. Prompts retain their saved IDs and single text body. Skills retain their folder packages, with `SKILL.md` and any supporting files. Core skill tools remain available without an Apps install/enable switch; provider import and sync-back remain explicit preferences.

A skill may declare required tool selectors under `metadata.nexus.tools` in its frontmatter. Selectors such as `content read` describe capabilities to preload; arguments and executable commands are rejected. Supporting files are listed for selective reading rather than loaded wholesale.

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

AI agents can trigger workflows programmatically using `memory run`:

- `--workflow-id` or `--workflow-name` — which workflow to run
- `--open-in-chat` (optional) — open the resulting conversation

The target workspace comes from the call's `workspaceId` context field, not a
flag on the tool.

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
- **Task detail** &rarr; editor for title, description, status, priority, due date, assignee, tags, project, parent task, plus **Dependencies** (depends-on / blocks) and **Linked notes** (with link type) sections

The database is the source of truth. Edits made in chat and in settings operate on the same underlying data.
