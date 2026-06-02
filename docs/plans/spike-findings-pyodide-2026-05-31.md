# Phase 0 Spike Findings — Pyodide Data Analysis App

**Date**: 2026-05-31
**Branch**: `claude/nexus-sandboxed-execution-SjoDA`
**Pyodide version**: 0.29.4 (Python 3.13, `pandas` 2.3.3, `numpy` 2.2.5, `openpyxl` 3.1.5)
**Where run**: Node 22 (headless Linux container). See "Validity & caveats" for what this
does and does NOT prove vs. a real Electron Web Worker.

**Verdict: GO.** Every high-risk item the spike was meant to kill came back green —
the security lockdown holds, real pandas + Excel work, delivery is ~21MB and works
fully offline. Remaining unknowns are browser-worker-specific and low-risk.

---

## 1. What was validated (results)

### Security lockdown — the crux (core spike)
The make-or-break for Pyodide is that it is **not** caged by default (the `js`
bridge proxies the host global scope). The planned mitigation — scrub network
globals after load, before user code — was tested directly:

| Check | Result |
|---|---|
| Python sees `js.fetch` **before** scrub | `REACHABLE` |
| Python sees `js.fetch` **after** scrubbing host `fetch`/`XHR`/`WebSocket` | `undefined` — **BLOCKED ✓** |
| Guest reads real host disk (`/home/user/nexus/package.json`) via `os.path.exists` | `isolated` — **no leak ✓** (default FS is in-memory MEMFS) |
| 8,432-row result vs `maxRows=1500` guardrail | **REJECTED ✓** with the aggregate-or-limit message |
| 3-row result vs cap | passed ✓ |

→ The "worker + no Node + scrubbed network + MEMFS-only" lockdown is mechanically sound.

### Real pandas + Excel (pandas spike)
| Step | Result | Time |
|---|---|---|
| `pd.read_csv` (injected bytes) + `groupby` + `pivot_table` | correct output | ~2.9s (first pandas call, includes import warmup) |
| **`pd.read_excel` round-trip** (pandas writes `.xlsx` via openpyxl, reads it back) | correct revenue-by-product | **~0.5s** |
| DataFrame → JS records marshalling (`.to_dict('records')` → `.toJs`) | `rows=6`, clean JS objects | **7ms** |

→ The exact `runAnalysis` data path — host injects bytes into MEMFS → pandas reads →
compute → marshal JSON back — works end to end for **both CSV and Excel**.

### Timings (Node; treat as ballpark for Electron)
| Phase | Time |
|---|---|
| Core runtime cold-start | ~1.7s |
| `loadPackage(pandas + numpy + deps)` from local | ~1.1s |
| `micropip` install openpyxl from local | ~0.4s |
| **Total cold-start w/ pandas + Excel ready** | **~3.3s** |
| Warm re-run (runtime hot) | 7–9ms |

→ Confirms the "seconds of cold-start" assumption. Mitigation: load lazily on first
use behind a one-time Notice; keep the runtime warm across runs.

---

## 2. Delivery — measured sizes, and a correction

Real, measured first-load footprint (none of this touches the 5MB `main.js` —
delivered out-of-band exactly like `sqlite3.wasm`):

| Asset | Size |
|---|---|
| Core: `pyodide.asm.wasm` | 8.6 MB |
| Core: `python_stdlib.zip` | 2.4 MB |
| Core: `pyodide.asm.js` + loader | ~1.1 MB |
| `pandas` wheel | 4.3 MB |
| `numpy` wheel | 2.7 MB |
| `python-dateutil` + `pytz` + `six` | ~0.7 MB |
| `micropip` + `packaging` | ~0.2 MB |
| `openpyxl` + `et_xmlfile` | ~0.27 MB |
| **Total first-load** | **≈ 21 MB** (matches the plan's ~20–25MB estimate) |

**Correction to the plan's package set:** `openpyxl` (and its dep `et_xmlfile`) are
**not** in the Pyodide distribution — they're pure-Python, installed via **`micropip`**.
So Excel support requires shipping/availability of **`micropip` + `packaging` +
`openpyxl` + `et_xmlfile`** in addition to `pandas`. The plan's "package set" and
"delivery" sections are updated accordingly.

**Offline vendoring is proven.** In this sandbox the jsDelivr CDN was blocked
(`host_not_allowed`), so all assets were sourced **without the CDN**:
- Core runtime: the `pyodide` **npm package** (13 MB) — bundles wasm + stdlib + loader.
- Compiled wheels (pandas/numpy/…): the **GitHub release tarball** `pyodide-0.29.4.tar.bz2`.
- Pure-Python wheels (openpyxl/et_xmlfile): **PyPI** (`files.pythonhosted.org`).

This directly validates the plan's **§3 v2 local-vendoring** delivery path: we can
ship/cache a curated wheel set into the plugin folder and run **100% offline** via a
local `indexURL` — a stronger story than CDN-only. In the user's real Obsidian
environment the CDN is normally reachable for the simpler v1 lazy-load path.

---

## 3. Validity & caveats — what still needs an Electron check

This spike ran in **Node**, which is itself not a sandbox (Node has `fs`/`require`).
What it proves is the **mechanisms**, which are environment-independent:
- the `js`-bridge network scrub kills the network capability ✓
- MEMFS does not expose real disk by default ✓
- the inject → compute → marshal → row-cap data-flow is correct for CSV **and** Excel ✓
- delivery sizes/timings and offline vendoring ✓

**Still to validate in a real Electron/browser Web Worker (low risk, but required
before shipping):**
1. **Worker isolation in Electron** — confirm a Worker has no Node integration
   (`nodeIntegrationInWorker` off) so `require`/`fs`/`child_process` are truly absent.
2. **`worker.terminate()` timeout** — kill a runaway `while True:` deterministically
   (can't terminate the main-thread runtime in a Node CLI; this is the proper mechanism).
3. **Memory hard-cap** — configure max WASM memory so a memory bomb throws; confirm
   teardown is a clean backstop.
4. **Local `indexURL` wiring in Electron** — serve the vendored wheels to the worker
   (file:// vs feeding bytes); confirm offline load.

---

## 4. Plan deltas applied

- §2/§9: cold-start measured (~3.3s with pandas+Excel); warm runs <10ms.
- §3: real sizes (~21MB); openpyxl/et_xmlfile need micropip+packaging; offline
  vendoring confirmed; CDN (v1) vs local-vendor (v2) both viable.
- Open questions: default caps confirmed reasonable; package set finalized as
  `pandas, numpy, (deps), micropip, packaging, openpyxl, et_xmlfile`.
- Remaining Phase-0 follow-ups narrowed to the four Electron-worker items above.

## 5. Reproduction
The spike scripts are **not committed** (`docs/plans/*` is gitignored for non-`.md`
files). To reproduce in a scratch dir:
1. `npm i pyodide@0.29.4` (core runtime + loader, ~13MB).
2. Compiled wheels (pandas/numpy/deps/micropip/packaging): extract from the GitHub
   release tarball `pyodide-0.29.4.tar.bz2` into the package dir.
3. Pure-Python wheels (openpyxl/et_xmlfile): download from PyPI.
4. In Node: `loadPyodide()` → `loadPackage(['pandas','micropip'])` →
   `micropip.install(['emfs:/…openpyxl…whl'], false)`; inject CSV/XLSX bytes via
   `pyodide.FS.writeFile`; run pandas; assert the network scrub
   (`import js; js.fetch` → `undefined`) and the Python marshaller (NaN→null,
   datetime→iso, int64→number). All asset filenames/URLs are pinned in
   `src/agents/apps/dataAnalysis/services/PyodideEnsurer.ts`.
