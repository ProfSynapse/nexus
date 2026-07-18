---
name: nexus
description: >-
  Read, search, and edit the user's Obsidian vault (notes, folders, canvas,
  tasks, memory/workspaces, saved prompts) from the shell via the `nexus` CLI —
  no MCP connection needed. Use whenever the user refers to their vault, notes,
  daily notes, second brain, or Obsidian, or asks you to find/read/change
  something stored there.
when_to_use: >-
  The task involves the user's Obsidian vault or notes and the `nexus` command
  is on PATH. Not for editing files in the current code repo — use normal file
  tools for those.
---

# Nexus vault CLI

`nexus` bridges the shell to a running Nexus (Obsidian) vault over a local
socket. Everything you need to operate is below — you should not need to fetch
anything else before your first real command. Full argument schemas for a
specific tool come from `nexus tools <tool>`; a ready-to-run recipe for a whole
task comes from `nexus playbook <name>` (see the end).

## The two commands

```
nexus tools [selector]              # DISCOVER — returns tool SCHEMAS (not data)
nexus use "<agent action --flags>"  # EXECUTE — runs a tool, prints the result
    --memory "<what you're doing>" --goal "<objective>"
```

- **`nexus tools`** is discovery. It returns *schemas*, never vault content — so
  never loop it hunting for data. Drill down to the narrowest thing you need:

  ```
  nexus tools                       # all agents (overview)
  nexus tools content               # one agent's tools (compact)
  nexus tools content replace       # ONE tool, full arg schema  ← prefer this
  nexus tools "content read, search content"   # several at once
  ```

- **`nexus use`** executes. `--memory` and `--goal` are **required** — Nexus
  rejects a call without real values (a placeholder like `"N/A"` is rejected with
  a recoverable steer). Results are text (or JSON with `--json`) on stdout.

  ```
  nexus use "content read --path Daily/2026-07-17.md" \
    --memory "reviewing this week's notes" --goal "read today's daily note"
  ```

## Context (passed to `nexus use`)

| Flag | Field | Required | Default | Good value |
|------|-------|----------|---------|-----------|
| `--memory` | rolling summary of what you've done/learned | **yes** | — | `"found 3 notes on auth; merging them"` |
| `--goal` | this call's objective, one sentence | **yes** | — | `"append the summary to auth.md"` |
| `--workspace` | scope for traces/memory | no | `default` | a workspace name from `memory listWorkspaces` |
| `--session` | continuity across calls | no | `nexus-cli` | reuse one stable name per task |
| `--constraints` | guardrails | no | — | `"don't touch archived notes"` |
| `--vault` | which vault | no | the single open one / `NEXUS_VAULT` | `"My Notes"` (human name) |

Reject-worthy: empty or placeholder `--memory`/`--goal`. `workspaceId`/`sessionId`
fall back to defaults silently.

## The working loop

**explore → inspect → exploit.** Search/list to find *locations*, read to get
*contents*, then write. Don't skip the middle: a search hit is a `{path, score}`,
not the note — you must `content read` it before you can act on or quote it.

## Tool catalog

`<agent> <slug>` — e.g. `content read`, `search content`. Full arg schema:
`nexus tools <agent> <slug>`.

| Agent | Tools |
|-------|-------|
| **content** | `read` `write` `replace` `insert` `setProperty` |
| **storage** | `list` `createFolder` `move` `copy` `archive` `open` |
| **search** | `content` (semantic/keyword) · `directory` (by name/path) · `memory` (past sessions/traces/states) · `queryNotes` (read-only SQL over notes + frontmatter) |
| **canvas** | `read` `write` `update` `list` |
| **task** | `createProject` `listProjects` `updateProject` `archiveProject` · `create` `list` `open` `update` `move` `query` `linkNote` |
| **memory** | `createWorkspace` `listWorkspaces` `loadWorkspace` `updateWorkspace` `archiveWorkspace` · `createState` `listStates` `loadState` `updateState` `archiveState` |
| **prompt** | `list` `get` `create` `update` `archive` `listModels` · `generateImage` `generateAudio` `generateVideo` `checkGeneratedArtifact` (media generation is async — poll `checkGeneratedArtifact`) |

Some app tools (web capture, composer, data analysis) are **desktop-only** and
absent on a mobile vault.

## CLI syntax

- One tool per `use`: `"<agent> <slug> --flag value --flag2 value2"`. Quote the
  whole command; quote any value containing spaces.
- **Paths are vault-relative.** `..`, `~`, and absolute paths are rejected; a
  leading `/` is stripped to vault-relative. You cannot read or write outside the
  vault.
- **Arrays**: `--tags "[work, urgent]"`. Wikilink values keep their brackets:
  `--links "[[[A]], [[B]]]"`.
- **`content replace` is pattern-anchored**: `{path, start, end, content}` — the
  `start`/`end` are anchor text, not line numbers. Read the note first to get
  exact anchors. (`insert` handles append/prepend.)

## Memory: workspaces, sessions, states

- **Workspace** = a named scope (root folder + its sessions/traces/tasks). Load
  one at the start of multi-step work so your traces group and its task summary
  loads. List them with `memory listWorkspaces`, then `memory loadWorkspace`.
- **Session** = continuity within a task (`--session <name>`, kept stable).
- **State** = a named checkpoint you can restore. Save one with `memory
  createState` at meaningful milestones. You get **archive** (reversible), not
  delete.

## Gotchas

- `nexus tools` returns **schemas, not data** — don't loop it for content.
- Search/list return **locations** — follow every hit with `content read`.
- `--memory`/`--goal` are enforced — send real values or the call is rejected.
- Writes are **vault-confined** — no `..`/`~`/absolute escape.
- `content replace` uses **anchor text** (`start`/`end`), not line numbers.
- **Media generation is async** — `prompt generate*` returns a job; poll with
  `prompt checkGeneratedArtifact`.
- No open vault → the socket is absent; ask the user to open Obsidian with Nexus.
- Multiple vaults open → pass `--vault <name>` (run `nexus vaults` to list).

## Playbooks

For a common task, run one command to get a step-by-step recipe **plus** the
tools it needs preloaded and the list of workspaces to pick from:

```
nexus playbook                 # list available playbooks
nexus playbook vault-work      # search → read → create/edit (the typical loop)
nexus playbook organize        # restructure: move / archive / folder cleanup
nexus playbook tasks           # projects & tasks with dependencies
nexus playbook generate        # generate media (image/audio/video) + prompt library
```

A playbook is emit-only: it lists your workspaces but never loads one — you do
that yourself (`nexus use "memory loadWorkspace …"`) as the recipe's first step.
