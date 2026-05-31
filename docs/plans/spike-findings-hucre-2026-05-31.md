# Spike Findings — `hucre` as the lossless xlsx write-back engine (2026-05-31)

Companion to `docs/plans/spreadsheet-mirror-versioning-plan.md` (§3.5, §11 S2).
Spike run headless in Node 22 against `hucre@0.6.0` in a throwaway dir (the repo
`package.json`/lock were **not** touched).

## Verdict: GO — with hucre vendored as a runtime asset (not bundled into main.js)

## 1. Bundle size (measured via esbuild, minified, `--platform=browser`)

| Entry | Minified | Gzip |
|---|---|---|
| `hucre/xlsx` (only what we need) | **308,714 B (~302 KB)** | 84,982 B |
| `hucre` (full) | 416,245 B | 118,180 B |

Current `main.js` = 4,776,436 B → **headroom to 5,000,000 B is only 223,564 B (~218 KB).**
The xlsx-only entry (302 KB) **exceeds headroom by ~85 KB**, so it **cannot be
bundled into main.js**. In a single-file Obsidian CJS build even a dynamic
`import()` is inlined, so lazy-import does NOT help.

**Decision: vendor hucre as a runtime asset**, the same pattern the Data Analysis
app uses for Pyodide (`PyodideEnsurer`/`PyodideAssets`): ship/load the prebuilt
`hucre/xlsx` bundle as a separate file loaded at runtime (desktop-gated). Cost in
main.js ≈ 0. Package facts: MIT, **zero runtime deps**, ESM, `unpackedSize`
2.79 MB (all formats — irrelevant once we vendor only the xlsx bundle).

## 2. Lossless preservation — EMPIRICALLY VALIDATED

Test: created a workbook with `writeXlsx`, injected a sentinel unmanaged part
`xl/charts/chart1.xml` via jszip (stand-in for a chart/drawing), then
`openXlsx → edit a data cell (100→999) → saveXlsx`, and re-inspected:

```
_rawEntries has chart part?      true
chart part preserved byte-identical: true
data cell EMEA amount now:        999  (expected 999)
VERDICT: PASS — lossless edit + chart preserved
```

Mechanism (confirmed in the type defs and at runtime):
- `openXlsx(bytes) → RoundtripWorkbook` carries **`_rawEntries: Map<path, bytes>`**
  (every original ZIP part) + **`_modifiedParts: Set<path>`** + original
  `_contentTypes`/`_rootRels` + a `hasMacros` flag.
- `saveXlsx(wb)` regenerates **only** the parts in `_modifiedParts`; everything
  else is written back from `_rawEntries` **byte-for-byte**. Charts/images/pivots/
  drawings survive because we never rebuild them.

## 3. API notes for the write-back implementation

- Public surface: `import { openXlsx, saveXlsx, readXlsx, writeXlsx } from 'hucre/xlsx'`.
- `openXlsx`/`saveXlsx` take/return `Uint8Array` → trivial to wire to vault binary
  read/write host-side.
- **Important: editing `sheet.rows[r][c]` does NOT auto-mark the part dirty.** The
  write-back must explicitly `wb._modifiedParts.add('xl/worksheets/sheetN.xml')`
  for each sheet it changed. This fits our delta model (we already know which
  sheets/cells changed) but must be done deliberately.
- **VBA/macros**: `hasMacros` true → output is XLSM content types; save with
  `.xlsm`. The guard/write path must honor the original extension.
- Runs headless in Node 22 (CompressionStream) → write-back is **unit-testable
  without Electron**.

## 4. Still open (needs real workbooks / Electron, not blocking the GO)

- **Enumerate the 8/135 unsupported features** and confirm the pre-scan guard
  (plan §6) refuses them rather than dropping silently. (This spike validated the
  *preservation* path for an unmanaged part; it did not enumerate the gaps.)
- Real-world fidelity pass on actual chart/pivot/conditional-formatting workbooks.
- Confirm the vendored-asset load path works in the Electron renderer (mirrors the
  Pyodide-asset Electron caveat).
- Pin `hucre` at a known version (pre-1.0; expect API churn).

## Reproduction

Throwaway dir, `npm i hucre@0.6.0`; esbuild the `hucre/xlsx` entry minified for
size; round-trip script uses `writeXlsx` + jszip-injected sentinel part +
`openXlsx`/`saveXlsx`/`readXlsx`. (Scripts not committed — gitignored spike dir.)
