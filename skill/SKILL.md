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
| `--workspace` | scope for traces/memory | no | `default` | a workspace name from `memory list-workspaces` |
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

Commands are `<agent> <command>`, kebab-cased — e.g. `content read`, `content
set-property`, `memory load-workspace`. **`nexus tools` is always the source of
truth** for what's live in *this* vault; the table below is the always-on core.
Run `nexus tools <agent> <command>` for the full arg schema of any one.

**Core agents** (always available):

| Agent | Commands |
|-------|----------|
| **content** | `read` `write` `replace` `insert` `set-property` |
| **storage** | `list` `create-folder` `move` `copy` `archive` `open` |
| **search** | `content` (semantic/keyword) · `directory` (by name/path) · `memory` (past sessions/traces/states) · `query-notes` (read-only SQL over notes + frontmatter) |
| **canvas** | `read` `write` `update` `list` |
| **task** | `create-project` `list-projects` `update-project` `archive-project` · `create` `list` `open` `update` `move` `query` `link-note` |
| **memory** | `create-workspace` `list-workspaces` `load-workspace` `update-workspace` `archive-workspace` · `create-state` `list-states` `load-state` `update-state` `archive-state` |
| **prompt** | `execute` (run a text or image prompt — inline or a saved prompt — with notes as context, optionally writing the result back) · `list` `get` `create` `update` `archive` (saved-prompt library) · `list-models` · `generate-image` `generate-audio` `generate-video` `check-generated-artifact` (async media — poll `check-generated-artifact`) |
| **ingest** | `run` (import a PDF/audio file into the vault) · `capabilities` |

**App agents** — **opt-in, off by default, enabled per vault** in Nexus settings
(some are desktop-only). They appear in `nexus tools` **only when enabled**, so
run `nexus tools` to see which are live here before using one: `composer`
(`compose`/`list-formats`), `data` (`run-python`/`list-capabilities`),
`elevenlabs` (`generate-music`/`sound-effects`/`list-voices`), `skills`
(`list-skills`/`load-skill`/…), `web` (`capture-markdown`/`capture-pdf`/`links`/…).

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
  loads. List them with `memory list-workspaces`, then `memory load-workspace`.
- **Session** = continuity within a task (`--session <name>`, kept stable).
- **State** = a named checkpoint you can restore. Save one with `memory
  create-state` at meaningful milestones. You get **archive** (reversible), not
  delete.

## Gotchas

- `nexus tools` returns **schemas, not data** — don't loop it for content.
- Search/list return **locations** — follow every hit with `content read`.
- `--memory`/`--goal` are enforced — send real values or the call is rejected.
- Writes are **vault-confined** — no `..`/`~`/absolute escape.
- `content replace` uses **anchor text** (`start`/`end`), not line numbers.
- **Media generation is async** — `prompt generate-*` returns a job; poll with
  `prompt check-generated-artifact`.
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
nexus playbook prompt          # run a prompt (text/image) over your notes — inline or saved
```

A playbook is emit-only: it lists your workspaces but never loads one — you do
that yourself (`nexus use "memory load-workspace …"`) as the recipe's first step.
