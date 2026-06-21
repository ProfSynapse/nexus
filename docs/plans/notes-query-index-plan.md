# Notes Query Index — Implementation Plan

**Status:** Proposed
**Author:** research + plan, 2026-06-21
**Branch:** `claude/practical-shannon-xbylz1`

## 1. Goal

Give Nexus (and the AI surface) a **database-style query over vault notes**: "get all
notes with these frontmatter properties, filter by this, calculate that." Concretely:

```
SELECT <props/computed> FROM notes WHERE <filter on file.* + frontmatter> ORDER BY … LIMIT …
```

This is the structured/metadata query axis that complements the existing `searchContent`
(semantic/keyword over body text) and `searchDirectory` (path/name) tools.

## 2. Why not just use Obsidian's Bases API

Researched and ruled out as the *query backend* (kept as an optional interop surface):

- **No headless execution.** The official Bases plugin API (`obsidian.d.ts`) only lets a
  plugin **register a custom view** (`BasesViewFactory = (controller, containerEl) => BasesView`);
  the framework runs the query and pushes results into `view.data`. `QueryController` is not
  plugin-instantiable. There is **no** "run this `.base` and hand me rows" call. The
  "API access to Bases results" forum request is open, not shipped.
- **IndexedDB is not queryable.** It only persists the serialized sql.js blob; queries run
  against in-memory WASM SQLite hydrated from it.
- **The SQLite cache doesn't contain notes.** Its ~20 tables (`workspaces`, `sessions`,
  `memory_traces`, `conversations`, `tasks`, `embedding_metadata`, `skills`, …) are Nexus's
  own event store. **There is no `notes`/frontmatter table** — the dataset Bases queries over
  lives in Obsidian's in-memory `metadataCache`, not in our DB.

**Conclusion:** the SQL engine and the freshness plumbing already exist; the missing piece is
a *notes + frontmatter index* as SQL rows. Build that, and a query tool is a thin layer on top —
fully headless, cross-platform (works on mobile, unlike reaching into Bases internals), and able
to JOIN against `embedding_metadata` (semantic axis Bases can't touch).

## 3. What already exists (reuse, don't rebuild)

| Capability | Where | Reuse |
|---|---|---|
| Vault walk + frontmatter/tags/links read + **live freshness** via `metadataCache.on('changed'|'resolved')` + rename/delete handlers | `src/database/services/cache/VaultFileIndex.ts` (live service, owned by `CacheManager`, registered `cacheManager` in `ServiceDefinitions.ts:149`) | **Freshness pattern** (`setupMetadataCacheEvents`, `handleMetadataChanged`). It is in-memory Maps + lazy frontmatter, so not the storage layer — but it's the proven precedent. |
| "Walk vault → upsert into SQLite → prune missing, preserving owned columns" | `src/agents/apps/skills/services/SkillScanner.ts` + `SkillIndexService.ts` (`syncFromScan` UPSERT + scoped prune) | **Template** for `NotesIndexService`. |
| Debounced + coalesced vault watcher | `src/agents/apps/skills/services/SkillSyncWatcher.ts` (2000ms debounce, run-coalescing) | **Template** for the freshness loop. |
| Schema migration | `SchemaMigrator.ts:76` (`CURRENT_SCHEMA_VERSION = 13`), `Migration { version, description, sql[], migrationFn? }`, idempotent `CREATE TABLE IF NOT EXISTS`; mirror into `schema.ts` SCHEMA_SQL for fresh installs | Add v14. |
| Backend query API | `IStorageBackend.ts:88` `query<T>(sql, params?)`, `queryOne<T>`, `run`, `transaction`; positional `?` params | Query compiler target. Reach it the way repositories do (`BaseRepository` → `sqliteCache.query`). |
| Full rebuild | `SyncCoordinator.fullRebuild()` clears + replays JSONL | Add a **vault-reindex step** (notes index is derived from the vault, not JSONL, so rebuild must re-walk). |
| Tool patterns | `src/agents/searchManager/` — `BaseTool`, constructor `Plugin` injection (`this.plugin.app.metadataCache`), lazy service resolvers, `registerLazyTool`; array/object params handled by `ToolCliNormalizer` (CSV/JSON coercion) | Home + shape for `queryNotes`. |

> Pinned gotcha (CLAUDE.md): tool-schema `required`/`enum` is **not** runtime-validated.
> All field/shape guards must live in the service/normalizer layer, never the schema.

## 4. Architecture decision

**Chosen: SQL-backed index (`notes` + `note_properties`) + a JS formula evaluator.**

Split that mirrors how Bases itself works (filters can reference formulas):

- **SQL does the coarse work** — `WHERE` over file.* columns and frontmatter props
  (existence, equality, comparison, contains), `ORDER BY`, `LIMIT`, grouping. Scales to
  large vaults; this is the "get notes with these properties + filter" half.
- **A small JS expression evaluator does formulas** — `if()`, date math, `number()`,
  string/list methods — over the fetched rows. Bases formulas use method-dispatch
  (`value.method(...)`) that doesn't translate cleanly to SQLite; this is the "calculate that" half.

Rejected alternative — *extend VaultFileIndex in-memory* (eager-load all frontmatter + JS
predicate filter): smaller, no migration, but no real aggregation, recomputed per query, no
embeddings JOIN, weaker at scale. Keep as the fallback if Phase 0 proves the SQL index too heavy.

## 5. Schema (v13 → v14)

EAV model so arbitrary frontmatter keys are queryable without per-property columns.

```sql
-- one row per note
CREATE TABLE IF NOT EXISTS notes (
  path        TEXT PRIMARY KEY,      -- vault-relative, normalized
  basename    TEXT NOT NULL,
  folder      TEXT NOT NULL,
  ext         TEXT NOT NULL,
  title       TEXT,                  -- frontmatter title || basename
  ctime       INTEGER NOT NULL,      -- file.stat.ctime (epoch ms)
  mtime       INTEGER NOT NULL,      -- file.stat.mtime
  size        INTEGER NOT NULL,
  tags_json   TEXT,                  -- JSON array (merged frontmatter + inline tags)
  links_json  TEXT,                  -- JSON array of outgoing link targets
  content_hash TEXT NOT NULL,        -- hash(frontmatter + stat) — change-gate reindex
  indexed_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notes_folder ON notes(folder);
CREATE INDEX IF NOT EXISTS idx_notes_mtime  ON notes(mtime);

-- one row per frontmatter property (per list element for arrays)
CREATE TABLE IF NOT EXISTS note_properties (
  note_path   TEXT NOT NULL REFERENCES notes(path) ON DELETE CASCADE,
  key         TEXT NOT NULL,         -- frontmatter key (lowercased for match; original in key_raw)
  key_raw     TEXT NOT NULL,
  value_text  TEXT,                  -- normalized string form (for =, contains, sort)
  value_num   REAL,                  -- populated when numeric or date-coercible (epoch ms)
  value_type  TEXT NOT NULL,         -- 'string'|'number'|'boolean'|'date'|'list'|'object'|'null'
  position    INTEGER                -- list element index, else NULL
);
CREATE INDEX IF NOT EXISTS idx_np_key_text ON note_properties(key, value_text);
CREATE INDEX IF NOT EXISTS idx_np_key_num  ON note_properties(key, value_num);
CREATE INDEX IF NOT EXISTS idx_np_path     ON note_properties(note_path);
```

Add to both `SchemaMigrator.MIGRATIONS` (v14) and `schema.ts` SCHEMA_SQL; bump
`CURRENT_SCHEMA_VERSION` to 14. Pure `CREATE TABLE/INDEX IF NOT EXISTS` (no data migration —
the index is rebuilt from the vault on first run).

**Typing pass** (the load-bearing detail): YAML frontmatter is untyped. On upsert, coerce each
value → detect number, ISO-8601 date (→ epoch ms in `value_num`), boolean, list, object; always
store a `value_text` for equality/contains/sort. This is what makes `due < today()` and numeric
comparisons work in SQL.

## 6. Index population & freshness — `NotesIndexService`

New service modeled on `SkillIndexService` + `SkillSyncWatcher`, owning the two tables.

- **Initial build (background, non-blocking):** after cache ready, walk
  `vault.getMarkdownFiles()`, read `metadataCache.getFileCache(file)` (frontmatter + tags +
  links), upsert `notes` + `note_properties`, content-hash-gated (skip unchanged). Batch like
  the embeddings backfill so it doesn't stall boot on large vaults.
- **Freshness:** subscribe to `metadataCache.on('changed')` and the vault `rename`/`delete`
  events (same pattern as `VaultFileIndex.setupMetadataCacheEvents`), debounced + coalesced
  (reuse `SkillSyncWatcher` shape). On change: re-upsert that note's rows; on delete: cascade.
- **Prune:** periodic / on full rebuild — drop `notes` rows whose path no longer exists.
- **Rebuild hook:** add a vault-reindex step to `SyncCoordinator.fullRebuild()` (and the
  "Nexus: Rebuild cache" command) since this table is derived from the vault, not JSONL.
- **Mobile:** `vault.getMarkdownFiles()`, `metadataCache`, sql.js all work on mobile; no Node
  built-ins — keep it that way (no top-level npm/Node imports).

## 7. Query surface (mapped to the real Bases spec)

Grounded in kepano/obsidian-skills (Obsidian's official agent reference). Property namespaces:
**note/frontmatter** (bare name), **file.*** (`name basename path folder ext ctime mtime size
tags links`), **formula.*** (computed).

**Tier 1 — ship first (pure SQL compile):**
- Filter object `and` / `or` / `not` (recursive) + comparisons `== != > < >= <=`
- Conditions on `file.*` columns and frontmatter props (equality, comparison, existence)
- Functions: `file.hasTag`, `file.inFolder`, `file.hasProperty`, `string.contains`,
  `list.contains`, `isEmpty`
- `select` properties, `sort`, `limit`

Compilation: file.* → `notes` columns; frontmatter condition → correlated
`EXISTS (SELECT 1 FROM note_properties p WHERE p.note_path = n.path AND p.key = ? AND <op>)`;
`and/or/not` → nested boolean SQL; numeric/date ops use `value_num`, text ops use `value_text`.

**Tier 2 — formula evaluator + aggregation (JS over fetched rows):**
- Expression evaluator with a **type-dispatched method table** (string/number/date/list/file/
  link/object) — `if`, `date`, `today`, `now`, arithmetic, `number`, date subtraction → `.days`,
  then `string.startsWith/endsWith/lower/replace/slice/split`, `number.round/abs/floor/ceil`,
  `list.map/filter/join/sort/unique`, `link`/`linksTo`
- Computed columns + filters that reference `formula.*`
- `groupBy` + `summaries`: `Sum Average Min Max Count`
- **Security:** a small AST parser/interpreter over a fixed function table — **never `eval()`**.
  This is the largest build cost; scope it deliberately.

**Tier 3 — later:** `cards`/`list` output shapes, `reduce`, `regexp.matches`,
`properties.displayName`, `relative()`/`format()` date formatting, custom summary expressions.

> Tolerate both filter dialects when ingesting wild `.base` files: current method forms
> (`file.hasTag`) and older global forms (`taggedWith(...)`) from early betas.

## 8. Tool: `queryNotes` (SearchManager)

`BaseTool`, constructor-injected `Plugin` + a `NotesIndexService` resolver; registered via
`registerLazyTool`. Structured params (CLI-normalizer handles array/object coercion). Validation
guards in the service, not the schema.

```jsonc
{
  "from": "Projects",                       // optional folder scope; default whole vault
  "where": {                                // Bases-shaped filter object
    "and": [
      { "prop": "status", "op": "!=", "value": "done" },
      { "fn": "file.hasTag", "args": ["task"] },
      { "or": [ { "prop": "priority", "op": ">=", "value": 2 },
                { "fn": "file.inFolder", "args": ["Urgent"] } ] }
    ]
  },
  "select": ["file.name", "status", "due", "formula.days_until_due"],
  "compute": { "days_until_due": "if(due, (date(due) - today()).days, \"\")" },
  "sort":   [{ "by": "due", "dir": "ASC" }],
  "groupBy": { "property": "status" },      // Tier 2
  "limit": 100,
  "baseFile": "Tasks.base"                  // Tier 3 alt: load filters/formulas from a .base
}
```

Result: `{ success, rows: [{ path, ...selected, ...computed }], groups?, count }`.

## 9. Optional companion: `.base` round-trip (`baseSet`)

Independent, cheap, zero Bases-API dependency — a `.base` is just a YAML file
(`vault.create`/`modify`/archive). Lets the agent author a persistent, **user-visible** database
view the human opens in Obsidian's native Bases UI, while `queryNotes`/`baseFile` re-runs the same
`.base` headlessly through our engine. Slot in any time after Tier 1. (Document that our evaluation
of a `.base` may diverge from Bases-rendered output on unsupported functions.)

## 10. Phasing

- **Phase 0** — v14 schema + `NotesIndexService` (walk, typed upsert, prune, freshness, rebuild
  hook). No tool. Verify via direct SQL + unit tests on a fixture vault.
- **Phase 1** — `queryNotes` Tier 1 (SQL compile: file.* + frontmatter filters, and/or/not, sort,
  limit, select). The usable MVP for "get notes with these properties, filter by this."
- **Phase 2** — formula evaluator (AST interpreter) + computed columns + groupBy/summaries.
  Delivers "calculate that."
- **Phase 3** — `.base` ingestion (`baseFile`) + Tier 2/3 functions + `baseSet` CRUA companion.

## 11. Risks & open questions

- **EAV row count** — one row per property (per list element) per note. Index carefully; this is
  the same order of data Dataview holds in memory. Validate on a large vault in Phase 0.
- **Type coercion fidelity** — date/number detection drives all comparison correctness; needs a
  tested coercion module (ISO dates → epoch, `value_num`).
- **Formula evaluator scope/security** — biggest cost; fixed-function AST interpreter, no `eval`.
  Keep Tier 1 SQL-only so the MVP ships without it.
- **Freshness races** — `changed` fires before `resolved`; debounce/coalesce (SkillSyncWatcher).
- **Rebuild semantics** — index is vault-derived, so `fullRebuild` must re-walk, not replay JSONL.
- **Divergence from native Bases output** — acceptable and documented; we mirror a subset.
- **Boot cost** — initial walk must be background + hash-gated; never block startup.

## 12. Testing

- Unit: typing/coercion module; filter→SQL compiler (each operator + and/or/not nesting);
  formula evaluator per method-table type; upsert/prune/freshness on a fixture vault.
- Integration: cold build → query; metadataCache change → re-query reflects update; rename/delete
  cascade; `fullRebuild` repopulates; mobile (vault.adapter) smoke.
- Eval: a few `queryNotes` cases in the LLM eval harness once Tier 1 lands.

## Sources (research)

- Obsidian Bases dev API surface — `obsidianmd/obsidian-api` (`obsidian.d.ts`); forum "Provide API
  access to the results of Bases view" (open request).
- `.base` format + functions — kepano/obsidian-skills `obsidian-bases/SKILL.md` +
  `references/FUNCTIONS_REFERENCE.md` (Obsidian's official agent reference); Obsidian Help
  Bases syntax/functions.
- Codebase — `VaultFileIndex.ts`, `CacheManager.ts`, `SkillScanner/SkillIndexService/SkillSyncWatcher`,
  `SchemaMigrator.ts:76`, `schema.ts`, `IStorageBackend.ts:88`, `SyncCoordinator.fullRebuild`,
  `src/agents/searchManager/` tool patterns, `ToolCliNormalizer`.
