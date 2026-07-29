# Plan — `memory search-workspaces` (+ opt-in auto-load)

**Branch**: `feat/search-workspaces` (worktree `.worktrees/feat-search-workspaces`)
**Status**: approved 2026-07-29

## Problem

`memory list-workspaces` is the only discovery path for workspaces. It returns every
non-archived workspace with `id`, `name`, `description`, `rootFolder`, `lastAccessed`,
`childCount`. On a vault with many workspaces that is a pure context tax: the model
usually wants exactly one workspace and has a name fragment for it.

`WorkspaceService.searchWorkspaces(query, limit)` already exists but **no tool calls it**,
and it is not fit for this purpose as-is:

- the SQLite path wraps the query in double quotes (`SQLiteSearchService.escapeFTS5Query`),
  making it exact-phrase / exact-token only — `"resear"` does not match `Research`;
- `workspace_fts` indexes `name` + `description` only;
- it returns nothing when the SQLite cache is cold or unavailable (mobile falls back to a
  word-index path with `word.length > 2` filtering and different semantics).

So the two backends disagree on what "search" means. A tool built on it would behave
differently depending on cache state, which is the worst property for an agent-facing tool.

## Approach

Score locally over the lightweight workspace index. `WorkspaceService.listWorkspaces()` is
index-only (documented "lightweight and fast") and returns `WorkspaceMetadata` with
everything we need to match on. Workspace counts are user-scale (tens, not thousands), so
in-memory scoring is cheap and — critically — **identical across desktop/mobile/cold-cache**.

We deliberately do not extend the FTS path: matching lives in one pure, unit-testable
function instead of split between SQL and TS.

## Deliverables

### 1. `src/agents/memoryManager/services/WorkspaceMatcher.ts`

Pure module, no Obsidian/service deps.

```ts
export interface WorkspaceMatch {
  workspace: WorkspaceMetadata;
  score: number;
  matchedOn: Array<'id' | 'name' | 'description' | 'rootFolder'>;
  isExact: boolean;   // case-insensitive whole-value hit on id or name
}

export function matchWorkspaces(
  workspaces: WorkspaceMetadata[],
  query: string,
  options?: { includeArchived?: boolean; limit?: number }
): WorkspaceMatch[];
```

Scoring ladder (highest wins; a workspace accumulates across fields):

| Signal | Score |
| --- | --- |
| `id` equals query (case-insensitive) | 1.0, `isExact` |
| `name` equals query | 1.0, `isExact` |
| `name` starts with query | 0.8 |
| `name` contains query | 0.6 |
| all query tokens present in `name` | 0.5 |
| some query tokens present in `name` | 0.25 × ratio |
| `description` contains query | 0.3 |
| query tokens present in `description` | 0.15 × ratio |
| `rootFolder` contains query | 0.2 |

Archived workspaces excluded unless `includeArchived`. Results sorted by score desc, then
`lastAccessed` desc as tiebreak. Zero-score entries dropped.

### 2. `src/agents/memoryManager/tools/workspaces/searchWorkspaces.ts`

`SearchWorkspacesTool extends BaseTool<SearchWorkspacesParameters, SearchWorkspacesResult>`.

CLI surface (derived automatically by `ToolCliNormalizer` from the registered slug — no
normalizer changes needed):

```
memory search-workspaces <query> [--load] [--limit <limit>] [--include-archived]
```

- `query` — required, positional (required + string ⇒ positional per `buildCliSchema`).
- `limit` — default 10.
- `includeArchived` — default false.
- `load` — default **false** (opt-in).

**Auto-load rule (strict):** when `load` is true *and* exactly one match survives scoring,
delegate to the existing `loadWorkspace` tool via
`agent.executeTool('loadWorkspace', { workspace: <id>, ... })` and return its full payload
with `data.autoLoaded: true` and `data.matches` still present for traceability. Zero or
2+ matches ⇒ no load, `autoLoaded: false`, plus a nudge.

Passing `--limit 1` does **not** manufacture a single match: the strict rule is evaluated
against the pre-limit match count, so truncation can never trigger an auto-load.

**Result-side nudge** on every non-loaded path, mirroring the search→read decoration
pattern already used elsewhere:

- matches, not loaded → `"These are workspace locations, not contents. Call `memory load-workspace --workspace <id>` to load one."`
- exactly 0 matches → suggest `memory list-workspaces` as the fallback.

Result shape:

```ts
interface SearchWorkspacesResult extends CommonResult {
  data: {
    query: string;
    matches: Array<{
      id: string; name: string; description?: string; rootFolder: string;
      lastAccessed: number; score: number; matchedOn: string[];
    }>;
    totalMatches: number;   // pre-limit
    autoLoaded: boolean;
    workspace?: unknown;    // loadWorkspace payload when autoLoaded
    nudge?: string;
  };
}
```

### 3. Wiring

- `registerLazyTool({ slug: 'searchWorkspaces', ... })` in `memoryManager.ts`.
- Export from `tools/workspaces/index.ts`.
- Types in `src/database/types/workspace/ParameterTypes.ts`, re-exported from
  `src/database/types/index.ts` alongside `ListWorkspacesResult`.
- `listWorkspaces` description updated to point at search as the cheaper first move.

### 4. Tests

- `tests/unit/WorkspaceMatcher.test.ts` — scoring ladder, exactness, archived filtering,
  ordering, tiebreak, empty query.
- `tests/unit/SearchWorkspacesTool.test.ts` — no-service error path, zero/one/many match
  shapes, `--load` strict trigger, `--load` suppressed at 2+ matches, `--limit` never
  triggers a load, nudge text present.

## Non-goals

- Embedding / semantic workspace search (the `searchManager` surface owns that).
- Touching `WorkspaceService.searchWorkspaces` or the FTS schema — left alone; it stays
  available for any consumer that wants FTS semantics.
- Any change to `listWorkspaces` behavior (only its description).
