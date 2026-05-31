# Spreadsheet Mirror + Versioning — Implementation Plan

Status: DRAFT (design complete, pre-spike). Owner: TBD. Created 2026-05-31.
Companion to `docs/plans/sandboxed-code-execution-app-plan.md` (the Data Analysis app this builds on).

> Design decisions below were worked through and locked 2026-05-31. The only
> remaining gates are the Phase-0 spikes (§11).

## 1. Goal

Let the AI clean / normalize / pattern-edit spreadsheet data on a plain-text
surface, and have those edits flow back into the real `.xlsx` **losslessly** —
preserving formulas, formatting, **and charts/images/pivots**. Add CRUA-faithful
version history so every edit is reversible and queryable.

End-to-end workflow:

1. AI reads a spreadsheet (already works — Data Analysis app).
2. AI cleans / normalizes a cell range or pattern match in pandas (optionally via
   a reusable **Skill**).
3. Changed cells are applied back to the workbook **as deltas**, leaving every
   untouched part — including charts — byte-intact.
4. Every apply leaves a restore point + an audit trail; the mirror is re-projected
   from the updated workbook.

### Non-goals

- **No formula engine.** We never evaluate or flatten Excel formulas (§3.4).
- **No chart *creation*** from scratch — only **preservation** of existing charts
  through edits (the engine, §3.5, gives us this).
- **No PNG/visibility extraction** of charts — the user views charts in Excel;
  the AI doesn't need them rendered. (Considered and dropped.)
- Not a live two-way Excel sync — the mirror is a generated projection (§3.3),
  with a divergence guard (§7), not a concurrently-edited store.
- **v1 desktop-only** (the pandas analysis is Pyodide/desktop). Note the
  mirror+write-back legs are pure TS and *could* go mobile later (§9).

## 2. What we already have (de-risking)

- **Vault-root synced folder + resolver**: `storage.rootPath` (default `Nexus`,
  renameable in Settings → Data) resolved via `resolveVaultRoot(settings)`
  (`VaultRootResolver.ts`). Skills already mirror under it. Hands back
  `maxShardBytes` — our file-size cap is already a configured storage concern.
- **Pyodide + pandas** (Data Analysis app) for the analysis/cleaning compute.
- **`archiveThenReplace`** (version-in-place snapshot) in `SkillWriteService` —
  the primitive we extract (§4).
- **Hybrid JSONL→SQLite** storage with per-entity event tables (states, tasks) +
  **sharding** precedent (`shard_cursors`, v12) — the pattern the event log and
  the CSV sharding reuse (§3.2, §5).
- **App settings-section framework** (`AppCustomSection` + `SkillsSectionRenderer`,
  `BoxedSection`, `ConfirmModal`) — the UI we recycle for history/restore (§8).

## 3. Architecture

### 3.1 Location & layout (Q1 — LOCKED)

Mirrors live under the **resolved Nexus root**, a sibling of `skills/`/`data/`/
`guides/`, so they inherit the user's rename, the sync guarantee (non-hidden vault
folder), and path validation:

```
<resolveVaultRoot(settings).resolvedPath>/        ← e.g. "Nexus/" (renameable, synced)
  spreadsheets/
    budget/
      manifest.json            ← sheet order, source-xlsx hash, shard index, formula-cell map
      Sheet1.part0.csv         ← values only — the AI's edit + analysis surface
      Sheet1.part1.csv         ← sharded to maxShardBytes (the 5MB cap)
      Sheet2.part0.csv
      _archive/
        Sheet1.part0.<ts>.csv  ← value-level snapshots (SnapshotArchiveService, §4)
```

### 3.2 5MB-per-file cap → sharded CSVs (LOCKED)

A sheet can exceed the cap, so each sheet's CSV **shards to `maxShardBytes`**
(reusing the existing storage sharding discipline). `manifest.json` is the **shard
index**: sheet order, per-shard row ranges, reassembly order, and the source hash.
The event-log JSONL shards the same way as it grows.

### 3.3 The CSV is a *projection*; the xlsx is the source of truth (LOCKED)

The mirror is **not** a parallel store — it's a regenerated view:

```
edit CSV ──apply (changed cells)──▶ xlsx (source of truth) ──re-project──▶ fresh CSV mirror
```

After every write-back we re-project the CSVs from the updated workbook, so the
mirror always reflects canonical state. Because the projection is small + sharded
(<cap), **we snapshot the CSV projection, not the big xlsx** (value-level restore,
§5) — the user's own file backups/sync cover byte-exact xlsx history.

### 3.4 Formulas: never evaluated, never flattened (LOCKED — single mode)

Two non-overlapping worlds, no toggle, no engine:

- **Excel formulas stay live in the xlsx** → Excel recomputes them on open. We
  never read, evaluate, or replace them.
- **The AI computes what *it* needs in pandas** (optionally a saved **Skill**),
  writing results as literal values into **data** cells.

Implications:
- **Formula-cell write guard**: by default the write-back **does not overwrite
  formula cells** — it warns if an edit targets one. Existing formulas survive
  automatically.
- **Projection labels formula cells** (in `manifest.json`) as "formula output —
  recompute from inputs if you need the current value; the cached value may be
  stale until Excel reopens." No staleness handling beyond the label.
- **Skills synergy**: a user's standard cleaning/analysis lives as a reusable,
  versioned pandas Skill — computation moves out of brittle Excel formulas into
  inspectable scripts.

### 3.5 Write-back engine: `hucre` (LOCKED — research 2026-05-31)

Every full read-modify-write library (openpyxl, ExcelJS, SheetJS) rebuilds the
file from an incomplete object model and **drops charts/images/pivots**. We need
surgical editing (touch only changed cells, leave everything else byte-intact).
Rather than hand-roll OOXML zip surgery, we adopt **[`hucre`](https://github.com/productdevbook/hucre)**:

- **MIT, zero dependencies, pure TypeScript, ESM.**
- Round-trips **charts, images, pivots, VBA, themes, slicers, timelines** —
  "open, modify, save — without losing charts." Covers 127/135 tracked features.
- Runs in **browsers / Web Workers / Electron renderer** (`CompressionStream` +
  pure-TS fallback; no Node APIs).
- **Actively maintained**: v0.6.0 (2026-05-28), 1.4k stars, 7 releases.
- Fallback if the spike finds gaps: **`@protobi/exceljs`** (chart/pivot-preserving
  ExcelJS fork).

**Architectural consequence — write-back leaves the sandbox.** The write-back is
deterministic file manipulation with no untrusted code, so it runs **host-side in
TypeScript over `hucre`**, *outside* Pyodide:

- **hucre (host, TS)** → reads xlsx → sheet values (mirror gen) **and** applies
  changed cells back losslessly.
- **Pyodide/pandas (sandbox)** → purely the analysis compute on CSV values.

We **do not need openpyxl in this flow** (it stays in the existing Data Analysis
app for pandas xlsx reads). No Python on the write path, no formula engine.

**Spike-validated (2026-05-31, `docs/plans/spike-findings-hucre-2026-05-31.md`):**
lossless preservation proven empirically — an unmanaged ZIP part (chart stand-in)
survived a data-cell edit byte-for-byte via `openXlsx`/`saveXlsx` (`_rawEntries` +
`_modifiedParts` model). Runs headless in Node 22 → unit-testable without Electron.
**Bundle: the `hucre/xlsx` entry is 302 KB minified vs only ~218 KB main.js
headroom → it must be VENDORED as a runtime asset** (PyodideEnsurer pattern),
costing ~0 in main.js. Write-back must explicitly mark `_modifiedParts` per edited
sheet (cell edits don't auto-dirty), and honor `hasMacros`→`.xlsm`.

### 3.6 Data flow

```
xlsx ──hucre.read (TS host)──▶ values CSVs (sharded) + manifest      [generate/refresh]
CSVs ──AI edits (CRUD / Data Analysis pandas / Skill)──▶ edited CSVs [edit]
edited CSVs ─diff vs mirror─▶ changed data-cell set                 [diff]
changed set ──hucre.apply changed cells, save (TS host)──▶ xlsx      [write-back, lossless]
            + formula-cell write guard (§3.4)
            + snapshot prior CSV shards (§4/§5)
            + append spreadsheet_edit event (§5)
            + re-project CSVs from updated xlsx (§3.3)
```

The **single guarded boundary** is the write-back step; all guardrails (§6) live there.

## 4. DRY archive — extract `SnapshotArchiveService`

The repo has **three distinct things named "archive"** (verified by grep):

| Flavor | Semantics | Where today | Convention |
|---|---|---|---|
| Soft-archive **flag** | reversible `isArchived` status, entity stays | states/workspaces/prompts/tasks/skills (99 refs) | a flag, not files |
| **Relocate**-archive | **moves** note/folder out | `StorageManager.archive` tool | `.archive/<ts>/<path>` |
| **Version-in-place** | **copies** prior bytes, live file stays | `SkillWriteService.archiveThenReplace` | `_archive/<name>.<ts>` |

- The **soft-flag** archive is a repository/event convention, not extractable code
  — do NOT unify it (wrong abstraction; cf. the CLAUDE.md ToolManager-bridge pin).
- **Spreadsheet versioning needs version-in-place** — the `archiveThenReplace`
  semantics.

**The DRY move** (triggered now — spreadsheets are the *second* consumer):

1. Extract `SnapshotArchiveService` from `SkillWriteService`:
   `archiveCopy(path, { archiveDir, timestampFn, hashFn })`.
2. Optionally expose `archiveMove(...)` over the same primitive so
   `StorageManager.archive` can share the dir/timestamp helper — but keep each
   consumer's **convention** (move-vs-copy and path stay explicit; observable).
3. Rewire Skills to the shared service with **no behavior change** (spike S1
   asserts byte-identical output).

## 5. Versioning — snapshot + event log

Both CRUA-faithful (archive = soft/reversible; nothing auto-hard-deletes):

- **Snapshot archive** (`SnapshotArchiveService`, §4): **value-level**, the prior
  **CSV shards** before each apply (Q-resolved: always under the cap, diffable;
  not byte-exact xlsx). Restore = un-archive.
- **Event log** (Q4 — per-operation, LOCKED): one `spreadsheet_edit` event per
  logical edit — `{ workbook, sheet, range|pattern, opSummary, cellsChanged,
  sample[], ts, hash }` — **not** per-cell (avoids the 5000-cell explosion;
  snapshots give exact restore). JSONL = source of truth (sharded), mirrored into
  a **new SQLite table (v14 migration)** for query.

Snapshot answers "put it back"; event log answers "what changed and when".

## 6. Guardrails (at the write-back boundary)

- **Unsupported-feature pre-scan**: hucre covers 127/135 features. Before
  write-back, detect any part hucre can't round-trip (the 8 gaps — spike S2
  enumerates them) and **refuse rather than silently lose**. (Charts/images/pivots
  are *supported*, so unlike the openpyxl path there is no chart guard needed.)
- **Formula-cell write guard** (§3.4): don't overwrite formula cells by default.
- **Divergence guard** (§7): source-hash mismatch blocks blind overwrite.
- **`dryRun`**: returns the change summary (cells changed, before→after samples,
  any refused/unsupported parts) without writing.
- **Serialize** write-backs (one at a time), like `runAnalysis`.

## 7. Sync / conflict policy

- `manifest.json` carries the **source `.xlsx` hash**.
- Before mirror-refresh or write-back, compare current xlsx hash to stored:
  - Match → proceed.
  - Mismatch (user edited the xlsx in Excel since last mirror) → **no blind
    last-writer-wins**: surface the divergence; offer re-mirror (discard CSV
    edits) or refuse pending the user's choice. Default **warn + require explicit
    resolution** (spreadsheets are higher-stakes than the Skills mirror).

## 8. UI — reuse, don't rebuild (Q5 — LOCKED)

History/restore recycles the existing app-settings stack, ~no net-new components:

- **`AppCustomSection`** hook — the Skills app's settings-section mount; Data
  Analysis app reuses it.
- **`StatesSectionRenderer`** — already "a list of snapshots with restore/
  archive/delete"; model `SpreadsheetHistorySectionRenderer` on it.
- **`BoxedSection`** container + **`ConfirmModal`** (`confirmDangerousAction`,
  `variant=delete`/`archive`) for restore/delete confirmation.
- Backed by **`SnapshotArchiveService`** (§4) + the event log (§5).

## 9. Tool contracts (draft)

Additive to the Data Analysis app (desktop-gated for v1):

- `mirrorWorkbook({ path })` → hucre-reads the xlsx, writes sharded values-CSVs +
  manifest. Idempotent (hash-gated). Returns sheet/shard summary.
- `applyToWorkbook({ workbook, sheets?, dryRun?, overwrite? })` → diffs edited
  CSVs vs mirror, hucre-applies changed **data** cells (formula-cell guard),
  snapshots prior shards, logs the op event, re-projects the mirror. `dryRun`
  returns the summary without writing.
- History/restore via the §8 UI + event log.

`dryRun` default-on for the first apply of a session is under consideration
(overwriting a workbook is hard to reverse).

Note: the mirror + write-back legs are pure TS (hucre) and mobile-capable; only
the pandas analysis is desktop-only. v1 gates the whole feature behind
`isDesktop()` for consistency; revisit a mobile editing surface later.

## 10. Resolved decisions (was "open questions")

- **Q1 location** → `<root>/spreadsheets/<workbook>/` via `resolveVaultRoot`,
  sharded to `maxShardBytes`. ✅
- **Q2 type fidelity** → mostly dissolves: delta-apply only touches changed cells,
  so the **retained xlsx is the type store**; only *new* cells need inference. No
  rich typed manifest — a light formula-cell + new-cell-type map suffices. ✅
- **Q3 lossy content** → solved by engine choice: **hucre preserves** charts/
  images/pivots, so no refuse-on-charts. Guard only the 8 genuinely-unsupported
  features (§6). ✅
- **Q4 event-log granularity** → **per-operation** events + snapshots for exact
  restore. ✅
- **Q5 restore UX** → **reuse** the States-section stack via `AppCustomSection`. ✅
- **Formula handling** → no engine, no flatten; preserve live + formula-cell
  guard + label; AI/Skills recompute. ✅
- **Engine** → **hucre** (host-side TS), fallback `@protobi/exceljs`. ✅
- **PNG extraction** → dropped. ✅

## 11. Implementation phases

- **Phase 0 — Spikes (gate the effort):**
  - **S1**: Extract `SnapshotArchiveService` from `SkillWriteService`; assert
    byte-identical archive output (no Skills behavior change).
  - **S2 (hucre evaluation) — partially DONE 2026-05-31**
    (`spike-findings-hucre-2026-05-31.md`): ✅ byte-intact preservation of an
    unmanaged part through a data-cell edit; ✅ bundle measured (302 KB xlsx-only
    → **vendor as runtime asset**, not in main.js); ✅ headless API confirmed.
    **Remaining**: enumerate the 8/135 unsupported features + confirm the §6
    pre-scan refuses them; real-world chart/pivot/conditional-format fidelity
    pass; Electron asset-load path; pin the (pre-1.0) version.
- **Phase 1** — Mirror generation (hucre read → sharded values-CSV + manifest).
- **Phase 2** — Lossless write-back (`applyToWorkbook`) — hucre apply, formula
  guard, `dryRun`, snapshot-then-replace, re-projection.
- **Phase 3** — Event log (JSONL + v14 SQLite table) + history/restore UI (§8).
- **Phase 4** — Conflict/divergence policy (§7) + settings.

Event-log/conflict/UI are deferred behind a working write-back so we don't build
audit/restore for a path that hasn't proven out in Obsidian.

## 12. Risks

- **`hucre` is pre-1.0 (v0.6.0)** — API churn + maturity risk; pin the version,
  gate adoption on spike S2, keep `@protobi/exceljs` as fallback.
- **Silent loss on an unsupported feature** if the §6 pre-scan misses one of
  hucre's 8 gaps — spike S2 must enumerate them.
- **Bundle budget** — measured (S2): `hucre/xlsx` is 302 KB vs ~218 KB headroom,
  so it is **vendored as a runtime asset**, not bundled. Residual: confirm the
  Electron asset-load path (same caveat as Pyodide assets).
- **Divergence corruption** if the §7 conflict guard is skipped.
- **Scope creep** — three independently useful pieces (SnapshotArchiveService,
  event log, mirror+apply). Phase-0 spikes gate Phases 1–4.
- **Verified by unit/spike only** until manually exercised in Obsidian desktop.

## Sources (research, 2026-05-31)

- [hucre — zero-dep TS spreadsheet engine, chart round-trip](https://github.com/productdevbook/hucre)
- [xlsx-populate — surgical XML editing (unmaintained since 2019)](https://github.com/dtjohnson/xlsx-populate)
- [ExcelJS #2607 — charts dropped on round-trip](https://github.com/exceljs/exceljs/issues/2607)
- [openpyxl tutorial — charts/images lost on save](https://openpyxl.readthedocs.io/en/stable/tutorial.html)
