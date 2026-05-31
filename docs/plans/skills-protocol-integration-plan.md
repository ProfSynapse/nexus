# Skills Protocol Integration — Design Plan

**Status:** Design / pre-architecture
**Date:** 2026-05-30
**Author:** design discussion (ProfSynapse + Claude)

## 1. Goal

Make agent **Skills** (the Anthropic/Claude-Code skill format: a folder containing
`SKILL.md` with YAML frontmatter `name` + `description`, plus optional bundled
reference files) discoverable and loadable inside Nexus — sourced from provider skill
folders kept **at the vault root** (`<vault>/.claude/skills`, `<vault>/.codex/skills`, …;
vault-local, not the global OS-home `~/.<provider>`).

A skill, in this design, is **not** code that runs. It is a **playbook**: a prompt the
agent reads back and follows, using Nexus's existing tools to do the actual work.

## 2. Mental model (the important part)

> **Loading a skill = `loadWorkspace` pointed at a skill folder.**

`loadSkill` does exactly what loading a workspace (with an attached agent) does, just aimed
at a skill folder. It returns:

1. **The SKILL.md text** — the "agent prompt" the model reads back and follows.
2. **The skill folder's file/structure listing** — for navigation (reuse the existing
   `WorkspaceFileCollector` / `buildWorkspacePath` machinery, pointed at the skill folder).
3. **A one-line nudge** — *"use your normal `content read` tool to open any of these files."*

That's the whole mechanism for the *prompt* part. No `readSkillResource` tool, no
bundled-resource manifest, no `skillId` tool routing/scoping, no per-turn re-injection of the
SKILL.md. The bundled files already live in the vault, so the agent navigates them with the
**existing** `ContentManager.read` tool. The model retains the loaded SKILL.md in its own
conversation context and follows it.

The one stateful addition is **skill usage history** (§9) — `loadSkill` *also* returns "what
you did with this skill last time, wherever you were." That requires tracking which skill(s)
are active per session, but **only for attribution**, never for routing.

Consequences of this model:

| Property | Decision | Why |
|---|---|---|
| Cardinality | **Stackable / ad-hoc** — load any skills, whenever | A load is just text in context; multiple loads just coexist |
| Activation | **Explicit** — the agent calls `loadSkill` | No auto-activation magic; name+desc are discoverable and the model self-selects |
| Effect on tools | **None** | A skill augments *instructions*, it does not scope/route execution |
| Code execution | **Never (v1)** | Mobile can't; security/sandbox cost; muddies executePrompts boundary. Bundled scripts are *readable reference*, not executables |
| Persistence | Lives in the model's context window after load | No `SessionContextManager` skill dimension required for the core MCP path |

### How this differs from the three existing systems

- **Custom Prompts** (`PromptManager`): flat name+desc+body in SQLite, "persona adoption."
  A skill is a *richer* cousin — folder-structured, with bundled resources, **usage history**
  (§9), and **bidirectional provider sync** (§3). Both the user (settings UI) and the model
  (CRUA tools) can edit skills, but through a **validation layer** (§7) that enforces SKILL.md
  formatting conventions. The CRUA contract mirrors the state tools (v5.9.6 / #215): the model
  gets create/update/**archive** (soft, reversible); the settings UI also gets hard **delete**.
- **executePrompts**: a batch LLM-execution engine with file side-effects. **Orthogonal.**
  A skill is not a prompt you *run* — it is instructions you *read*. `loadSkill` returns
  text with the same "instructions only — do NOT auto-execute" boundary language that
  `getPrompt` already uses (`src/agents/promptManager/tools/getPrompt.ts:61-70`).
- **Workspaces**: activate a *data scope* (files/tasks, `workspaceId` routing). Skills
  activate *know-how* (a playbook). Same load gesture, different semantics.

## 3. Source → destination sync

### Provider discovery by pattern (no hardcoding)

**[RESOLVED §11.3 — v1 scope: vault root only.]** Scan the **vault root** for `.{provider}/skills/`
folders, read via **`vault.adapter`** (the same sanctioned hidden-folder exception the plugin
already uses for `.nexus/`). No `desktopRequire`/`fs`, no OS-home reach — everything stays
vault-relative, so discovery/import work cross-platform.

- **Provider id = dotfolder name minus the dot:** `.claude`→`claude`, `.codex`→`codex`,
  `.cursor`→`cursor`, `.antigravity`→`antigravity`. Adding a provider is **zero code**.
- **Validate a match** by "contains `<name>/SKILL.md` children" — filters out `.obsidian` etc.
- **Out of scope (by decision):** Nexus does **not** reach the global OS-home `~/.<provider>/skills`
  the CLIs write to. Everything stays **local to the project vault** — provider folders are
  expected at the vault root (user-placed or symlinked). No `fs`, no home-dir reach, ever.

The `/skills` subfolder lives *inside* each provider dotfolder; we strip that segment and use
the dotfolder name as the namespace:

```
<vault>/.claude/skills/essay-editor/   →   Nexus/skills/claude/essay-editor/
<vault>/.cursor/skills/essay-editor/   →   Nexus/skills/cursor/essay-editor/
<vault>/.codex/skills/pr-reviewer/     →   Nexus/skills/codex/pr-reviewer/
        └┬───┘ └─┬──┘                              └─┬──┘
      provider  stripped                         provider id
```

### Destination — provider-namespaced mirror

> **Never hardcode `Nexus/`.** The storage root is the user setting `MCPStorageSettings.rootPath`
> (default `Nexus`, but user-configurable). Resolve it at runtime via the existing
> `VaultRootResolver` / `PluginStoragePathResolver`. `<root>/` below = that resolved value;
> `Nexus/` anywhere in this doc is just shorthand for it.

In-vault under the resolved plugin storage root (`<root>/`):

```
Nexus/skills/<provider>/<skill-name>/SKILL.md          ← e.g. Nexus/skills/claude/essay-editor/
Nexus/skills/<provider>/<skill-name>/_archive/<ts>/    ← prior versions (co-located, travels w/ sync)
Nexus/skills/nexus/<skill-name>/                       ← vault-native skills (reserved 'nexus' provider)
```

- **Namespaced by provider** → no cross-provider name collisions (two providers can each have
  `essay-editor`). We strip the provider's own `skills/` segment — it's
  `Nexus/skills/claude/essay-editor/`, **not** `…/claude/skills/…`.
- `source` is therefore just the **first path segment**, not a separate nesting concept.
- The unique key is **`(provider, name)`**, not `name` alone (schema §4; disambiguation §12).
- Once mirrored, skills ride Obsidian Sync to **mobile** and are watchable by vault events.
  The in-vault copy is the only thing the agent ever touches — discovery, load, and edit work
  identically on mobile.

### Bidirectional sync (provider ⇄ Nexus) — archive-then-replace

Both ways, all via `vault.adapter` (vault-relative, so cross-platform):

- **Import** (provider → Nexus): `<vault>/.<provider>/skills/<name>/` → `Nexus/skills/<provider>/<name>/`.
- **Sync-back** (Nexus → provider): a changed mirror copy writes back to its origin dotfolder.

(Caveat: the `.{provider}/` source dotfolders may not ride Obsidian Sync to mobile, so in
practice a desktop seeds them; the `Nexus/skills/` mirror is what every platform reads.)

**No conflict reconciliation — same model as CRUA archive.** Before *any* overwrite (sync
either direction, or a CRUA `updateSkill`), copy the current version into the skill's own
**`_archive/<timestamp>/`** (co-located, so it exists on both the Nexus and provider sides),
then write the new version. **Last-writer-wins**; the `_archive` is the recovery net. A single
`content_hash` is kept only to **skip identical writes** — not for conflict logic. The scanner
ignores `_`-prefixed entries, so `_archive` is never mistaken for a skill.

Mobile edits the vault copy freely; sync-back happens the next time a desktop runs.
**Vault-native skills** (provider `nexus`, no `origin_path`) just live in the vault unless the
user explicitly exports them to a provider. (Open questions §11.)

## 4. Discovery & index

- **`SkillScanner`** walks `<root>/skills/<provider>/<name>/SKILL.md`, **ignoring `_`-prefixed
  entries** (so `_archive/` is never read as a skill), and parses each frontmatter
  (`name`, `description`). **Correction to an earlier note:** `yaml` (^2.8.1) *is* already a
  dependency and is mobile-safe **when dynamically imported** (`await import('yaml')`, no Node
  API) — it's used that way in `ContentManager.write`. For the in-vault mirror files,
  `app.metadataCache.getFileCache(file).frontmatter` is even cheaper; fall back to
  `adapter.read` + `yaml.parse` for dot-prefixed source files (metadataCache skips dot paths).
- Upserts into a SQLite `skills` table — a **derived cache** of folder contents.
- Names+descriptions surface two ways:
  1. `listSkills` tool result. (The `Skills` app's tools auto-appear in `getTools` once installed,
     via the dynamic-agent sync — §6.)
  2. *Optional:* inject individual skill names into the `getTools` description preamble the way
     `customAgents` already are via `SchemaData` (`toolManager.ts:21-35`, `getTools.ts:37-81`), so
     the agent is *aware* of specific skills without a call. Deferrable — `listSkills` covers it.

### Schema (v12 → v13 migration)

Follows the proven migration pattern in `src/database/schema/SchemaMigrator.ts`
(add migration object, bump `CURRENT_SCHEMA_VERSION`).

```sql
CREATE TABLE IF NOT EXISTS skills (
  id            TEXT PRIMARY KEY,
  provider      TEXT NOT NULL,    -- 'claude' | 'codex' | 'cursor' | 'antigravity' | 'nexus' (vault-native) | …
  name          TEXT NOT NULL,    -- skill name (folder); NOT globally unique
  description   TEXT,
  vault_path    TEXT NOT NULL,    -- Nexus/skills/<provider>/<name>  (for lazy body/resource reads)
  origin_path   TEXT,             -- <vault>/.<provider>/skills/<name> for sync-back (NULL = vault-native)
  content_hash  TEXT NOT NULL,    -- skip identical writes + change detection (§3)
  is_archived   INTEGER DEFAULT 0,-- soft-delete (CRUA archive)
  last_loaded_at INTEGER,         -- updated on loadSkill — drives recency ordering in listSkills (§11.4)
  created       INTEGER NOT NULL,
  updated       INTEGER NOT NULL,
  UNIQUE(provider, name)          -- composite key — same name allowed across providers
);
CREATE INDEX IF NOT EXISTS idx_skills_name ON skills(name);
```

`provider` is discovered by the vault-root `.*/skills/` scan (§3) and equals the first path
segment, so it's open-ended — new providers need no schema change. SKILL.md bodies and bundled
files live on disk and are read lazily — never duplicated into the cache. Most columns are
derived (rebuildable by re-scan); `is_archived` and `last_loaded_at` are the **owned state** a
re-scan must preserve rather than overwrite.

## 5. Refresh — event-driven

- **Mirror refresh (`<root>/skills/`, non-dot):** `registerEvent(vault.on('create'|'modify'|
  'delete'|'rename', …))` — reliable, desktop + mobile, catches skills arriving via Obsidian
  Sync. Debounce + content-hash to avoid thrash.
- **Source refresh (`.{provider}/skills/`, dotfolders):** ⚠️ **Obsidian's vault API does not
  index hidden/dot paths** — `vault.getAbstractFileByPath` / `getFiles()` / `metadataCache`
  ignore them, and `vault.on(...)` may not fire for them. So the source side is read/listed via
  **`vault.adapter.list`/`read`/`stat`** (the `.nexus/` exception) and scanned **explicitly on
  startup + manual "Sync skills"**, not via file events.
- **Cascade:** import copies a source skill into `<root>/skills/` → that write *does* fire a
  vault event → the index refreshes. So the dot-side limitation only affects *detecting* source
  edits (needs a manual/startup scan); everything downstream of the mirror is event-driven.

> Note the dynamic-registration parallel: like `AppManager`'s runtime agent install/uninstall
> (pinned context, issue #174), the available-skills set changes at runtime. Keep the refresh
> path simple and idempotent.

## 6. Surface: a `Skills` **App** (not a core agent)

**[DECISION] Skills ships as an installable App, not a default agent.** It's opt-in — users
install it from **Settings → Apps** like WebTools/Composer/ElevenLabs. This is the right home:
skills are an optional capability, and the app framework gives install/enable/uninstall +
settings UI + auto-discovery for free. Follow the existing builder docs:
`docs/BUILDING_APPS.md` (step-by-step) and `docs/architecture/apps-architecture.md` (reference).

Shape (mirrors `ComposerAgent` — cross-platform, no credentials):

```
src/agents/apps/skills/
  SkillsAgent.ts          # extends BaseAppAgent, manifest + registerTool(...)
  tools/{listSkills,loadSkill,createSkill,updateSkill,archiveSkill,syncSkills}.ts
  services/{SkillScanner,SkillStorageService,SkillValidator,SkillSyncService}.ts
```

```ts
// SkillsAgent.ts — manifest (no credentials, validation 'none', cross-platform)
const SKILLS_MANIFEST: AppManifest = {
  id: 'skills', name: 'Skills', author: 'Nexus', version: '1.0.0',
  description: 'Discover, load, edit, and sync agent skills (SKILL.md folders) across providers.',
  credentials: [], validation: { mode: 'none' },
  tools: [ /* slugs + descriptions, mirrored from the table below */ ],
};
```

**Wiring is one line** — register the factory in `AppManager.getBuiltInAppRegistry()`
(`src/services/apps/AppManager.ts:223`): `registry.set('skills', () => new SkillsAgent())`.
On install, `AppManager`'s register callback fires `syncToolManagerAgent('register', agent)`
→ `ToolManagerAgent.registerDynamicAgent` → `getTools` description refreshes, so the tools (and
skill names, §4) become discoverable with **no core-agent edits**. Uninstall reverses it.

| Tool | Purpose | Returns |
|---|---|---|
| `listSkills` | discovery | `[{name, provider, description, lastLoadedAt}]`, recency-ordered (§11.4) |
| `loadSkill <name> [--source]` | activate (loadWorkspace-shaped) | SKILL.md body + skill folder listing + nudge to use `content read` + **recent usage history** (§9) |
| `createSkill` | CRUA (validated, §7) | creates `<root>/skills/<provider>/<name>/SKILL.md` from name+description+body |
| `updateSkill` | CRUA (validated, §7) | updates an existing skill's frontmatter/body |
| `archiveSkill` | CRUA (soft, reversible) | sets `is_archived` — the model's only "delete" |
| `syncSkills` | import + sync-back (vault.adapter, cross-platform) | summary of imported/synced-back/skipped |

No `readSkillResource` — bundled files are read with the existing `ContentManager.read` tool
once `loadSkill` has listed them. Hard **delete** is **UI-only** (the app's settings), mirroring
the state CRUA contract (#215): the model can archive but never permanently destroy. The app is
**cross-platform** (no desktop guards) — everything is `vault.adapter`, so it works on mobile;
only the source dotfolders being present is device-dependent (§8).

## 7. Editing & validation

Both the model (CRUA tools above) and the user (settings UI) edit skills through one
**`SkillValidator`** so every write keeps the skill loadable and well-formed:

- **Required frontmatter:** `name` + `description` present and non-empty.
- **Name conventions:** lowercase-hyphenated; matches the folder name; unique.
- **Description quality:** non-empty, within a sane length bound (it's the discovery signal
  surfaced in `listSkills` / the `getTools` preamble — garbage descriptions degrade selection).
- **Structure:** `SKILL.md` exists at the skill-folder root; bundled paths stay inside the
  skill folder (no traversal).

Validation runs **before** the file write (reject with a clear error, like the executePrompts
`replace` validation). Reuse/extend the existing `ValidationService` rather than a bespoke path.

> **Two distinct "archive" nets — don't conflate them:** (1) `is_archived` (CRUA) soft-deletes
> a *whole skill* — hidden from `listSkills`, restorable; (2) the §3 archive folder snapshots
> the *prior version* of a skill's files before any overwrite (update/sync). Both give
> reversibility, but one hides a skill and the other backs up content.

### Settings UI

Hosted in the **app's own settings** (Settings → Apps → Skills → edit), via
`AppsTab.buildSettingsSections` / `AppConfigModal` — **not** a new top-level tab. The section is
modeled on the states-management UI (v5.9.6 / #215–#216): list skills, create/edit (with live
validation), archive/restore, hard-delete, plus the manual "Sync skills" trigger.

## 8. Mobile / desktop split

With vault-root discovery via `vault.adapter` (§3), there's **no `fs` dependency** — the split
is now only about whether the source dotfolders are present, not about the read mechanism.

| Capability | Desktop | Mobile |
|---|---|---|
| Import/sync (`<vault>/.{provider}/skills` ⇄ `Nexus/skills/`) | ✅ via `vault.adapter` | ✅ *if* the source dotfolder synced over |
| In-vault scan + index | ✅ | ✅ |
| Obsidian-event refresh | ✅ | ✅ |
| `listSkills` / `loadSkill` / edit | ✅ | ✅ |

Caveat: `.{provider}/` source dotfolders may not ride Obsidian Sync to mobile, so in practice a
desktop seeds/imports them. The `Nexus/skills/` mirror is a **syncing** folder (NOT a dotfolder
like `.nexus/`), so every platform gets full discovery, load, and edit from the mirror.

## 9. Skill usage history (cross-context activity)

> **Inversion:** a *workspace* tracks "what happened in this folder." A *skill* tracks "what I
> accomplished **with** this skill, wherever I was" — cross-workspace episodic memory keyed to
> the skill, surfacing work that lives in *other* folders.

Example: load **Essay Editor** and it shows the LLM —
*"Recent work with this skill: `essay-draft-3.md` (Blog workspace, 2d ago, state `midway-edit`
saved); `cover-letter.md` (Job Hunt workspace, 1w ago)."*

### Data-ownership split (important)

| | Source of truth | Storage pattern |
|---|---|---|
| Skill **definition** (SKILL.md + files) | the folder on disk (provider ⇄ vault, §3) | derived index + sync state (§4) |
| Skill **usage history** | **Nexus-generated as you work** | owned data → trace/state attribution (below) |

### Mechanism — reuse the workspace-activity machinery

`loadWorkspace`'s `recentFiles` / `states` / `sessions` are built by `WorkspaceDataFetcher`
querying tool-call traces + saved states filtered on `workspaceId`. Skill history is the
**same query filtered on `skillId`** — so the build is additive, not parallel:

1. **Active-skill attribution context.** `SessionContextManager` gains `activeSkills: string[]`
   per session, set by `loadSkill` (cleared on unload / session end). *Attribution only — it
   does NOT scope or route tools, unlike `workspaceId`.*
2. **Stamp activity with active skill(s).** When tool-call traces (`ToolCallTraceService`) and
   saved states are recorded, stamp them with `activeSkills` alongside the existing
   `workspaceId`. Many-to-many: one action while 2 skills are active attributes to both.
3. **Fetch on load.** `loadSkill` runs the workspace-activity fetch filtered by `skillId`,
   **grouped by workspace**, and returns it as a "recent activity with this skill" section —
   mirroring `loadWorkspace`'s `recentActivity` block.

### What counts as "activity"

Log writes/edits, saved states, and explicit file touches while a skill is active — **not**
every read (avoid logging noise). Recency-paginated like workspace activity.

## 10. Phasing

0. **App scaffold (§6)** — `SkillsAgent` (BaseAppAgent, ComposerAgent-shaped) + register in
   `AppManager.getBuiltInAppRegistry`; installable from Settings → Apps. Follow `docs/BUILDING_APPS.md`.
1. **Discovery** — `SkillScanner` over `<root>/skills/`, index (§4) + v13 migration, `listSkills`,
   Obsidian-event refresh on the mirror. *Delivers core value on its own.*
2. **Load** — `loadSkill` returns SKILL.md + folder listing + nudge (no usage history yet).
3. **Edit + validate (§7)** — `SkillValidator` + `createSkill`/`updateSkill`/`archiveSkill`
   CRUA tools + the app's Skills-management settings section (create/edit/archive/delete).
4. **Import** — vault-root `.{provider}/skills/` → `Nexus/skills/<provider>/` via `vault.adapter`;
   provider-namespaced mirror; per-skill enable/disable (mirror custom-prompt `isEnabled`).
5. **Sync-back (§3)** — Nexus → provider dotfolder, archive-then-replace (last-writer-wins). Depends on 4.
6. **Usage history (§9)** — `activeSkills` session tracker + skill-attribution stamp on
   traces/states + skill-filtered activity fetch folded into `loadSkill`. *Highest-value but
   highest-effort; depends on 1–2.*
7. **(Later, optional)** — in-app chat: persist active skills + inject a `<loaded_skills>`
   system-prompt section (only if we ever want skills to survive context compaction without re-load).

## 11. Open questions

1. Exact destination path: `Nexus/skills/` vs `Nexus/data/skills/` — impl detail; pick whatever
   the storage resolver makes cleanest, but it must be a **syncing** location (not `.nexus/`).
2. `_archive` retention (§3/§7): keep N versions per skill? time-prune? (Location is settled:
   co-located `<skill>/_archive/<timestamp>/`, scanner ignores `_`.) Also: do vault-native
   (`nexus`) skills ever get *exported* to a provider, and which?
3. ~~Provider discovery scope~~ **[RESOLVED]** vault-root `.{provider}/skills/` via `vault.adapter`,
   **vault-local only** — global OS-home `~/.<provider>` is out of scope; project roots deferred (§3).
4. ~~Cross-provider duplicates~~ **[RESOLVED]** never merge. `listSkills` **orders by recency**
   (`last_loaded_at`, most-recent first) and labels each `provider/name` with its last-used time,
   so the preferred version is *visible*; `loadSkill` disambiguates from that ranking via
   `--source` (returns the ordered matches if a bare name is ambiguous — no silent guess) (§3/§12).
5. Index store: SQLite `skills` table (as speced) vs. a lighter in-memory cache rebuilt on
   vault events — SQLite is the original ask, but for a "read back a prompt" feature with a
   handful of folders, in-memory may be enough and skips the v13 migration.
6. ~~Usage-history attribution mechanics (§9)~~ **[RESOLVED — cheap, mostly migration-free]**
   `memory_traces` already has an extensible `metadataJson` column and `TraceMetadata` carries an
   index signature (`[key: string]: unknown`, `src/database/types/memory/MemoryTypes.ts:142`), so
   stamping `activeSkills: string[]` onto traces is a **zero-schema-change** write. Querying =
   one new `TraceRepository.getTracesBySkill()` (mirror `getByType`, `metadataJson LIKE`). States
   have a similar `tagsJson` extensible field — stamp via `SaveStateData` with no migration. So
   §9 reuses the trace/state machinery cleanly; **no dedicated event log needed.** (See §13.)
7. Active-skill lifetime: cleared on session end only, or is there an explicit `unloadSkill`?
   (`SessionContextManager` eviction at `:101` already clears per-session maps — add the skills
   field to that path.)

## 12. Tool schemas & example returns

All tools also accept the common context (`workspaceId`, `sessionId`, `memory`, `goal`,
`constraints`) merged in by `getMergedSchema`; only tool-specific params are shown. CLI form
is `skill <tool> --flag value` (the `Skills` app's agent; alias derives from its manifest `agentName`).

> **Provider is `open string`, not an enum** — it's whatever the vault-root `.*/skills/` scan
> found (§3). Because the key is `(provider, name)`, the name-targeting tools (`loadSkill`,
> `updateSkill`, `archiveSkill`) take an **optional `--source`**.
>
> **Recency is a *listing-order* signal (§11.4), not auto-resolution.** `listSkills` sorts by
> `last_loaded_at` (most-recent first) and shows each as `provider/name` with its last-used
> time — so when `codex/essay-editor` (used yesterday) ranks above `claude/essay-editor` (a
> month ago), the right choice is *visible* and the agent passes that `--source`. On a bare
> ambiguous `--name`, `loadSkill` returns the recency-ordered matches asking which `--source` —
> it never silently guesses, and duplicates are never merged.

### `listSkills` — `skill list [--search q] [--source claude] [--include-archived]`

```ts
// params
{ search?: string; source?: string /* provider id */; includeArchived?: boolean /* default false */ }
```
```jsonc
// returns — ordered by last_loaded_at (most-recent first), so the preferred version is on top
{
  "success": true,
  "count": 2,
  "skills": [
    { "name": "essay-editor", "provider": "codex",  "description": "Codex's essay-editing skill.",
      "lastLoadedAt": 1716800000000, "isArchived": false },   // used yesterday → ranked first
    { "name": "essay-editor", "provider": "claude", "description": "Edit essays for clarity, flow, and concision.",
      "lastLoadedAt": 1714200000000, "isArchived": false }    // used a month ago → below
  ]
}
```

### `loadSkill` — `skill load --name essay-editor [--source claude]`

```ts
// params
{ name: string; source?: string /* provider — required only if name is ambiguous */; includeHistory?: boolean /* default true */ }
```
```jsonc
// returns  (the loadWorkspace-shaped payload)
{
  "success": true,
  "skill": {
    "name": "essay-editor",
    "provider": "claude",
    "description": "Edit essays for clarity, flow, and concision.",
    "instructions": "## Essay Editor\nWhen editing an essay, first read it fully, then…",  // full SKILL.md body
    "files": [
      { "path": "Nexus/skills/claude/essay-editor/SKILL.md", "type": "skill" },
      { "path": "Nexus/skills/claude/essay-editor/references/style-guide.md", "type": "resource" },
      { "path": "Nexus/skills/claude/essay-editor/templates/outline.md", "type": "resource" }
    ]
  },
  "nudge": "Use your normal `content read` tool to open any of the files listed above.",
  "usageHistory": {                       // §9 — omitted if includeHistory:false
    "lastUsedAt": 1716800000000,
    "totalUsages": 7,
    "byWorkspace": [
      {
        "workspaceId": "ws-blog", "workspaceName": "Blog",
        "recentFiles":   [{ "path": "essays/essay-draft-3.md", "action": "replace", "at": 1716700000000 }],
        "states":        [{ "name": "midway-edit", "savedAt": 1716700500000 }],
        "recentActions": [{ "tool": "content replace", "summary": "tightened the intro", "at": 1716700000000 }]
      }
    ]
  }
}
```

### `createSkill` — `skill create --name essay-editor --description "…" --body "…"`

```ts
// params  (validated by SkillValidator, §7)
{ name: string; description: string; body: string; source?: string /* provider; default 'nexus' (vault-native) */ }
```
```jsonc
// returns (success)
{ "success": true,
  "skill": { "name": "essay-editor", "provider": "nexus", "description": "…",
             "vaultPath": "Nexus/skills/nexus/essay-editor" },
  "created": "Nexus/skills/nexus/essay-editor/SKILL.md" }
```
```jsonc
// returns (validation failure — no file written)
{ "success": false, "error": "Skill validation failed",
  "validationErrors": [
    "name must be lowercase-hyphenated (got 'Essay Editor')",
    "description is required and must be non-empty"
  ] }
```

### `updateSkill` — `skill update --name essay-editor [--source claude] [--description "…"] [--body "…"] [--rename new-name]`

```ts
// params  (all but name optional; --source disambiguates; validated)
{ name: string; source?: string; description?: string; body?: string; rename?: string }
```
```jsonc
// returns — archives prior version into the skill's own _archive (§3), syncs back if provider-originated
{ "success": true,
  "skill": { "name": "essay-editor", "provider": "claude", "vaultPath": "<root>/skills/claude/essay-editor", "description": "…" },
  "archivedVersion": "<root>/skills/claude/essay-editor/_archive/2026-05-31T12-00-00Z/",
  "syncedBackTo": "<vault>/.claude/skills/essay-editor"   // present only when origin_path is set
}
```

### `archiveSkill` — `skill archive --name essay-editor [--source claude] [--restore]`

```ts
// params  (model's only "delete" — soft/reversible; hard delete is UI-only)
{ name: string; source?: string; restore?: boolean /* default false */ }
```
```jsonc
// returns
{ "success": true, "name": "essay-editor", "provider": "claude", "isArchived": true }
```

### `syncSkills` — `skill sync [--direction both] [--source claude]`

```ts
// params  (omit --source to sync every discovered provider)
{ direction?: 'import'|'sync-back'|'both' /* default 'both' */; source?: string /* provider id */ }
```
```jsonc
// returns — providers auto-discovered from the vault-root .*/skills scan (cross-platform, vault.adapter)
{ "success": true,
  "providers":  ["claude", "codex", "cursor"],
  "imported":   ["codex/pr-reviewer"],
  "syncedBack": ["claude/essay-editor"],
  "skipped":    ["claude/data-analyst (unchanged)"],
  "archived":   ["<root>/skills/claude/essay-editor/_archive/2026-05-31T12-00-00Z/"] }
```
```jsonc
// returns — no provider dotfolders present in this vault (e.g. none synced to this device yet)
{ "success": true, "providers": [], "imported": [], "syncedBack": [], "skipped": [],
  "note": "No .{provider}/skills folders found at the vault root." }
```

## 13. Implementation reuse map (DRY)

Investigated 2026-05-31. Almost nothing here is greenfield — the build adapts existing
infrastructure. Concrete targets:

| Need | Reuse | Location | Verdict |
|---|---|---|---|
| Skill index store | `CustomPromptStorageService` | `src/agents/promptManager/services/CustomPromptStorageService.ts` | **Mirror structure**, but **drop the `data.json` fallback** — prompts need it (no other source of truth); skills' source of truth is the **folder on disk**, so the SQLite index is always rebuildable by re-scan. Simpler than the template. |
| `skills` table + v13 migration | `SchemaMigrator` (currently v12) | `src/database/schema/SchemaMigrator.ts:76` + `schema.ts` | **Drop-in** — add migration object, bump `CURRENT_SCHEMA_VERSION` → 13 |
| Resolve `<root>` (never hardcode `Nexus`) | `resolveVaultRoot(settings)` | `src/database/storage/VaultRootResolver.ts:133` | **Verbatim** — `resolution.dataPath + '/skills'` |
| Parse SKILL.md frontmatter | `yaml` (^2.8.1, dynamic import) + `metadataCache` | `ContentManager.write`; `VaultFileIndex.ts:141` | **As-is** — dyn-import `yaml` for dot sources, metadataCache for mirror |
| Read/list/write dotfolders | `vault.adapter.exists/read/list/stat/mkdir/write` | pattern in `SQLiteCacheManager.ts:185` | **As-is** — the sanctioned `.nexus/` exception |
| Archive-then-replace (copy before overwrite) | `FileOperations.ensureFolder` + `duplicateNote` | `src/agents/storageManager/utils/FileOperations.ts:85,260` | **Reuse** — point at co-located `_archive/<ts>/` |
| App framework (install/enable/uninstall, settings UI, vault wiring) | `BaseAppAgent` + `AppManager` + `AppsTab` + `AppConfigModal` | `src/agents/apps/BaseAppAgent.ts`, `src/services/apps/AppManager.ts:223`, `src/settings/tabs/AppsTab.ts` | **The home** — `Skills` is an app (§6); register one line in `getBuiltInAppRegistry` |
| App builder process + reference | docs | `docs/BUILDING_APPS.md`, `docs/architecture/apps-architecture.md` | **Follow** — canonical "how to add an app" |
| Closest app exemplar (cross-platform, no creds) | `ComposerAgent` | `src/agents/apps/composer/ComposerAgent.ts` | **Template** for `SkillsAgent` skeleton |
| Skills mgmt UI (list / edit / archive / delete) | `StatesSectionRenderer` (#215/#216) embedded in the app's config modal/settings section | `src/components/workspace/StatesSectionRenderer.ts`; app settings via `AppsTab.buildSettingsSections` | **Copy & rename** → `SkillsSectionRenderer`; host inside the app's settings (not a new top-level tab) |
| Section box + confirm dialogs | `BoxedSection`, `ConfirmModal` (`.confirm()`, `archive`/`delete` variants) | `src/settings/components/` | **Direct** — no changes |
| Per-session `activeSkills` (attribution, §9) | extend `WorkspaceContext` | `src/services/SessionContextManager.ts:10,101` | **Extend interface** — add `activeSkills?: string[]`, clear in eviction |
| `loadSkill` folder listing | `WorkspaceFileCollector.buildWorkspacePath(folder, app, recursive)` | `src/agents/memoryManager/services/WorkspaceFileCollector.ts:73` | **As-is** — folder-agnostic, zero changes |
| `loadSkill` return shape | `loadWorkspace` assembly | `src/agents/memoryManager/tools/workspaces/loadWorkspace.ts:225` | **Adapt** — slimmer (no workflows/sessions/states) |
| Usage-history stamp (§9) | `memory_traces.metadataJson` (`+ activeSkills`) + new `getTracesBySkill` | `TraceRepository.ts:143,270`; states via `tagsJson`/`SaveStateData` | **Zero-migration** for traces; cheap for states |

**Net:** the only genuinely new code is the `Skills` **app** (`SkillsAgent` + tools, one
registry line), `SkillScanner`, `SkillStorageService` (mirrored, no `data.json`), `SkillValidator`,
the `SkillSyncService`, and the v13 migration. Everything else is adaptation.

> One mismatch to note: the existing `archive.ts` tool archives to a vault-root `.archive/`,
> but skills want a **co-located** `<skill>/_archive/<ts>/`. Reuse the `FileOperations`
> primitives (`ensureFolder`/`duplicateNote`), not the `archive` *tool's* path convention.
