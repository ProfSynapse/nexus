/**
 * Builds the Web Worker source for the Pyodide sandbox.
 *
 * The worker runs entirely off the main thread with NO Node integration. It:
 *   1. loads Pyodide + pandas from the local file:// indexURL (offline),
 *   2. micropip-installs openpyxl (pure-Python, not in the Pyodide dist),
 *   3. HARDENS the realm: deletes the network surface across self / globalThis /
 *      the prototype chain and drops Python network modules (the lockdown,
 *      plan §4) — best-effort in-realm defense; see the security note below,
 *   4. on each run: clears MEMFS /data, injects fresh input bytes, exposes an
 *      `inputs` path dict, executes user code, and marshals the result to JSON
 *      *in Python* (NaN→null, datetime→iso, numpy/int64-safe — validated in the
 *      marshal spike) so pandas output round-trips cleanly.
 *
 * ⚠️ SECURITY NOTE: in-realm scrubbing cannot defeat a determined adversary who
 * re-derives globals via `Function("return this")()`. The intended threat model
 * is "prevent the AI's analysis code from accidentally/incidentally reaching the
 * network or vault", not "run hostile third-party code". A true boundary also
 * requires the Electron worker having no Node integration + no granted network,
 * which is PENDING Electron validation (terminate-timeout, file:// load too).
 */

/** Python defined once at init: a numpy/pandas/datetime-aware json.dumps. */
const MARSHAL_PY = `import json, math, datetime
def __nexus_default(o):
    try:
        import numpy as np
        if isinstance(o, np.integer): return int(o)
        if isinstance(o, np.floating):
            f = float(o)
            return f if math.isfinite(f) else None
        if isinstance(o, np.ndarray): return o.tolist()
    except Exception:
        pass
    if isinstance(o, (datetime.date, datetime.datetime)): return o.isoformat()
    try:
        import pandas as pd
        if o is pd.NaT: return None
    except Exception:
        pass
    return str(o)
def __nexus_dumps(x):
    return json.dumps(x, default=__nexus_default)`;

/** Python run at init to drop in-Python network reach. */
const DROP_NET_PY = `import sys
for __m in list(sys.modules):
    if __m == 'micropip' or __m == 'pyodide.http' or __m.startswith('pyodide_http'):
        sys.modules.pop(__m, None)`;

export interface WorkerBootstrapOptions {
  /** file:// URL to the pyodide asset dir (trailing slash). */
  indexUrl: string;
  /** Compiled packages loaded via loadPackage. */
  loadPackages: string[];
  /** Exact wheel filenames installed via micropip from indexUrl. */
  micropipWheels: string[];
}

export function buildPyodideWorkerSource(opts: WorkerBootstrapOptions): string {
  return `'use strict';
let pyodide = null;
const INDEX_URL = ${JSON.stringify(opts.indexUrl)};
const LOAD_PACKAGES = ${JSON.stringify(opts.loadPackages)};
const MICROPIP_WHEELS = ${JSON.stringify(opts.micropipWheels)};

// Best-effort realm hardening: remove the network surface from every reachable
// global target. Runs AFTER load (which needs fetch) and BEFORE any user code.
function __hardenRealm() {
  const NAMES = ['fetch','XMLHttpRequest','WebSocket','EventSource','WebTransport',
                 'Request','Response','Headers','importScripts','caches','indexedDB'];
  const targets = [self, globalThis];
  let p = Object.getPrototypeOf(self);
  while (p && p !== Object.prototype) { targets.push(p); p = Object.getPrototypeOf(p); }
  for (const t of targets) {
    for (const n of NAMES) {
      try { delete t[n]; } catch (e) { /* non-configurable */ }
      try { Object.defineProperty(t, n, { value: undefined, configurable: false, writable: false }); } catch (e) { /* frozen */ }
    }
  }
  try { if (self.navigator) self.navigator.sendBeacon = undefined; } catch (e) { /* readonly */ }
}

async function init() {
  importScripts(INDEX_URL + 'pyodide.js');
  pyodide = await self.loadPyodide({ indexURL: INDEX_URL });
  await pyodide.loadPackage([...LOAD_PACKAGES, 'micropip']);
  if (MICROPIP_WHEELS.length) {
    const micropip = pyodide.pyimport('micropip');
    await micropip.install(MICROPIP_WHEELS.map(function (w) { return INDEX_URL + w; }), false);
  }
  pyodide.runPython(${JSON.stringify(MARSHAL_PY)});
  try { pyodide.runPython(${JSON.stringify(DROP_NET_PY)}); } catch (e) { /* best effort */ }
  __hardenRealm();
}

const ready = init().then(function () { return { ok: true }; })
  .catch(function (e) { return { ok: false, error: String((e && e.stack) || e) }; });

// JSON.dumps may emit NaN/Infinity tokens (invalid JSON); coerce to null pre-parse.
function __parseMarshalled(s) {
  return JSON.parse(String(s).replace(/\\bNaN\\b/g, 'null').replace(/-?\\bInfinity\\b/g, 'null'));
}

self.onmessage = async function (ev) {
  const msg = ev.data || {};

  if (msg.type === 'init') {
    const r = await ready;
    self.postMessage(r.ok ? { type: 'ready' } : { type: 'init-error', error: r.error });
    return;
  }

  if (msg.type === 'run') {
    const r = await ready;
    if (!r.ok) {
      self.postMessage({ id: msg.id, type: 'result', success: false, error: 'Runtime failed to initialize: ' + r.error });
      return;
    }
    const started = Date.now();
    const logs = [];
    let proxy = null;
    try {
      pyodide.setStdout({ batched: function (s) { logs.push(s); } });
      pyodide.setStderr({ batched: function (s) { logs.push(s); } });

      // Fresh MEMFS state per run (no data leak between analyses).
      try { pyodide.runPython("import shutil; shutil.rmtree('/data', ignore_errors=True)"); } catch (e) { /* none yet */ }
      pyodide.FS.mkdirTree('/data');

      const inputs = {};
      const files = msg.files || [];
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        pyodide.FS.writeFile(f.sandboxPath, f.bytes);
        inputs[f.varName] = f.sandboxPath;
      }
      pyodide.globals.set('inputs', pyodide.toPy(inputs));

      proxy = await pyodide.runPythonAsync(msg.code);
      pyodide.globals.set('__nexus_result', proxy);
      const jsonStr = pyodide.runPython('__nexus_dumps(__nexus_result)');
      const data = __parseMarshalled(jsonStr);

      self.postMessage({ id: msg.id, type: 'result', success: true, data: data, logs: logs, stats: { durationMs: Date.now() - started } });
    } catch (e) {
      self.postMessage({ id: msg.id, type: 'result', success: false, error: String((e && e.message) || e), logs: logs });
    } finally {
      try { if (proxy && typeof proxy.destroy === 'function') proxy.destroy(); } catch (e) { /* not a proxy */ }
    }
  }
};
`;
}
