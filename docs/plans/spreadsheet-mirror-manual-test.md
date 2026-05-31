# Spreadsheet Mirror + Write-back — Manual Test Guide (Obsidian desktop)

What to run once the branch is built/deployed into a real Obsidian desktop vault.
Everything below the unit layer (hucre download + Blob-import, real `.xlsx`
parsing, vault binary write) is **first-run validation** — it has not executed
outside the headless test container.

## 0. Build + deploy

```
npm run build          # main.js ~4.79MB (<5MB); hucre is NOT bundled
```
Copy `main.js` + `manifest.json` + `styles.css` into
`<vault>/.obsidian/plugins/nexus/` (or `npm run deploy`). Reload Obsidian.

## 1. Enable the app

Settings → **Apps** → enable **Data Analysis** (desktop-only). It exposes four
tools: `runAnalysis`, `listCapabilities`, **`mirrorWorkbook`**, **`applyToWorkbook`**.

## 2. First-run engine download (the riskiest new path)

The first `mirrorWorkbook`/`applyToWorkbook` call triggers a one-time download of
the hucre engine (~300 KB) from esm.sh into
`.obsidian/plugins/nexus/hucre/hucre-xlsx.mjs`, then loads it via a Blob-URL ESM
import. **Verify:**
- A Notice "Setting up the spreadsheet engine — downloading once…" appears, then
  "Spreadsheet engine ready."
- The file lands in the `hucre/` folder and is ~300 KB.
- ❗ If the load fails, the likely culprits are (a) esm.sh `?bundle` not producing a
  self-contained file, or (b) Electron CSP blocking the Blob import. Fallbacks:
  pre-vendor the file manually, or switch the load to `file://` import.

## 3. Mirror a workbook

Put a real `budget.xlsx` (multiple sheets, some **formulas**, ideally a **chart**)
in the vault. Ask the AI (or call the tool) `mirrorWorkbook { path: "budget.xlsx" }`.

**Expect:** `<Nexus root>/spreadsheets/budget/` containing `manifest.json` and
`<Sheet>.part0.csv` per sheet. Check:
- Sheet order + `rowCount`/`colCount` look right.
- `manifest.sheets[].formulaCells` is **non-empty** for sheets with formulas
  (this proves the XML formula-scan works → the write-back guard is active).
- A large sheet (>`maxShardBytes`, default per Settings → Data) splits into
  `.part0/.part1/…` with contiguous row ranges.
- Re-running mirror on the unchanged file reports `regenerated: false`.

## 4. Edit + write back

Edit a **data** cell in a `.partN.csv` (e.g. change an amount). Then
`applyToWorkbook { path: "budget.xlsx", dryRun: true }` → review the summary
(`cellsApplied`, sample before→after, `cellsBlocked`). Then run without `dryRun`.

**Expect:**
- The `.xlsx` updates with your value, and — critically — **the chart and all
  formatting survive** when you open it in Excel. (This is the whole point of
  hucre vs openpyxl.)
- A snapshot appears under `spreadsheets/budget/_archive/<ts>/`.
- The mirror re-projects (manifest `sourceHash` changes; CSVs reflect the new state).
- ❗ Open the file in Excel and confirm formulas downstream of your edit
  **recalculate** (hucre writes values, Excel recalcs on open).

## 5. Guard checks

- **Formula guard:** edit a cell that `manifest.formulaCells` lists → `applyToWorkbook`
  should report it under `cellsBlocked`/`blockedFormulaCells` and NOT overwrite it.
- **Divergence guard:** edit `budget.xlsx` directly in Excel after mirroring, then
  `applyToWorkbook` → expect `reason: "divergence"` (refused). `force: true` overrides.
- **No-op:** apply with no CSV edits → `reason: "no-changes"`.

## 6. Known gaps to watch (from the plan §11/§12)

- **Sheet→worksheet-part mapping** is the sorted-Nth `sheetN.xml` approximation.
  On a multi-sheet workbook, confirm edits land on the RIGHT sheet and the right
  sheet's formulas are detected. If not, the precise fix is workbook-rels mapping.
- **`.xlsm`/macros:** a macro workbook should keep working; confirm the write-back
  doesn't corrupt it (hucre flags `hasMacros`).
- **hucre's 8/135 unsupported features:** if a workbook uses one, the write-back may
  not round-trip it — the plan calls for a pre-scan refusal (not yet implemented).
  For now, eyeball exotic workbooks after write-back.

## 7. What's already proven (don't re-test)

Headless unit tests cover: CSV (de)serialization + sharding, mirror generation
(idempotency, stale-shard cleanup sparing `_archive/`, name collisions), the diff
+ formula-guard + coercion, the write-back orchestration (apply/dryRun/divergence/
no-op/snapshot/re-project), the formula-cell XML scan, and hucre's byte-intact
preservation of an unmanaged part (spike S2). The manual pass is specifically about
the **Electron-bound edges**: engine download/load, real `.xlsx` fidelity, and the
vault binary write.
