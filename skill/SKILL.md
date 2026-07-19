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

`nexus` drives a running Nexus (Obsidian) vault from the shell over a local
socket — no MCP config. It has two verbs: **discover** what you can do, then
**execute**.

## Start here

**Run `nexus --help` first.** It is the authoritative, always-current manual —
commands, the context contract, CLI syntax, gotchas, and the tool catalog. It's
offline and instant (no socket), so read it before your first real command
instead of guessing.

For a common task, **`nexus playbook <name>`** gives you a ready-to-run recipe
*plus* your workspaces and the exact tools it needs, in one call. Run
`nexus playbook` to see what's available (typically: `vault-work`, `organize`,
`tasks`, `prompt`).

## The mindset (this is what `--help` can't teach you)

- **Explore → inspect → exploit.** Search/list find *locations*; `content read`
  gets *contents*; then you write. A search hit is a `{path, score}`, **not** the
  note — never quote, summarize, or edit from a hit without reading it first.
- **`nexus tools` returns schemas, not data.** It's discovery. Don't loop it
  hoping for vault content — that comes from `nexus use "content read …"`.
- **`--memory` and `--goal` are real and enforced.** You're operating a person's
  live vault; pass a genuine running summary and objective, not placeholders.
- **You can't escape the vault.** Paths are vault-relative; `..`, `~`, and
  absolute paths are rejected. That's a guardrail, not a bug.
- **Nothing is destroyed.** The AI gets archive (reversible), not delete.
- **Windows: always pass `--vault <name>`** (the vault folder's name) or set
  `NEXUS_VAULT` — named pipes can't be auto-detected there.

## The shape

```
nexus tools [selector]              # discover — tool schemas (never vault data)
nexus use "<agent command --flags>" # execute — runs a tool, prints the result
    --memory "<what you're doing>" --goal "<objective>"
```

Everything else — the flag table, per-tool schemas, syntax rules, the live
per-vault catalog (including any enabled app agents) — comes from `nexus --help`,
`nexus tools <tool>`, and `nexus playbook <name>`. Prefer those over guessing;
they're always current.
