# Spreadsheet Mirror + Versioning — Implementation Plan

Status: DRAFT (design, pre-spike). Owner: TBD. Created 2026-05-31.
Companion to `docs/plans/sandboxed-code-execution-app-plan.md` (the Data Analysis app this builds on).

## 1. Goal

Let the AI clean / normalize / pattern-edit spreadsheet data on a plain-text
surface, and have those edits flow back into the real `.xlsx` **without
destroying the things CSV can't represent** (formulas, number formats, multi-sheet
structure). Add CRUA-faithful version history so every edit is reversible and
queryable.

The workflow we're enabling, end to end:

1. AI reads a spreadsheet (already works — Data Analysis app).
2. AI cleans / normalizes a cell range or pattern match in pandas.
3. Edits are applied back to the workbook **as deltas**, preserving untouched
   formulas/formatting.
4. Every apply leaves a restore point + an audit trail.

### Non-goals

- Not a live two-way Excel sync. The mirror is generated/regenerated; Excel is
  not assumed to be edited concurrently (see §7 conflict policy).
- Not preserving charts/images/pivots/VBA through a write-back (openpyxl drops
  them — see §6). We **detect and refuse** rather than silently destroy.
- Not mobile. The xlsx legs are desktop-only (Pyodide/openpyxl), same gate as
  the Data Analysis app.

## 2. What we already have (de-risking)

- **openpyxl + et_xmlfile are already vendored** by `PyodideEnsurer.ts` (fetched
  as wheels, offline micropip-installed from the local `indexUrl`). The xlsx
  read/write engine is in the runtime today — **zero new asset work.**
- **Pyodide + pandas** loaded offline from a `file://` indexURL.
- The network-scrubbed worker already has a micropip-init allowlist
  (`pyodideWorkerSource.ts`) that closes after package install.
- **`archiveThenReplace`** (version-in-place snapshot) exists in
  `SkillWriteService` — the primitive we'll extract (§4).
- **Hybrid JSONL→SQLite** storage with per-entity event tables (states, tasks) —
  the pattern the event log reuses (§5).

## 3. Architecture

### 3.1 Folder-per-workbook mirror

One workbook → one mirror folder (multi-sheet forces a container):

```
budget.xlsx                          ← the real artifact, RETAINED as fidelity anchor
<mirror-root>/budget/
  manifest.json                      ← sheet order, source hash, per-cell type sidecar
  Sheet1.csv                         ← values only — the AI's edit + analysis surface
  Sheet2.csv
  _archive/
    Sheet1.<ts>.csv                  ← snapshots (shared SnapshotArchiveService, §4)
```

- `manifest.json` is load-bearing: CSV files are an unordered set, so it records
  **sheet order**, the **source `.xlsx` content hash** (divergence detection, §7),
  and a lightweight **per-cell type sidecar** for fidelity (§6.3).
- **Mirror-root location**: default to a hidden plugin-data subfolder (avoids
  vault clutter and Excel-opens-the-csv confusion); configurable. Decision
  deferred to spike — see §10 Q1.

### 3.2 The CSV is the value surface; the xlsx is the formula store

This is the core decision and it resolves the "can we keep formulas in the CSV?"
question. **No** — a single CSV grid can hold either the formula text or the
computed value per cell, never both, and the formula text isn't analyzable. So:

- **CSV = values only** → the AI can analyze/normalize numerically.
- **Original `.xlsx` = formula/format store** → retained, never thrown away.
- **Sync = delta-apply**: only the cells the AI *changed* are written into the
  original workbook. Untouched cells (including all formulas/formatting) are
  preserved automatically because openpyxl rewrites them verbatim on save.

Cells the AI changed get the new literal value (correct — a normalized constant
overwrites whatever was there). Cells it didn't touch keep their formula.

### 3.3 Data flow

```
xlsx ──openpyxl(read)──▶ values CSVs + manifest (mirror)        [generate/refresh]
CSVs ──AI edits (CRUD / Data Analysis app)──▶ edited CSVs        [edit]
edited CSVs ─diff vs mirror─▶ changed-cell set                   [diff]
changed-cell set ──openpyxl(load original, set cells, save)──▶ xlsx   [sync / write-back]
                  + snapshot prior xlsx + CSV  (§4)
                  + append spreadsheet_edit events (§5)
```

The **single guarded boundary** is the sync step. Everything funnels through it,
and it's where all the guardrails (§6) live.

## 4. DRY archive — extract `SnapshotArchiveService`

The repo has **three distinct things named "archive"** (verified by grep):

| Flavor | Semantics | Where today | Convention |
|---|---|---|---|
| Soft-archive **flag** | reversible `isArchived` status, entity stays | states/workspaces/prompts/tasks/skills (99 refs) | a flag, not files |
| **Relocate**-archive | **moves** note/folder out | `StorageManager.archive` tool | `.archive/<ts>/<path>` |
| **Version-in-place** | **copies** prior bytes, live file stays | `SkillWriteService.archiveThenReplace` | `_archive/<name>.<ts>` |

- The **soft-flag** archive is a repository/event convention, not extractable
  code — do NOT unify it (would be the wrong abstraction; cf. the CLAUDE.md
  ToolManager-bridge pin: don't extract speculatively).
- **Spreadsheet versioning needs version-in-place** (the live CSV/xlsx stays;
  snapshot the prior state). That's the `archiveThenReplace` semantics.

**The DRY move** (triggered now because spreadsheets are the *second* consumer):

1. Extract a shared `SnapshotArchiveService` from `SkillWriteService`:
   `archiveCopy(path, { archiveDir, timestampFn, hashFn })` — copies current
   bytes to a timestamped archive destination, ensures the dir.
2. Optionally expose `archiveMove(path, ...)` over the same primitive so
   `StorageManager.archive` *could* share the dir/timestamp helper — but keep
   each consumer's **convention** (`.archive/<ts>/` vs `_archive/<name>.<ts>`),
   since those paths are observable behavior. Move-vs-copy stays explicit.
3. Rewire Skills to the shared service with **no behavior change** (Phase 0
   spike asserts byte-identical archive output).

## 5. Versioning — snapshot + event log (complementary, not redundant)

Two layers, both CRUA-faithful (archive = soft/reversible; nothing auto-hard-deletes):

- **Snapshot archive** (`SnapshotArchiveService`, §4): coarse, byte-exact restore
  points of the prior xlsx (and/or CSV) before each apply. Restore = un-archive.
- **Event log**: fine-grained `spreadsheet_edit` events
  `{ workbook, sheet, range|pattern, before, after, ts, hash }`.
  - **JSONL = source of truth** (append-only, matches tasks/states).
  - **Mirrored into a new SQLite table** for query ("every edit to Sheet1 this
    week"). This is a **v14 migration + one table** — not new infrastructure.

Snapshot answers "put it back"; event log answers "what changed and when".

## 6. Fidelity findings + guardrails (from research, 2026-05-31)

### 6.1 What openpyxl load→save preserves
Cell values, **formulas** (default; `data_only=False`), styles, number formats,
comments, hyperlinks, sheet dimensions/properties. → delta-apply is safe for these.

### 6.2 What openpyxl load→save **destroys** — HARD GUARDRAIL
**Charts, images, shapes** are dropped on save. Pivot tables, rich text
(unless `rich_text=True`), and VBA (unless `keep_vba=True`, and then not editable)
are also lossy. → **Pre-scan the original workbook before write-back**
(`ws._charts`, `ws._images`, `wb.vba_archive`, pivot caches). If any are present,
**refuse the silent write-back** and require explicit `acknowledgeLossy: true`
(or write to a new file). We never silently destroy a user's charts.

### 6.3 Type fidelity (CSV round-trip)
pandas/CSV coerces types (leading-zero ZIPs, dates, big ints, NaN). Mitigations:
- Mirror generation records each cell's **original type** in the manifest sidecar.
- On apply, a changed cell is written **preserving the original cell's data type
  where the new value is compatible** (e.g. keep a ZIP as text), else inferred.
- Spike to validate (§10 Q2).

### 6.4 Recalc staleness
openpyxl writes values but does **not** evaluate formulas, so a formula
downstream of an edited cell holds a stale cached result. Mitigation: set
`workbook.calculation.fullCalcOnLoad = True` on save → Excel recomputes on open.

## 7. Sync / conflict policy

- Mirror carries the **source `.xlsx` hash** in its manifest.
- Before generating/refreshing the mirror or applying a write-back, compare the
  current xlsx hash to the stored one.
  - Match → safe to proceed.
  - Mismatch (user edited the xlsx in Excel since last mirror) → **do not blind
    last-writer-wins**. Surface the divergence; offer re-mirror (discard CSV
    edits) or refuse pending user choice. Spreadsheets are higher-stakes than
    the Skills mirror, so default to **warn + require explicit resolution**.
- One writer at a time through the sync boundary (serialize, like `runAnalysis`).

## 8. Tool contracts (draft)

Likely additive to the Data Analysis app (desktop-only), final shape TBD:

- `mirrorWorkbook({ path })` → generates/refreshes the folder-per-workbook mirror;
  returns sheet list + manifest summary. Idempotent (hash-gated).
- `applyToWorkbook({ workbook, sheets?, dryRun?, overwrite?, acknowledgeLossy? })`
  → diffs edited CSVs vs mirror, delta-applies to the retained xlsx via openpyxl,
  snapshots + logs events. `dryRun` returns the change summary (cells changed,
  before→after samples, lossy-content warnings) without writing.
- History/restore surfaced via existing CRUA patterns + the event log.

`dryRun` default-on for the first apply of a session is under consideration
(overwriting a workbook is hard to reverse).

## 9. Platform

Desktop-only for all xlsx legs (Pyodide/openpyxl). The values-CSV editing surface
could be cross-platform via CRUD, but mirror generation and write-back are gated
behind `isDesktop()`, consistent with the Data Analysis app.

## 10. Open questions for review

- **Q1 — Mirror location**: hidden plugin-data subfolder (clean, but invisible to
  the user) vs co-located beside the xlsx (visible/syncable, but clutters the
  vault and risks the user opening the CSV by mistake). Lean: plugin-data,
  configurable.
- **Q2 — Type fidelity depth**: is the per-cell type sidecar enough, or do we need
  a richer typed-cell manifest? Spike with a ZIP/date/bigint-heavy sheet.
- **Q3 — Lossy-content default**: refuse-by-default vs write-to-copy-by-default
  when charts/images/pivots are present.
- **Q4 — Event-log granularity**: per-cell events (precise, verbose) vs
  per-range/per-operation events (compact, coarser audit).
- **Q5 — Restore UX**: reuse the States-style management UI, or a dedicated
  spreadsheet-history view?

## 11. Implementation phases

- **Phase 0 — Spikes (gate the whole effort):**
  - **S1**: Extract `SnapshotArchiveService` from `SkillWriteService`; assert
    byte-identical archive output (no Skills behavior change).
  - **S2**: openpyxl-in-Pyodide round-trip — load a formula-bearing, multi-sheet,
    formatted workbook; delta-apply a value edit to a formula's dependency cell;
    save; confirm (a) untouched formulas/formats survive, (b) charts/images
    detection works, (c) `fullCalcOnLoad` triggers recalc, (d) type fidelity on
    ZIP/date/bigint cells.
- **Phase 1** — Mirror generation + manifest + values-CSV (`mirrorWorkbook`).
- **Phase 2** — Delta-apply write-back (`applyToWorkbook`) with `dryRun`, lossy
  guardrails, `fullCalcOnLoad`, snapshot-then-replace.
- **Phase 3** — Event log (JSONL + v14 SQLite table) + history/restore surface.
- **Phase 4** — Conflict/divergence policy (§7) + settings/UI.

Event-log and conflict policy are deferred behind a working write-back so we
don't build audit/restore for a path that hasn't proven out in Obsidian.

## 12. Risks

- **Silent fidelity loss** if the lossy-content guardrail (§6.2) is incomplete —
  highest-severity risk; must be spike-validated against real workbooks.
- **Divergence corruption** if conflict policy (§7) is skipped — blind
  last-writer-wins could clobber Excel edits.
- **Scope creep** — this is a subsystem (3 independently useful pieces:
  SnapshotArchiveService, event log, mirror+apply). Phase 0 spikes must pass
  before committing to Phases 1-4.
- **Verified by unit/spike only** until manually exercised in Obsidian desktop
  (same caveat as the Data Analysis app's Electron-runtime items).

## Sources (fidelity research)

- [openpyxl tutorial — what is preserved/lost on save](https://openpyxl.readthedocs.io/en/3.1/tutorial.html)
- [openpyxl users — keeping style/format when editing](https://groups.google.com/g/openpyxl-users/c/eZ2HfCLPrJo)
- [openpyxl data_only / cached formula values](https://groups.google.com/g/openpyxl-users/c/TWbBZjLj8Q0)
- [openpyxl workbook.properties — CalcProperties / fullCalcOnLoad](https://openpyxl.readthedocs.io/en/3.1/api/openpyxl.workbook.properties.html)
