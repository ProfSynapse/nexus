# Nexus usage skill + `nexus playbook` — plan

**Status:** implemented (Tracks A–D landed; verified against the live `code` vault) + Fable
red-team pass + Opus doc-vs-schema audit applied + installed & tested in Obsidian.
**Branch:** `feat/nexus-playbooks-skill` (PR #289)

**Doc-vs-schema audit (2026-07-19, Opus, against the live vault) — fixed in-PR:** the server CLI
parser matches `--flags` by **exact kebab-case equality** and throws `Unknown flag` on any miss (no
camelCase normalization); context fields (`workspace`/`session`/`memory`/`goal`) are reserved and
rejected *inside* the tool string. Every documented example must obey both. Fixed four blocking
doc bugs an agent would hit verbatim: (1) `content read` needs `--start-line` (found during manual
test); (2) `memory create-state` flags were camelCase → kebab (`--conversation-context`,
`--active-task`, `--active-files`, `--next-steps`) across all 3 playbooks + `_preamble`; (3)
`storage move`/`copy` `--newPath` → `--new-path`; (4) **tasks.md's whole `--workspace-id` model was
fabricated** — task tools scope via the top-level `--workspace <name-or-id>` context flag (verified
live: both name and id resolve; `--workspace-id` inside the tool string is rejected), so the "two
workspace values" section was rewritten. Added the kebab-flag + top-level-context rules to the
`--help` GOTCHAS. All corrected flag names re-verified against live `nexus tools <tool>` schemas.

**Codex reconcile fix:** the Claude Code skill is a symlink (always live) but the Codex
`~/.codex/AGENTS.md` block is copied text that `reconcile()` never refreshed → stale after updates.
Added `codexBlockStale()`, wired into `reconcile()` (auto-refresh) and `status().stale`.

**Follow-up (agreed):** provider-selection UI in GetStartedTab (checkbox list of which agent
providers to install into, incl. ones we don't auto-detect) — its own small PR after #289 lands.

**Red-team review (2026-07-19, Fable) — fixed in-PR:** (1) BLOCKING — `readdirSync` was dropped
from the `node:fs` import during the `cli/playbooks.ts` extraction, silently killing vault
enumeration (every no-`--vault` command failed; caught by nothing because `cli/**` was never
type-checked). Fixed + root-caused: added `cli/tsconfig.json` and a `tsc -p cli` gate in
`build-cli.mjs` (proven to catch the exact dropped-import class), plus a `nexus vaults` assertion
in `smoke.sh`. (2) Minor — path-traversal in `nexus playbook <name>` (local `.md` read, no
privilege boundary): added a name guard rejecting `/`, `\`, `..`, leading `.`. (3) Minor — `--help`
CONTEXT line overstated flags on `playbook`: narrowed. **Deferred (follow-up-safe):** orphaned
playbooks are never pruned when the embed set shrinks (add a dir-vs-embed prune, like the skills-app
provider prune); a unit test asserting `playbooksDir() === getPaths().playbooksDir`; extracting
`runPlaybook()` from `main()` for SRP.
**Builds on:** the local CLI agent bridge (PR #287 / `docs/plans/local-cli-agent-bridge-plan.md`).

## 1. Goal

An external coding agent (Claude Code, Codex) with the `nexus` CLI on PATH should be able to
drive the vault **effectively and with minimal round-trips**. Today it gets a thin `skill/SKILL.md`
that teaches `nexus tools` (discover) → `nexus use` (execute) and defers *everything* else to live
`nexus tools <selector>` calls. That is correct but under-powered: the agent re-learns the contract,
the syntax, and the common failure modes by trial and error, and every task starts from a cold
`nexus tools` crawl.

Two moves fix that:

1. **Make `SKILL.md` a compact, self-contained operating manual** — the context contract, CLI
   syntax, a *terse* tool index, and the gotchas all inline, so the agent needs **zero extra reads**
   to operate correctly. Full arg schemas still come from `nexus tools <tool>` on demand (unchanged).
2. **Add `nexus playbook <name>`** — an *executable primer* per common task. One call returns the
   recipe **and** preloads what the task needs, collapsing "read skill → nexus tools → nexus use"
   into "one playbook call → nexus use".

## 2. Current state (verified against `main` @ 544cbbc9)

- **`skill/SKILL.md`** (repo root) — the source of truth. Embedded by `scripts/generate-cli-content.mjs`
  into `src/utils/cliAssets.ts` as `NEXUS_SKILL_MD` (alongside `NEXUS_CLI_JS`, `NEXUS_AGENTS_MD`, and a
  combined content hash), which `LocalCliInstaller.ts` writes to `<dataDir>/skill/SKILL.md` on user action.
- **On-disk layout** (`LocalCliInstaller.getPaths()`, verified): `<dataDir>` = `~/.local/share/nexus`
  (macOS/Linux) or `%LOCALAPPDATA%/nexus` (Windows). It writes `<dataDir>/nexus-cli.js` (chmod +x) and
  `<dataDir>/skill/SKILL.md`. The bin entry is `~/.local/bin/nexus` → symlink to the CLI. **The Claude
  Code skill is a symlink `~/.claude/skills/nexus` → `<dataDir>/skill`** (Windows: recursive `copyDir`),
  so anything added under `<dataDir>/skill/` (e.g. `playbooks/`) surfaces in the skill automatically —
  no extra link. `reconcile()` refreshes the CLI + skill files whenever the embedded content differs.
- **`cli/nexus-cli.ts`** — the standalone CLI (node builtins only, bundled to `nexus-cli.js`). Command
  dispatch is a flat `cmd = positionals[0]` switch: `help | vaults | doctor | tools | use`.
  - `nexus tools <selector>` → `toolManager_getTools` with auto-filled `memory`/`goal` (discovery is
    exempt from the contract, so it fills placeholders).
  - `nexus use "<cmd>"` → `toolManager_useTools`; **requires** `--memory` + `--goal`; context defaults
    `workspaceId="default"`, `sessionId="nexus-cli"`.
  - `withClient(vault, fn)` opens one socket session; `resolveVault` handles `--vault` / `NEXUS_VAULT`
    / single-open-vault.
- **Real memory-agent tool names** (for the playbook output + recipes): `memory list-workspaces`,
  `memory load-workspace`, `memory create-workspace`, `memory create-state`, `memory list-states`.
- **Asset pipeline**: `scripts/build-cli.mjs` (bundles the CLI) → `scripts/generate-cli-content.mjs`
  (embeds `nexus-cli.js` + `skill/SKILL.md` + `cli/agents-snippet.md` → `cliAssets.ts`).

## 3. Design

### Layer A — `nexus --help` is the authoritative manual; `SKILL.md` is a thin router

**Revised (2026-07-18):** the operating reference does **not** live in `SKILL.md`. It lives in
`nexus --help`, which ships with the binary, runs **offline and instantly** (no socket), and is
**regenerated on every rebuild** — so it can never drift from the code the way machine-global prose does.
Crucially, `nexus --help` is *free*: it is not one of the socket-backed `nexus tools` round-trips the
earlier design was avoiding, so moving reference there costs nothing and is the agent's natural first step.

- **`nexus --help`** (in `buildUsage()`, `cli/nexus-cli.ts`) is the full manual: the two verbs, the
  context-contract flag table, CLI syntax/quoting/arrays, the gotchas, a static core/app catalog line
  that points at `nexus tools` for the live per-vault set, and a **generated** PLAYBOOKS list (built from
  the installed `skill/playbooks/*.md` via `listPlaybooks`, with a graceful "(none installed)" fallback).
- **`SKILL.md`** shrinks to **frontmatter trigger + orientation + the stable mindset**: what Nexus is and
  when to use it vs normal file tools, the explore→inspect→exploit loop, and the 4–5 behavioral gotchas
  that prevent the worst failures (act-on-a-hit-without-reading, loop-discovery-for-data, placeholder
  context, path-escape, archive-not-delete). It then routes loudly: **"run `nexus --help` first, then
  `nexus playbook <name>`."** No catalog/flag/syntax tables — those would duplicate `--help` and drift.
- **`cli/agents-snippet.md`** (Codex `AGENTS.md` block) mirrors the same: lead with `nexus --help`, add
  the `nexus playbook` router.

Rationale: single source of truth for volatile reference (kills SKILL.md/`--help` drift); `--help`
self-updates on rebuild and rides the existing `reconcile()` refresh; SKILL.md keeps only what an agent
needs *before* it runs `--help` (trigger + mindset), which is stable and rarely edited.

> **Superseded** — the original Layer A below aimed to make `SKILL.md` itself the compact self-contained
> manual (contract + syntax + terse catalog inline). That created exactly the machine-global-prose
> staleness problem the app-catalog work surfaced; the `--help`-authoritative split resolves it. The
> section list is retained for history:

1. What Nexus is + the `nexus use "…" --memory --goal` shape (one example).
2. Two-tool protocol — `nexus tools` = discovery (schemas), `nexus use` = execution. *Don't loop
   discovery; it never returns vault content.*
3. The loop — exploration (search/list) → inspection (read) → exploitation (write/move).
4. Context contract (compact table) — the 5 fields, which are **enforced** (`memory`/`goal`), good-vs-
   rejected values, the recovery move, CLI defaults for `workspaceId`/`sessionId`.
5. CLI syntax — `agent action --flags`, quoting, arrays (`"[a, b]"`), escaping, the rejected legacy
   nested shapes.
6. Memory model (short) — workspace / session / state; archive-not-delete for the AI.
7. Tool catalog (terse index) — the **8 always-on core agents** (`content`, `storage`, `search`,
   `canvas`, `task`, `memory`, `prompt`, `ingest`), one line of tool names each. **Apps are listed
   separately as opt-in and deferred to live `nexus tools`** (see §3.3).
8. Gotchas — symptom → why → fix (see §5).
9. Playbooks — the list + `nexus playbook <name>`, and when to reach for one.

Everything above "Playbooks" is reference the agent should never have to re-fetch.

### Layer A.3 — dynamic availability & keeping the skill current (verified against `AppManager`)

The skill is **machine-global** (`~/.local/share/nexus/skill/`, symlinked to `~/.claude/skills/nexus`)
but tool availability has **two independent axes of drift**. Handling each keeps `SKILL.md` correct
without turning it into a thing that constantly needs hand-editing:

1. **Per-vault app enablement (changes anytime).** `AppManager.getBuiltInAppRegistry()` registers
   `elevenlabs`, `composer`, `web-tools`, `skills`, `data`; each is gated on `config.enabled` (**off by
   default**, toggled per vault via `setAppEnabled`). Core agents (`content`/`storage`/`search`/`canvas`/
   `task`/`memory`/`prompt`/`ingest`) are always registered. A machine-global file *cannot* track a
   per-vault, runtime-mutable toggle — so **the catalog lists only core statically and defers apps to
   live `nexus tools`**, which is the genuine per-vault source of truth. Payoff: **adding a new app needs
   zero skill change** — it appears in `nexus tools` when enabled, and `nexus playbook`'s live `getTools`
   picks up its tools automatically. *(Rejected: baking a live catalog into `SKILL.md` at install time —
   it would be wrong for the machine's other vaults and stale the instant the user toggles an app.)*
2. **Plugin-version drift (new core tools shipped in a release).** Handled by the existing embedded-asset
   + content-hash model: `reconcile()` rewrites `<dataDir>/skill/*` whenever the embedded content differs
   (on plugin load / settings action). New **core** tools ride this path — bump the catalog in `SKILL.md`
   in the same PR that adds the tool, and users get it on next reconcile. Track C extends the same hash
   compare to the playbook set. *(No per-tool skill wiring: the catalog is a hand-maintained map of core
   agents, deliberately terse, and only core changes with a release.)*

Net: `SKILL.md` core catalog changes only on a core-tool release (rare, rides reconcile); apps and any
newly-added app never touch the skill (deferred to live discovery). The "update the skill when we add
apps/tools" worry resolves to **nothing to do for apps, and a one-line catalog edit for core**.

### Layer B — `nexus playbook <name>`

A new `cmd` branch in `cli/nexus-cli.ts`. Side-effect-free (emits text; never writes to the vault).

```
nexus playbook                 # list available playbooks: name + one-line intent (no socket needed)
nexus playbook vault-work      # emit the composed primer for that task
```

**`nexus playbook <name>` emits one composed document to stdout, in order:**

1. **Shared preamble** (constant, DRY — no playbook repeats it): the workspace/state/contract spine —
   "load or create a workspace first, thread its id, checkpoint with `memory create-state` as you go,
   always pass real `memory`/`goal`."
2. **Available workspaces** — one `memory list-workspaces` call via `withClient`, rendered as a short
   list. This is the side-effect-free preload that removes the "what workspaces exist?" round-trip and
   lets the agent *choose* a workspace to load (the one step that must stay in its hands — the CLI
   can't know the name ahead of time).
3. **Task recipe** — the playbook body (markdown after frontmatter): protocol steps → worked example →
   pitfalls.
4. **Preloaded toolset** — one `toolManager_getTools` call with the frontmatter `tools` selector
   (comma-joined), i.e. exactly what `nexus tools "a, b, c"` returns, appended as ready-to-use schemas.

Steps 2 + 4 share the single `withClient` socket session. Net: **one command → recipe + which
workspaces exist + the exact tools loaded**, then the agent issues its first `nexus use`.

**Playbook file = markdown with frontmatter** (co-located toolset declaration, codeless to extend):

```yaml
---
name: vault-work
intent: Search the vault, read what you find, then create or edit notes
tools: [search content, search directory, content read, content write, content replace, content insert, content set-property, storage list]
---
(body: protocol, worked example, pitfalls)
```

The CLI parses frontmatter (`name`, `intent`, `tools`), loads the body, joins `tools` into a getTools
selector. Adding a playbook = drop a `.md` file; no code change.

**On-disk layout / how the CLI finds playbooks at runtime** (nailed against `LocalCliInstaller`):
- The installer writes `<dataDir>/skill/playbooks/*.md` + a shared `<dataDir>/skill/playbooks/_preamble.md`,
  next to the existing `<dataDir>/skill/SKILL.md`.
- Because `~/.claude/skills/nexus` symlinks to `<dataDir>/skill`, the playbooks appear under the Claude
  Code skill for free (Windows `copyDir` is already recursive, so it copies the subtree too).
- **The CLI locates the dir by recomputing `<dataDir>` exactly as `getPaths()` does** — `os.homedir()`
  + `.local/share/nexus` (POSIX) / `%LOCALAPPDATA%/nexus` (Windows) — **not** via `__dirname`. Rationale:
  `nexus` is invoked through the `~/.local/bin/nexus` symlink and Node resolves symlinks for `__dirname`
  by default, but `--preserve-symlinks` (or a future relocation) would break a `__dirname`-relative
  lookup. Recomputing `<dataDir>` mirrors how the CLI already mirrors `sanitizeVaultName`/socket paths
  from `connector.ts` — one small, deliberate duplication kept identical to its source.

## 4. The four playbooks

Workspace + state handling is the shared preamble, not a playbook. `search`+`edit` collapse into one
typical loop. `organize` stays separate. `tasks` stays. A new `prompt` playbook covers PromptManager —
running prompts (text or image, inline or saved) over your notes.

Tool slugs below are the **verified CLI forms** (`<agent> <slug>`), confirmed against each agent's
registration (`toKebabCase` strips `Manager`; e.g. `searchManager.searchContent` → `search content`).

| Playbook | Loop | `tools` selector (real slugs) |
|----------|------|------------------|
| **`vault-work`** | load ws → search → **read** → create/edit → checkpoint | `search content`, `search directory`, `search memory`, `content read`, `content write`, `content replace`, `content insert`, `content set-property`, `storage list`, `memory list-workspaces`, `memory create-state` |
| **`organize`** | load ws → map (`list`/`query-notes`) → plan → move/create/archive → checkpoint | `storage list`, `storage create-folder`, `storage move`, `storage copy`, `storage archive`, `search query-notes`, `memory list-workspaces`, `memory create-state` |
| **`tasks`** | load ws → project → tasks w/ deps → query → update | `task create-project`, `task list-projects`, `task create`, `task list`, `task query`, `task update`, `task move`, `task link-note`, `memory list-workspaces`, `memory create-state` |
| **`prompt`** | load ws → pick a prompt (inline or saved via `prompt list`) → attach notes → `prompt execute` (text or image) → optionally write result back → checkpoint | `prompt execute`, `prompt list`, `prompt get`, `prompt create`, `prompt list-models`, `prompt check-generated-artifact`, `content read`, `content write`, `memory list-workspaces`, `memory create-state` |

> **`prompt` playbook — the real capability** (corrects an earlier misread): `prompt execute` (slug
> `execute`) runs **text or image** prompts. Per request item you can supply an **inline `prompt`** (one
> the agent writes) *or* reference a **saved prompt** from the database (`customPrompt` = name/ID from
> `prompt list`), **attach notes** as context (`contextFiles: [paths]`, and/or `workspace` for scoped
> gathering), pick `provider`/`model` (see `list-models`), and optionally **write the result back** to a
> note (`action: {type: create|append|prepend|replace|findReplace, targetPath, start, end, …}`). It's a
> batch tool (`prompts` array, with `sequence`/`parallelGroup`/`includePreviousResults`/`contextFromSteps`
> for chaining). Image requests use `type: image` + `savePath`/`aspectRatio`/`referenceImages`; the
> dedicated async `generate-image/Audio/Video` + `check-generated-artifact` tools remain for media-only jobs.
> So the playbook teaches: **run a prompt (inline or saved) over your notes, get text or media, optionally
> act on the output.**

Each body (after the shared preamble) is just: protocol steps, one worked CLI example, pitfalls.
Pitfalls to seed: editing from a search hit without reading; answering from `{path, score}`; `move`
validates both source and target; `task link-note` needs a real `notePath`; media generation is async
(poll `check-generated-artifact`); can't write outside the vault.

## 5. Gotchas to encode (SKILL.md §Gotchas)

symptom → why → correct pattern, for each:

- discovery loop (`nexus tools` returns schemas, not vault data)
- search/list return *locations* → follow with `content read` (the satisfice trap)
- context enforcement — `memory`/`goal` placeholders rejected with a recoverable steer
- **path confinement** — `..`/`~`/absolute rejected, leading `/` stripped; no writing outside the vault
  (the just-merged Phase 1–3 hardening)
- `content replace` is pattern-anchored `{path, start, end, content}` — no line-number legacy shape
- `append`/`prepend` route through `insert`; `position < 1` rejected
- CLI array/quote/escape traps (outer `[...]`, wikilink corruption, `\uXXXX`)
- desktop-only app tools (`webTools`/`composer`/`dataAnalysis`) fail on mobile vaults
- workspace scoping — no workspace id → traces unscoped
- states: the AI gets **archive** (reversible), not delete

## 6. Work breakdown

| Track | Scope | Notes |
|-------|-------|-------|
| **A — content** | Rewrite `skill/SKILL.md` (compact self-contained); add `skill/playbooks/_preamble.md` + 4 playbook `.md` (frontmatter + body) | pure markdown; authorable immediately |
| **B — CLI** | `nexus playbook` branch in `cli/nexus-cli.ts`: no-arg list (read frontmatter), `<name>` compose (preamble + `memory list-workspaces` + body + `getTools`), frontmatter parser (tiny, no yaml dep — node builtins only), `--help`/USAGE update | reuses `withClient`, `parseArgs`, `printToolResult` |
| **C — pipeline/installer** | `generate-cli-content.mjs` embeds the playbook set as `NEXUS_PLAYBOOKS` (a `{name → content}` map + fold it into the content hash); `LocalCliInstaller.enable()`/`reconcile()` write `<dataDir>/skill/playbooks/*.md`; `uninstall()` already drops `<dataDir>` wholesale. No new symlink needed (skill dir is already linked). | keep the single content-hash refresh model; extend the `NEXUS_SKILL_MD` compare in `reconcile()` to the playbooks |
| **D — tests/smoke** | extend `cli/smoke.sh`: `nexus playbook` lists, `nexus playbook vault-work` returns preamble+workspaces+body+schemas; frontmatter-parser unit test | — |

Track A is independent and reviewable first. B depends on the frontmatter contract from A. C depends on
the file set from A. D last.

## 7. Open decisions (resolved)

- **Delivery**: build in-repo first (this plan), wire the installer as part of Track C. ✔
- **Format**: `SKILL.md` keeps CC frontmatter; playbook bodies + preamble are portable markdown any
  agent can read. ✔
- **Toolset declaration**: frontmatter `tools:` per playbook (not a central manifest). ✔
- **Side effects**: `nexus playbook` is emit-only; it *lists* workspaces but never loads/creates one —
  the agent does that with `nexus use "memory load-workspace…"`. ✔

## 8. Acceptance

- `nexus playbook` lists 4 playbooks with intents; exits 0 with no vault open (listing needs no socket).
- `nexus playbook vault-work` (vault open) prints: preamble → the real workspace list → recipe → tool
  schemas for the declared selector, in one invocation.
- `nexus --help` contains the contract + syntax + gotchas + catalog + a generated playbook list, runs
  offline, and lets an agent issue a correct first `nexus use` (real `memory`/`goal`, vault-relative
  path, `content read` after a search) with no socket round-trip. `SKILL.md` is a thin router (trigger +
  mindset) that sends the agent to `nexus --help` and `nexus playbook <name>`.
- Editing a playbook `.md` and rebuilding refreshes the installed copy via the content hash (no CLI
  code change needed to add/edit a playbook).
