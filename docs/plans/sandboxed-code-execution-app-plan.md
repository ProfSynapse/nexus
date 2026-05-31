# Sandboxed Data Analysis App — Implementation Plan

**Status**: Proposed (design blessed, pre-implementation)
**Branch**: `claude/nexus-sandboxed-execution-SjoDA`
**Author**: design session 2026-05-31
**Type**: New app agent (`src/agents/apps/dataAnalysis/`) — **desktop-only**

---

## 1. Goal

A **Data Analysis app**: the user (or the AI) writes **Python** that runs against
**CSV and Excel (`.xlsx`)** data from the vault, using the real **pandas** stack,
inside a sandbox that **cannot break out** — no host filesystem, no network, no
Obsidian API, no process spawning. Data goes *in*, a bounded result comes *out*.

Canonical flows:
- "What's the average spend by category in `budget.csv`?"
- "In `Q3.xlsx`, pivot revenue by region and month."
- "Reconcile `a.csv` and `b.csv` — which IDs are missing from each?"

Ships as an **app agent** (`BaseAppAgent`), toggleable from Apps settings,
registered through the existing `AppManager` → `registerDynamicAgent` →
ToolManager flow like `ComposerAgent`/`WebToolsAgent`.

### Platform: desktop-only (decided 2026-05-31)

Precedent exists — ingestion, composer, and web-tools are already desktop-only.
This unlocks Pyodide/pandas without the mobile-weight risk (§3). The app must
**not register or load anything on mobile**; tools guard with `isDesktop()`
(as `webTools/.../captureToMarkdown.ts:48` does), and all Pyodide imports are
lazy so module init never touches Node/heavy code on a phone.

### Non-goals

- **No vault API inside the sandbox.** The guest never touches `vault.*`. The
  *host* reads the file and writes its bytes into the sandbox's in-memory FS.
- **No network inside the sandbox.** Network globals are scrubbed before any
  user code runs (§4).
- **No "call other Nexus tools" bridge.** Pure analysis. Compose with other
  agents at the edges (read → analyze → present).
- **No *user-driven* runtime package installation.** A fixed, preloaded package
  set: `pandas` + `numpy` (+ `python-dateutil`/`pytz`/`six` deps) loaded via
  `loadPackage`, plus `openpyxl` + `et_xmlfile` installed once at startup via
  `micropip` (+ `packaging`) — see Phase 0 findings: openpyxl is pure-Python and
  not in the Pyodide distribution. No *user* `micropip`/`loadPackage` at runtime.

---

> **Phase 0 spike (2026-05-31): GO.** Validated with Pyodide 0.29.4 / pandas 2.3.3 /
> openpyxl 3.1.5 — network-scrub lockdown blocks `js.fetch`, MEMFS isolates the host
> disk, real `read_csv` + `read_excel` round-trip works, marshalling + 1500-row cap
> work, ~21MB first-load, ~3.3s cold-start, and **fully offline vendoring** confirmed
> (CDN was blocked; sourced from npm + GitHub release + PyPI). Full results:
> `docs/plans/spike-findings-pyodide-2026-05-31.md`. Remaining checks are
> Electron-worker-specific (terminate-timeout, memory cap, no-Node-in-worker).

## 2. Engine decision: Pyodide + pandas

### How we got here (recorded so review doesn't relitigate)

1. **Native Electron execution** (`eval`/`vm`/`Function`) — rejected: runs in the
   plugin's own realm → instant total breakout; Node's `vm` is explicitly not a
   security boundary; all `undefined` on mobile.
2. **QuickJS-in-WASM + JS libs (Arquero/SheetJS)** — strong: caged-by-default,
   light (~1MB), mobile-safe. Rejected as primary **because** the app is now
   framed as *data analysis* with Excel, and pandas' ergonomics/robustness for
   messy real-world spreadsheets decisively beat a hand-assembled JS dataframe
   stack — and desktop-only removes QuickJS's mobile/weight advantages.
3. **Pyodide + pandas** — chosen: the gold-standard data stack, first-class
   `read_csv`/`read_excel`, and (given desktop-only) its weight is acceptable.

| | QuickJS + JS libs | **Pyodide + pandas (chosen)** |
|---|---|---|
| Excel (.xlsx) | inject SheetJS (~800KB) | `pandas.read_excel` + openpyxl — first-class |
| Dataframes/pivot/join | Arquero (pure-JS) | pandas — gold standard, AI writes it fluently |
| Sandbox posture | caged by default | **caged by configuration** — must lock down (§4) |
| One-time download | ~1MB | **~20–25MB** (core + pandas/numpy/openpyxl), cached |
| Cold start | ms | **seconds** (runtime init + imports) |
| Mobile | fine | heavy/risky → **desktop-only** |

### ⚠️ The critical caveat: Pyodide is NOT sandboxed by default

Unlike QuickJS, Pyodide exposes a **`js` bridge** — Python can do
`import js; js.fetch(...)` and reach the host JS global scope. So isolation is
something we **build**, not something we get for free. §4 is therefore the most
important part of this plan; if it's done wrong, there is no sandbox.

---

## 3. WASM/asset delivery

Pyodide is not a single `.wasm` — it's `pyodide.asm.js` + `pyodide.asm.wasm` +
`python_stdlib.zip` + package wheels (pandas, numpy, openpyxl). It's designed to
load these from an `indexURL`.

**Build:** the Pyodide loader glue stays small in `main.js` (the heavy wasm/wheels
are never bundled, so the 5MB `main.js` ceiling is unaffected). `.wasm` loader is
already `file` in `esbuild.config.mjs:70`.

**Delivery (desktop-only → network-at-first-use is acceptable):**
- **v1 — lazy CDN load.** On first use, `loadPyodide({ indexURL: <jsDelivr,
  pinned version> })` and `loadPackage(['pandas','openpyxl'])`. Show a one-time
  "Setting up the Python data environment… (~20MB, happens once)" `Notice`,
  modeled on `WasmEnsurer`'s UX. Rely on Electron HTTP cache for subsequent runs.
- **v2 (follow-up) — vendor locally.** Use `desktopRequire('node:fs')` to cache
  the Pyodide files + wheels into `{plugin.manifest.dir}/pyodide/` on first run,
  then point `indexURL` at the local folder for offline/repeatable loads —
  the spirit of `WasmEnsurer` (check-exists → download-if-missing) extended to a
  directory of assets.

> **Spike item:** confirm the cleanest local-`indexURL` strategy in Electron
> (file:// vs reading bytes via fs and feeding the worker). v1 CDN load is the
> de-risking baseline; v2 is an enhancement, not a blocker.

---

## 4. Sandboxing Pyodide — the lockdown recipe

Because Pyodide isn't caged by default, confinement is an explicit construction:

1. **Run Pyodide in a dedicated Web Worker.** Separate realm, no DOM, and in
   Electron Workers have **no Node integration by default**
   (`nodeIntegrationInWorker` is off) — so no `require`, no `fs`,
   no `child_process` reachable from the worker.
2. **In-memory FS only.** Pyodide's default FS is MEMFS (in-memory), isolated
   from real disk. We **never mount NODEFS**. The host writes input bytes via
   `pyodide.FS.writeFile('/data/input.xlsx', bytes)`; Python file I/O stays
   inside the virtual FS. `open('/etc/passwd')` hits the VFS, not the disk.
3. **Scrub network globals after load, before user code.** Pyodide needs `fetch`
   during *load* (to pull packages). Immediately after `loadPackage` and before
   running any untrusted code, null out the worker's network surface:
   `self.fetch = self.XMLHttpRequest = self.WebSocket = self.importScripts =
   undefined`. Then `import js; js.fetch` resolves to `undefined` — no
   exfiltration path. (Also why runtime `loadPackage` is disallowed — it would
   need the very `fetch` we removed.)
4. **Timeout = `worker.terminate()`.** A runaway loop is killed deterministically
   by tearing down the worker (cleaner than an interrupt handler). The next run
   spins a fresh worker.
5. **Memory ceiling.** Configure a max WASM memory on the Pyodide Emscripten
   module so a memory bomb throws rather than growing unbounded. (Pyodide's hard
   cap is imperfect — document the residual risk; the worker teardown is the
   backstop.)
6. **Bounded I/O.** Input size cap (§6) before injection; output row cap (§6) on
   the returned value.

This is "caged by configuration" done deliberately — the worker boundary + no
Node + scrubbed network + MEMFS-only is the sandbox.

---

## 5. Architecture & data flow

```
User: "average spend by category in budget.csv"
        │
        ▼
runAnalysis tool (TRUSTED HOST, desktop-only)
  1. isDesktop() guard
  2. resolve inputPath via existing ContentManager + isValidPath()
  3. read file bytes in the host (vault stays host-side)
  4. ensure Pyodide worker is up (lazy first-use load + scrub, §3/§4)
  5. FS.writeFile('/data/<name>', bytes)  — inject data, not capability
  6. runPythonAsync(userCode) with a worker.terminate() timeout
  7. marshal result → enforce maxRows cap (§6) → JSON
        │
        ▼
Pyodide worker (UNTRUSTED GUEST) — no Node, no network, MEMFS-only
  import pandas as pd
  df = pd.read_csv('/data/budget.csv')      # or read_excel for .xlsx
  result = df.groupby('category')['amount'].mean().reset_index()
  result.to_dict(orient='records')           # → host
        │
        ▼
CommonResult { success, data: [...≤1500 rows...], logs, stats }
```

The guest's entire view of the world: the bytes the host placed in `/data/`,
the preloaded pandas/numpy/openpyxl, and a captured stdout. No vault, no
network, no host filesystem.

### File layout (mirrors `ComposerAgent`)

```
src/agents/apps/dataAnalysis/
  DataAnalysisAgent.ts          # BaseAppAgent; manifest (no creds); registers tools; desktop-only
  types.ts
  tools/
    runAnalysis.ts              # extends BaseTool; isDesktop() guard
    listCapabilities.ts         # (optional) advertise pandas/read_excel etc. to the AI
  services/
    PyodideSandbox.ts           # worker lifecycle, lockdown (§4), FS injection, marshalling
    pyodide.worker.ts           # the Web Worker entry: loadPyodide + scrub + run
    PyodideEnsurer.ts           # (v2) local vendoring of pyodide assets, WasmEnsurer-style
```

### Registration (one line + standard app wiring)

- `AppManager.getBuiltInAppRegistry()` (`src/services/apps/AppManager.ts:~229`):
  ```ts
  if (isDesktop()) registry.set('data-analysis', () => new DataAnalysisAgent());
  ```
- Flows through `AgentRegistrationService` Phase 3 → `syncToolManagerAgent` →
  `registerDynamicAgent`. Manifest declares **no credentials**.

---

## 6. Input & output caps

**Output row cap (your 1500-row guardrail).** JSONSchema validates inputs, not
computed outputs, so this is a **host-side guardrail on the returned value**,
documented in the tool description so the AI knows the rule up front:
- `maxRows` param, default **1500** (overridable to a hard ceiling).
- After the guest returns, if the result is a row collection > `maxRows` →
  **reject** with: *"Result has 8,432 rows (max 1500). Aggregate
  (groupby/pivot/describe) or add a filter/limit and re-run."*
- The error returns to the AI, which rewrites toward a **summary** — pushing
  every query toward aggregation instead of dumping rows into chat context.

**Input size cap.** A large file still has to fit the memory budget even if the
output is one number. Enforce a max input-bytes limit (e.g. ~10MB, configurable)
before injecting into the worker FS; reject oversized inputs with guidance to
pre-filter.

**Output persistence (optional).** Since the guest can't touch the vault, an
optional `outputPath` lets the **host** read a result back out of the worker FS
(or take the returned table) and write it to the vault post-run — enabling
"analyze the sheet **and save a report**" without granting the guest vault access.

---

## 7. `runAnalysis` tool contract

**Params** (`getMergedSchema` over common context fields):
| field | type | notes |
|---|---|---|
| `code` | string (required) | Python. Returns a JSON-serializable value (e.g. `df...to_dict('records')`). |
| `inputs` | `{ name: path }` map (optional) | host reads each via `isValidPath` + ContentManager, writes to `/data/<name>` in the worker FS. Supports multi-file (joins/reconcile). |
| `maxRows` | number (default 1500, hard max e.g. 10000) | output row guardrail (§6). |
| `maxInputBytes` | number (default ~10MB) | input size guardrail (§6). |
| `timeoutMs` | number (default ~5000, hard max ~30000) | worker-terminate budget. |
| `outputPath` | string (optional) | host writes the result/produced file to the vault post-run. |

**Result** (`CommonResult`):
```jsonc
{
  "success": true,
  "data": [ /* ≤ maxRows records, or a scalar/object */ ],
  "logs": ["...captured Python stdout..."],
  "stats": { "durationMs": 820, "rowsReturned": 12, "loadedFromCache": true }
}
```
On error/timeout/OOM/over-cap: `{ success: false, error: "<message + Python traceback>" }`.

**`getStatusLabel`**: `verbs('Analyzing data', 'Analyzed data', 'Analysis failed')`.

---

## 8. Threat model & confinement

| Vector | Mitigation |
|---|---|
| Read host filesystem | Worker has no Node; Pyodide FS is MEMFS-only; never mount NODEFS. |
| Path traversal on input | host validates `inputPath` via `isValidPath()` before read; guest can't request paths. |
| Network exfiltration (`import js; js.fetch`) | `fetch`/`XHR`/`WebSocket`/`importScripts` scrubbed from worker scope after load, before user code. |
| Spawn processes | no `child_process` reachable in a no-Node worker. |
| Runaway loop hangs UI | runs off the main thread; `worker.terminate()` at `timeoutMs`. |
| Memory bomb | max WASM memory configured; worker teardown as backstop. |
| Host-scope escape via `js` bridge | network scrubbed; no vault/Obsidian objects ever passed into the worker. |
| Output context blow-up | `maxRows` cap + input-bytes cap + truncation flags. |
| Mobile crash from heavy/Node code | desktop-only registration + `isDesktop()` guard + lazy imports. |

**Residual risks to document:** Pyodide's memory hard-cap is imperfect (teardown
is the backstop); CPU is bounded by wall-clock, not a fair scheduler; the `js`
bridge lockdown must be audited on every Pyodide version bump (a new global could
reintroduce a network path) — pin the version and re-verify the scrub on upgrade.

---

## 9. Implementation phases

**Phase 0 — Spike (de-risk before committing):**
- Stand up Pyodide in a Web Worker; `loadPackage(['pandas','openpyxl'])`; run
  `read_csv` and `read_excel` on injected bytes; prove `worker.terminate()`
  timeout; **prove the network scrub** (assert `import js; js.fetch` is dead).
  **Measure** first-load download size + cold-start time + warm-run time. Gate
  the rest on this.

**Phase 1 — Sandbox service:** `PyodideSandbox.ts` + `pyodide.worker.ts` —
lifecycle, lockdown (§4), FS injection, stdout capture, result marshalling,
traceback surfacing. Unit-tested.

**Phase 2 — Delivery:** v1 lazy CDN load with one-time Notice; confirm `main.js`
delta is small. (v2 local vendoring deferred.)

**Phase 3 — App + tool:** `DataAnalysisAgent` + `runAnalysis` (+ optional
`listCapabilities`), desktop-only registration, `inputs` host-read wiring,
`maxRows`/`maxInputBytes`/`outputPath` enforcement.

**Phase 4 — Tests & docs:** sandbox-escape tests (no network, no NODEFS,
traversal rejected, terminate kills loops), pandas CSV+Excel integration,
row-cap + input-cap behavior, desktop-only guard. Changelog + app doc.

---

## 10. Open questions for review

1. **Delivery UX** — is a ~20MB one-time CDN download (cached) acceptable for
   v1, or is local vendoring (v2) needed up front for offline users?
2. **Default caps** — `maxRows` 1500 / `timeoutMs` 5000 / `maxInputBytes` 10MB —
   tune?
3. **Package set** — pandas + numpy + openpyxl for v1. Add anything (e.g.
   `python-dateutil` is a pandas dep already; `xlrd` for legacy `.xls`)?
4. **Result conventions** — require user code to return a JSON-serializable value
   explicitly, or auto-`to_dict`/`json.dumps` a trailing DataFrame?
5. **Worker reuse** — keep a warm worker between runs (fast, but state could leak
   between analyses) vs fresh worker per run (clean, slower)? Leaning fresh-per-run
   for isolation, with the Pyodide *runtime* cached.

---

## 11. Why this fits Nexus

- **App, not base tool** — toggleable, dynamically registered, desktop-only like
  existing heavy apps; zero base-tool changes.
- **Reuses patterns** — `BaseAppAgent`/`BaseTool`, `isValidPath`, the
  `WasmEnsurer`/`desktopRequire` lazy-asset ethos, and the existing iframe/worker
  isolation precedent (transformers.js, `esbuild.config.mjs:93`).
- **Honestly sandboxed** — confinement is explicit and audited (worker + no Node
  + scrubbed network + MEMFS-only), not assumed. The vault is never exposed to
  the guest; the host mediates all I/O at the edges.
- **Real analysis power** — pandas + Excel, with a row-cap guardrail that keeps
  results summary-shaped and context-cheap.

---

## 12. Audit response (2026-05-31)

An adversarial audit reviewed the implementation. **Fixed in code** (host-side,
unit-tested):
- **Concurrency (was HIGH):** runs are now serialized through a queue — Pyodide
  isn't reentrant and the worker is reused; a timeout terminating the worker can
  no longer corrupt or hang a concurrent run.
- **Partial-install gate (was HIGH):** bootstrap now always runs the idempotent,
  per-file ensurer, so an interrupted download can't pass a `pyodide.js`-only
  presence check then fail at load.
- **Row-cap bypass (was HIGH):** added a universal serialized-byte output budget
  (default 512KB) on top of the row cap, so `{rows:[...]}` / `to_dict()` shapes
  can't dump unbounded data.
- **Marshalling (was HIGH):** results are now serialized **in Python** with a
  numpy/pandas/datetime-aware encoder (NaN→null, int64→number, Timestamp→iso),
  validated against those cases in a spike — no more BigInt throws or silent
  corruption.
- **Mediums:** index-prefixed input filenames (no silent overwrite on name
  collision), blob-URL revoked after init (not synchronously), worker init
  listener leak fixed, `/data` cleared per run, capability list derived from one
  constant.

**Security posture — the honest version (was the BLOCKER).** Pyodide is *not*
caged by default. The lockdown was hardened from a 4-name denylist to a
realm-wide scrub (delete network globals across `self`/`globalThis`/the prototype
chain + drop Python network modules). **But in-realm scrubbing cannot stop a
determined attacker re-deriving globals via `Function("return this")()`.** So the
accepted threat model is:

> **Prevent the AI's analysis code from *accidentally/incidentally* reaching the
> network or vault — not run hostile third-party code.**

For "run untrusted code safely" you'd need an OS/process sandbox, which is a
different, much larger project. The realm scrub + no-Node-worker + MEMFS-only +
terminate-timeout is strong *defense-in-depth* for the accidental-egress model,
and must still be **pen-tested in a real Electron worker** (the `Function`-ctor,
captured-reference, `sendBeacon`, dynamic-`import()` vectors) before any
"sandboxed" claim is made in user-facing copy.

**Still pending (needs a real Obsidian desktop build):** the four Electron
runtime items (no-Node-in-worker, terminate-timeout, file:// importScripts +
local indexURL load, live asset download) plus the security pen-test above.
