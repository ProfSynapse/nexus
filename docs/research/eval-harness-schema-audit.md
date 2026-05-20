# Eval Harness Tool Schema Audit

Audit of `tests/eval/fixtures/tools.ts` (`NEXUS_TOOLS` array) against current production `getParameterSchema()` returns. Produced under Task #10 of the `fix/eval-harness-cli-schema` branch.

## Method

For each fixture entry in `NEXUS_TOOLS`, located the corresponding production tool class under `src/agents/*/tools/*.ts`, read its `getParameterSchema()` method, and compared required fields, optional fields, types, enums, and descriptions. Production schemas are wrapped by `getMergedSchema()` which merges in `CommonParameters` (workspaceId/sessionId/memory/goal/constraints); for this audit, the toolSchema (pre-merge) is the unit of comparison since the harness fixture does not include the common parameters.

## Summary Table

| Tool name in fixture | Production class | Status | Drifted fields |
|----------------------|------------------|--------|---------------|
| `contentManager_read` | `ContentManager` `ReadTool` (read.ts) | match | 0 |
| `contentManager_write` | `ContentManager` `WriteTool` (write.ts) | drift | 1 (missing `overwrite`) |
| `contentManager_insert` | `ContentManager` `InsertTool` (insert.ts) | drift | 4 (`position`/`lineNumber` instead of `startLine`, different semantics) |
| `contentManager_replace` | `ContentManager` `ReplaceTool` (replace.ts) | drift (HARD) | 4 (`search`/`replace` two-field vs `start`/`end`/`content` three-field anchor model) |
| `storageManager_move` | `StorageManager` `MoveTool` (move.ts) | drift | 2 (`destination` vs `newPath`; missing `overwrite`) |
| `storageManager_copy` | `StorageManager` `CopyTool` (copy.ts) | drift | 2 (`destination` vs `newPath`; missing `overwrite`) |
| `storageManager_archive` | `StorageManager` `ArchiveTool` (archive.ts) | match | 0 |
| `storageManager_createFolder` | `StorageManager` `CreateFolderTool` (createFolder.ts) | match | 0 |
| `storageManager_list` | `StorageManager` `ListTool` (list.ts) | drift | 2 (`path` listed as required, missing `filter`) |
| `searchManager_content` | `SearchManager` `SearchContentTool` (searchContent.ts) | drift | 4 (missing `semantic`/`includeContent`/`snippetLength`/`paths`) |
| `searchManager_directory` | `SearchManager` `SearchDirectoryTool` (searchDirectory.ts) | drift | 5+ (`paths` should be required, missing `fileTypes`/`depth`/`pattern`/`dateRange`/`limit`/`includeContent`; `searchType` lacks enum) |

11 entries audited: 3 match, 8 drift. The HARD drift on `contentManager_replace` is the v5.9.0 schema break called out in CLAUDE.md.

## Per-Drift Detail

### contentManager_write (drift, 1 field)

Production at `src/agents/contentManager/tools/write.ts:174-196`:
- `path` (string, required)
- `content` (string, required)
- `overwrite` (boolean, optional, default: false)

Fixture at `tests/eval/fixtures/tools.ts:33-47`:
- `path` (string, required)
- `content` (string, required)

Drift: `overwrite` is missing in fixture. Not breaking (defaults to false), but the harness LLM cannot exercise the overwrite path.

---

### contentManager_insert (drift, semantic redesign)

Production at `src/agents/contentManager/tools/insert.ts:128-149`:
- `path` (string, required)
- `content` (string, required)
- `startLine` (number, required) — line-based: `1` to prepend, `-1` to append, `N` to insert before line N

Fixture at `tests/eval/fixtures/tools.ts:48-64`:
- `path` (string, required)
- `content` (string, required)
- `position` (string, required) — generic "position" string
- `lineNumber` (number, optional)

Drift: Fixture uses a `position` string + optional `lineNumber` shape that does not exist in production. Production uses a single integer `startLine` with sentinel values (`1`, `-1`, `N`). Fixture would mislead the model into emitting a `position: "append"` shape that production rejects. From CLAUDE.md pin: `append`/`prepend` actions in executePrompts route to `insert` — same single-integer convention.

---

### contentManager_replace (drift, HARD — v5.9.0 break)

Production at `src/agents/contentManager/tools/replace.ts:202-227`:
- `path` (string, required)
- `start` (string, required) — content-anchor opening line(s), must be globally unique
- `end` (string, required) — content-anchor closing line(s), must be after `start`
- `content` (string, required) — replacement text; empty string deletes the range

Fixture at `tests/eval/fixtures/tools.ts:65-80`:
- `path` (string, required)
- `search` (string, required) — text to find
- `replace` (string, required) — replacement text

Drift: Production switched from search/replace semantics to pattern-anchored range replacement in v5.9.0 (per CLAUDE.md pin). The new model identifies a contiguous range using `start`/`end` line anchors and replaces it with `content`; line numbers are never required. The fixture's `search`/`replace` shape predates this break and bears no field-name overlap with production. This is the most severe drift in the fixture.

Evidence: CLAUDE.md pinned context — "v5.9.0 — Pattern-anchored content replace (PR #206): hard schema break from `{path, oldContent, newContent, startLine, endLine}` to 4-field `{path, start, end, content}` on both `ContentManager.replace` and `executePrompts.replace`."

---

### storageManager_move (drift, 2 fields)

Production at `src/agents/storageManager/tools/move.ts:93-117`:
- `path` (string, required)
- `newPath` (string, required)
- `overwrite` (boolean, optional, default: false)

Fixture at `tests/eval/fixtures/tools.ts:81-95`:
- `path` (string, required)
- `destination` (string, required)

Drift: Field name is `newPath` in production, not `destination`. Fixture also omits `overwrite`. A model emitting `{ path, destination }` would have its destination argument silently dropped by production.

---

### storageManager_copy (drift, 2 fields)

Production at `src/agents/storageManager/tools/copy.ts:84-107`:
- `path` (string, required)
- `newPath` (string, required)
- `overwrite` (boolean, optional, default: false)

Fixture at `tests/eval/fixtures/tools.ts:96-110`:
- `path` (string, required)
- `destination` (string, required)

Drift: Same `destination` vs `newPath` mismatch as move. Same missing `overwrite`.

---

### storageManager_list (drift, 2 fields)

Production at `src/agents/storageManager/tools/list.ts:167-185`:
- `path` (string, optional, default: '') — empty string / `/` / `.` is vault root
- `filter` (string, optional)
- `required: []` — both fields optional

Fixture at `tests/eval/fixtures/tools.ts:139-152`:
- `path` (string, required)

Drift: Production has `path` as optional with vault-root default; fixture marks it required. Fixture also missing the `filter` option. A model calling `storageManager_list` with no args is valid in production but rejected by the fixture schema.

---

### searchManager_content (drift, 4 fields)

Production at `src/agents/searchManager/tools/searchContent.ts:472-517`:
- `query` (string, required)
- `semantic` (boolean, optional, default: false) — true for vector search
- `limit` (number, optional, default: 10, min 1, max 50)
- `includeContent` (boolean, optional, default: true)
- `snippetLength` (number, optional, default: 200, min 50, max 1000)
- `paths` (array of string, optional) — folder paths or glob patterns

Fixture at `tests/eval/fixtures/tools.ts:153-167`:
- `query` (string, required)
- `limit` (number, optional)

Drift: Fixture is missing `semantic`, `includeContent`, `snippetLength`, and `paths`. The `semantic` flag in particular is significant — production exposes both keyword and AI-powered semantic search through this one tool; the fixture only exposes the keyword path.

---

### searchManager_directory (drift, 5+ fields, plus required-list mismatch)

Production at `src/agents/searchManager/tools/searchDirectory.ts:208-290`:
- `query` (string, required, minLength 1)
- `paths` (array of string, required, minItems 1)
- `searchType` (string enum `'files'|'folders'|'both'`, optional, default: `'both'`)
- `fileTypes` (array of string, optional)
- `depth` (number, optional, 1–10)
- `pattern` (string, optional) — regex filter
- `dateRange` (object with start/end YYYY-MM-DD, optional)
- `limit` (number, optional, default: 20, 1–100)
- `includeContent` (boolean, optional, default: true)

Fixture at `tests/eval/fixtures/tools.ts:168-183`:
- `query` (string, required)
- `paths` (array of string, optional) — listed in properties but NOT in required
- `searchType` (string, optional) — no enum constraint

Drift: (a) `paths` is required in production but listed as optional in the fixture — opposite required-set. (b) `searchType` lacks the `files|folders|both` enum in fixture. (c) Five fields missing from fixture (`fileTypes`, `depth`, `pattern`, `dateRange`, `limit`, `includeContent`).

## Production-side tools NOT in the fixture

The fixture covers `contentManager` (4 of 5 tools), `storageManager` (5 of 6 tools), and `searchManager` (2 of 3 tools). The following production tools have no fixture representation:

| Production tool | Agent | Source |
|-----------------|-------|--------|
| `contentManager_setProperty` | ContentManager | `src/agents/contentManager/tools/setProperty.ts` — set frontmatter property, replace/merge modes |
| `storageManager_open` | StorageManager | `src/agents/storageManager/tools/open.ts` — open file in Obsidian editor |
| `searchManager_memory` | SearchManager | `src/agents/searchManager/tools/searchMemory.ts` — search memory traces / states / conversations |
| `memoryManager_*` (full agent) | MemoryManager | createSession, loadSession, createWorkspace, createState, etc. |
| `canvasManager_*` (full agent) | CanvasManager | read, write, update, list |
| `taskManager_*` (full agent) | TaskManager | createProject, listProjects, createTask, listTasks, updateTask, moveTask, queryTasks, linkNote |
| `promptManager_*` (full agent) | PromptManager | listModels, executePrompts, createPrompt, updatePrompt, deletePrompt, listPrompts, getPrompt, generateImage |
| `ingestManager_*` (full agent) | IngestManager | ingest, listCapabilities |
| App agents (webTools, composer) | apps/ | openWebpage, capturePagePdf, capturePagePng, captureToMarkdown, extractLinks, compose, listFormats |

The Task #8 eval run showed the LLM calling `searchManager_memory`, `canvasManager_list`, etc. — names that exist in production but were rejected as hallucinations by the harness because they are not in the fixture. The Task #11 schema swap removes those names from the callable tool schema, but the production system prompt can still mention agent/tool catalog entries, so live meta evals must still treat direct `agent_tool` calls as prompt-leak or model-behavior failures rather than assuming they cannot happen.

## Fixture-side tools NOT in production

None. Every fixture entry maps to a production tool class. The drifts above are field-level / shape-level mismatches, not phantom tools.

## Implications for Task #11 (schema swap)

The audit confirms the team-lead's framing: the harness fixture has substantial drift across 8 of 11 entries plus 6+ missing production tools, but Task #11's plan is to swap the entire `NEXUS_TOOLS` array for the two-tool surface (`getTools` + `useTools`). After the swap:

- The callable tool schema exposes only the two-tool MCP shape (`getTools` and `useTools`).
- The executor parses the `useTools.tool` CLI string via the real `ToolCliNormalizer`.
- Drifts above stop mattering for the callable function surface, but stale CLI examples and prompt catalog text can still bias models toward invalid command names.
- They still matter for the executor: when it parses `content replace --path foo.md --start "..." --end "..." --content "..."` it must route to the production 4-field schema, not the obsolete 3-field one. This audit is the reference for getting that routing right.

## Evidence Index

| Tool | Production file:line |
|------|----------------------|
| read | `src/agents/contentManager/tools/read.ts:110-131` |
| write | `src/agents/contentManager/tools/write.ts:174-196` |
| insert | `src/agents/contentManager/tools/insert.ts:128-149` |
| replace | `src/agents/contentManager/tools/replace.ts:202-227` |
| setProperty | `src/agents/contentManager/tools/setProperty.ts:161-193` |
| list | `src/agents/storageManager/tools/list.ts:167-185` |
| move | `src/agents/storageManager/tools/move.ts:93-117` |
| copy | `src/agents/storageManager/tools/copy.ts:84-107` |
| archive | `src/agents/storageManager/tools/archive.ts:110-125` |
| createFolder | `src/agents/storageManager/tools/createFolder.ts:68-83` |
| open | `src/agents/storageManager/tools/open.ts` |
| searchContent | `src/agents/searchManager/tools/searchContent.ts:472-517` |
| searchDirectory | `src/agents/searchManager/tools/searchDirectory.ts:208-290` |
| searchMemory | `src/agents/searchManager/tools/searchMemory.ts` |

Fixture under audit: `tests/eval/fixtures/tools.ts` lines 16-184 (`NEXUS_TOOLS`). The file also contains `META_TOOLS` (`getTools`/`useTools`, lines 189-234) and `SIMPLE_TOOLS` (weather/time mocks, lines 239-268), neither of which are in scope for this audit.
