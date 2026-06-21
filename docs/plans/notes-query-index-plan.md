# Notes Query Index — Implementation Plan

**Status:** Committed design
**Author:** research + plan, 2026-06-21 (rev. 2)
**Branch:** `claude/practical-shannon-xbylz1`

## 1. Goal

Let the agent **return and compute data from a database** of vault notes: "get all notes
with these frontmatter properties, filter by this, calculate that." Concretely, expose the
vault's notes + frontmatter as **indexed SQL rows** the agent can query directly, so it can
filter and aggregate without Nexus reimplementing a query language.

This is the structured/metadata query axis, complementing `searchContent` (semantic/keyword
over body text) and `searchDirectory` (path/name).

## 2. Core decisions (the short version)

1. **Index notes + frontmatter only — never body content.** Content stays on disk, read on
   demand via `ContentManager`. Tiny rows → far higher scale ceiling.
2. **EAV schema** (`notes` + `note_properties`) so *arbitrary* frontmatter keys are **indexed**.
   This is the only model that gives O(log n) lookup for any property (generated columns need
   keys known up front; a JSON column can't be indexed for arbitrary keys → full scan).
3. **Agent writes SQL; SQLite computes.** No filter→SQL compiler, no formula evaluator. The
   consumer is an LLM fluent in SQL, and SQLite already does `CASE`/arithmetic/aggregates/
   `date()`. Dropping these two components removes the entire maintenance sink (no tracking of
   Bases' evolving function set).
4. **In-memory, rebuilt at startup, kept fresh via `metadataCache` events — not persisted in
   the cache blob.** The index is 100% derived from the vault (like the existing
   `VaultFileIndex`), so persistence is optional. Skipping it sidesteps the one thing that
   actually breaks at scale (whole-DB blob serialization on save).
5. **Right-sized to ~100–200k notes** comfortably, graceful degrade beyond. Real 1M is a
   separate storage-engine project, explicitly out of scope.

## 3. Why not Obsidian's Bases API

- **No headless execution.** The official Bases plugin API (`obsidian.d.ts`) only lets a plugin
  register a *view* (`BasesViewFactory = (controller, containerEl) => BasesView`); the framework
  runs the query and pushes results into `view.data`. `QueryController` is not plugin-instantiable.
  There is no "run this `.base` and hand me rows." (Forum request open, not shipped.)
- **The SQLite cache doesn't contain notes.** Its ~20 tables are Nexus's own event store; the
  notes/frontmatter dataset lives only in Obsidian's in-memory `metadataCache`.

Bases is kept as an optional *interop* surface (§9), not the query backend.

## 4. Scale analysis (why the limits are where they are)

Per note: one `notes` row (~300–500 B incl. `frontmatter_json`) + ~6 EAV rows (~150 B each).
With indexes, ~2.5–3.5 KB/note all-in.

| Notes | ~DB size | Status |
|---|---|---|
| 50k | ~150 MB | comfortable |
| 100k | ~300 MB | **comfortable ceiling** |
| 300k | ~1 GB | risky |
| 1M | ~3 GB | different architecture |

What breaks, in order:

1. **Query — not the limit.** EAV indexed on `(key, value_text)`/`(key, value_num)` → filters
   are index seeks, single-digit-ms even at 500k+ rows.
2. **In-memory size (~100–200k).** sql.js holds the whole DB in WASM linear memory (≈4 GB hard
   cap, unhappy well before). → comfortable to ~100–200k.
3. **Blob save (~300–500k) — the hard wall, which we avoid.** Persisting sql.js rewrites the
   *entire* DB blob to IndexedDB on every save. **Decision #4 removes this** by not persisting
   the notes tables — they rebuild in memory at startup.

Obsidian itself (metadataCache/explorer/graph) strains well before 1M, so ~100–200k covers
essentially every real vault, power users included.

## 5. Schema (in-memory tables; not in the persisted blob)

```sql
-- one row per note. integer id keeps the EAV table small (no repeated TEXT path).
CREATE TABLE IF NOT EXISTS notes (
  id          INTEGER PRIMARY KEY,    -- surrogate; FK target for note_properties
  path        TEXT NOT NULL UNIQUE,   -- vault-relative, normalized
  basename    TEXT NOT NULL,
  folder      TEXT NOT NULL,
  ext         TEXT NOT NULL,
  title       TEXT,                   -- frontmatter title || basename
  ctime       INTEGER NOT NULL,       -- epoch ms
  mtime       INTEGER NOT NULL,
  size        INTEGER NOT NULL,
  tags_json   TEXT,                   -- JSON array (frontmatter + inline tags)
  links_json  TEXT,                   -- JSON array of outgoing link targets
  frontmatter_json TEXT,              -- whole frontmatter as JSON (for projection via json_extract)
  content_hash TEXT NOT NULL          -- hash(frontmatter + stat) → change-gate re-index
);
CREATE INDEX IF NOT EXISTS idx_notes_folder ON notes(folder);
CREATE INDEX IF NOT EXISTS idx_notes_mtime  ON notes(mtime);

-- one row per frontmatter property (per list element for arrays). THE indexed filter path.
CREATE TABLE IF NOT EXISTS note_properties (
  note_id     INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  key         TEXT NOT NULL,          -- lowercased for matching
  key_raw     TEXT NOT NULL,          -- original case
  value_text  TEXT,                   -- normalized string form (=, contains, sort)
  value_num   REAL,                   -- numeric or date-coerced (epoch ms)
  value_type  TEXT NOT NULL,          -- 'string'|'number'|'boolean'|'date'|'list'|'object'|'null'
  position    INTEGER                 -- list element index, else NULL
);
CREATE INDEX IF NOT EXISTS idx_np_key_text ON note_properties(key, value_text);
CREATE INDEX IF NOT EXISTS idx_np_key_num  ON note_properties(key, value_num);
CREATE INDEX IF NOT EXISTS idx_np_note     ON note_properties(note_id);
```

- **Division of labour:** filter via **EAV** (indexed, any key); project/return via
  **`frontmatter_json`** + `json_extract` on the already-filtered small set; compute via SQL.
- **Typing pass (load-bearing):** YAML frontmatter is untyped — on upsert, coerce each value
  (number; ISO-8601 date → epoch ms in `value_num`; boolean; list → one row per element; object),
  always storing a `value_text`. This is what makes `due < <epoch>` and numeric comparisons work.
- **No schema migration / `CURRENT_SCHEMA_VERSION` bump:** these tables are created in the
  in-memory DB at startup, not part of the persisted v-schema. (`CREATE TABLE IF NOT EXISTS`.)

## 6. `NotesIndexService` — build, freshness, lifecycle

Modeled on the live `VaultFileIndex` (freshness) + `SkillIndexService`/`SkillSyncWatcher`
(upsert/prune/debounce). Owns the two tables in the existing in-memory sql.js instance.

- **Startup build (background, non-blocking):** after cache ready, create the tables, walk
  `vault.getMarkdownFiles()`, read `metadataCache.getFileCache()` (frontmatter + tags + links),
  typed-upsert `notes` + `note_properties`. Batched so it never stalls boot. A few seconds at
  100k is acceptable.
- **Freshness:** subscribe to `metadataCache.on('changed')` + vault `rename`/`delete`
  (the `VaultFileIndex.setupMetadataCacheEvents` pattern), debounced + coalesced
  (`SkillSyncWatcher` shape). On change → re-upsert that note; on delete/rename → cascade.
- **Not persisted:** the notes tables are excluded from the cache blob save; they rebuild from
  the vault each launch. (If cold-rebuild time ever bites on huge vaults, persist them in a
  *separate* sql.js blob on an idle debounce — deferred, not built now.)
- **Graceful degrade:** above a configurable cap (default ~250k notes) skip the persistent index
  build and warn; queries can fall back to bounded on-demand scans. Never crash.
- **Mobile:** `getMarkdownFiles()`, `metadataCache`, sql.js all run on mobile; no Node built-ins,
  no top-level npm imports. Lower comfortable cap on mobile (~25–50k) via the same setting.

## 7. Tool: `queryNotes` (SearchManager) — read-only SQL

`BaseTool`, constructor-injected `Plugin` + a `NotesIndexService` resolver; registered via
`registerLazyTool`. The agent passes SQL; the tool runs it read-only and returns rows.

```jsonc
// execute params
{ "sql": "SELECT n.path, json_extract(n.frontmatter_json,'$.status') AS status FROM notes n WHERE EXISTS (SELECT 1 FROM note_properties p WHERE p.note_id=n.id AND p.key='status' AND p.value_text='active') ORDER BY n.mtime DESC LIMIT 50",
  "params": [] }
// result
{ "success": true, "columns": [...], "rows": [...], "rowCount": N }
```

- **Read-only guard (in the service, never the schema — per the no-runtime-schema-validation
  rule):** reject anything that isn't a single `SELECT`/`WITH` statement; block
  `INSERT/UPDATE/DELETE/DROP/ALTER/CREATE/ATTACH/PRAGMA` and multiple statements. The notes
  tables live in the shared cache DB, so this guard protects the *whole* cache. (Upside of the
  shared instance: the agent can JOIN notes against `tasks`/`conversations`/`embedding_metadata`.)
  The index is rebuildable anyway, so worst case is recoverable — but guard regardless.
- **Agent ergonomics:** the tool description carries the schema (column list + "filter via
  `note_properties`, project via `json_extract(frontmatter_json,'$.key')`, dates are epoch ms in
  `value_num`") and 2–3 example queries. Optionally a `describe` mode returns the live schema +
  the set of distinct `key`s present. LLMs drive SQLite reliably; SQL errors self-correct on retry.
- **Compute is free:** `CASE`/arithmetic for `if`-style derivations, `SUM/AVG/MIN/MAX/COUNT … GROUP BY`
  for rollups, `julianday()`/`date()` for date math — all native SQLite, nothing for us to maintain.

## 7.1 Tool surface & placement (call shape + home)

Grounded in the live CLI-first contract (`ToolCliNormalizer.buildCliSchema:745`,
`normalizeExecutionCalls:732`; example invocation `tests/eval/fixtures/mock-responses.ts:141`).

**Call shape — CLI-first.** The agent calls `useTools` with a top-level `tool` **string that is
a CLI command**, context fields alongside it (not a JSON args object):

```jsonc
useTools({
  tool: "search query-notes --sql \"SELECT n.path, json_extract(n.frontmatter_json,'$.status') AS status FROM notes n WHERE EXISTS (SELECT 1 FROM note_properties p WHERE p.note_id=n.id AND p.key='status' AND p.value_text='active') ORDER BY n.mtime DESC LIMIT 50\"",
  workspaceId: "...", sessionId: "...", memory: "...", goal: "..."   // context stays top-level
})
```

- **Base command** = `<agent-alias> <tool-slug-kebab>`. SearchManager's alias is `search`
  (cf. `contentManager` → `content`), so `queryNotes` → **`search query-notes`**.
- **`--sql` is a flag, not positional.** `buildCliSchema:755` makes a `required` string param
  *positional*; a SQL blob full of quotes is awkward positionally, so `sql` is declared
  **not-required** in the schema and presence is enforced in the service. This matches the house
  rule (schema `required` is not runtime-validated — guards live in the service/normalizer).
- **Internal id** (appears in results) = `searchManager_queryNotes` (cf. `contentManager_read`).
- **Result** stays in the `{ success, … }` convention: `{ success, columns, rows, rowCount }`.
  Per-tool `getResultSchema()` means this tool's arbitrary-column shape doesn't conflict with the
  file/snippet shapes of its SearchManager siblings.

**Home — SearchManager (tool) + core service (index).**

- **Tool on SearchManager.** It is the retrieval/query agent (`searchContent` semantic,
  `searchDirectory` path/name, `searchMemory` SQLite-backed). `queryNotes` is the 4th modality —
  structured frontmatter query — and matches the agent's discovery mental model. `searchMemory`
  already establishes the "SearchManager tool runs SQL via an injected resolver" precedent.
- **Not StorageManager** — that agent is filesystem *mutation* (list/move/copy/archive); a
  read-only query is a poor fit.
- **Not its own agent yet** — a dedicated `DatabaseManager` costs `AgentInitializationService` +
  `AgentRegistrationService` wiring for a single tool. Justified only once a *family* emerges
  (`queryNotes` + `describe` + `baseSet` + cross-table `runSql`); promotion is cheap because the
  service is independent.
- **`NotesIndexService` is a core service, not inside the agent.** It has a real lifecycle
  (startup build, `metadataCache` subscriptions, degrade cap), so it registers in
  `ServiceDefinitions.ts` like `cacheManager`, and the tool receives it via a lazy resolver —
  the same pattern `SearchMemoryTool` uses for its storage adapter (`searchManager.ts:154`
  `registerLazyTool`). Keeps the agent a thin tool host.

## 8. What we deliberately do NOT build

- ❌ Filter→SQL compiler (agent writes the `WHERE`).
- ❌ Formula/expression evaluator + Bases function table (SQLite + agent SQL replace it).
- ❌ Schema migration / blob persistence for the index (in-memory rebuild instead).
- ❌ Body-content indexing (`searchContent` owns that; content read on demand).

## 9. Optional companion: `.base` round-trip (`baseSet`)

Independent, cheap, zero Bases-API dependency — a `.base` is just a YAML file
(`vault.create`/`modify`/archive). Lets the agent author a persistent, **user-visible** database
view the human opens in Obsidian's native Bases UI. Slot in any time. (Document that our SQL
evaluation may diverge from Bases-rendered output.) Not required for the core goal.

## 10. Phasing

- **Phase 0 — DONE:** `NotesIndexService` (in-memory tables via `ensureSchema`, typed walk +
  upsert + prune, `metadataCache` freshness, degrade cap) + pure `notesIndexMapping`. Unit-tested.
- **Phase 1 — DONE:** `QueryNotesTool` on SearchManager (`search query-notes --sql …`) —
  read-only SQL + guard + `describe`; `notesIndex` core service (BACKGROUND stage) runs the
  builder at boot. **The usable MVP.** ⚠️ Unit-tested + builds, but NOT yet manually verified in
  a live Obsidian session (startup → background walk → round-trip).
- **Phase 2 — PARTIAL:** done — `describe` mode, transaction-wrapped per-note upsert,
  mobile-aware degrade cap (50k mobile / 250k desktop), string/comment-stripping SQL guard.
  Remaining — example-query library / convenience views, optional separate-blob persistence if
  cold-rebuild proves slow, `fullRebuild` hook (the index already rebuilds at every startup).
- **Phase 3 (optional) — `.base` interop:** `baseSet` CRUA + a `baseFile` path that loads a
  `.base` filter and runs the equivalent SQL.

## 11. Risks & open questions

- **Typing/coercion fidelity** drives all comparison correctness (ISO date → epoch). Needs a
  tested coercion module — the main correctness surface now that there's no evaluator.
- **Cold-rebuild time** at the top of the range (100–200k): must be background + hash-gated;
  measure, and only add separate-blob persistence if it actually bites.
- **Agent SQL quality:** EAV `EXISTS` filters are slightly verbose; mitigate with schema docs,
  examples, and optional views. SQL errors self-correct — a better failure mode than a DSL
  silently returning wrong numbers.
- **Shared-DB blast radius:** read-only guard must be airtight since the notes tables share the
  cache instance. (Alternative: isolate in a separate sql.js instance — costs the cross-table
  JOIN upside; default to shared + strict guard.)
- **List/object properties:** lists → one EAV row per element (enables `contains`); deeply nested
  objects stay in `frontmatter_json` only (queried via `json_extract`).

## 12. Testing

- Unit: typing/coercion module; upsert/prune/freshness on a fixture vault; read-only SQL guard
  (accept SELECT/WITH, reject writes/PRAGMA/ATTACH/multi-statement).
- Integration: cold build → query; `metadataCache` change → re-query reflects update;
  rename/delete cascade; graceful-degrade cap; mobile (`vault.adapter`) smoke.
- Eval: a few `queryNotes` cases in the LLM eval harness once Phase 1 lands.

## Sources (research)

- Bases dev API surface — `obsidianmd/obsidian-api` (`obsidian.d.ts`); forum "Provide API access
  to the results of Bases view" (open).
- `.base` format/functions — kepano/obsidian-skills `obsidian-bases` SKILL + FUNCTIONS_REFERENCE
  (Obsidian's official agent reference); Obsidian Help.
- Codebase — `VaultFileIndex.ts` (live freshness precedent, `CacheManager`/`ServiceDefinitions.ts:149`),
  `SkillScanner`/`SkillIndexService`/`SkillSyncWatcher` (walk→upsert→prune→debounce),
  `IStorageBackend.ts:88` (`query`/`queryOne`/`run`), `SyncCoordinator.fullRebuild`,
  `src/agents/searchManager/` tool patterns, `ToolCliNormalizer`.
