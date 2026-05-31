/**
 * PyodideEnsurer — vendors the Pyodide runtime + pandas/Excel wheels into the
 * plugin's "pyodide" folder on first use, mirroring the SQLite WasmEnsurer.
 *
 * Why vendored (not bundled): the ~21MB of wasm + wheels must never enter
 * main.js (5MB ceiling). They are downloaded once and loaded locally so the
 * sandbox runs offline thereafter.
 *
 * Asset sources (pinned to PYODIDE_VERSION):
 *   - core runtime + compiled wheels (pandas/numpy/…): the Pyodide jsDelivr CDN
 *   - openpyxl + et_xmlfile (pure-Python, not in the Pyodide dist): PyPI
 * All filenames/URLs were validated in the Phase 0 spike.
 *
 * ⚠️ PENDING Electron validation: the actual network download path (requestUrl
 * + adapter.writeBinary) must be exercised in a real Obsidian desktop build.
 * The pinned manifest is unit-tested; the download mechanics are not runnable
 * in the headless test container.
 */

import { App, Notice, requestUrl } from 'obsidian';

export const PYODIDE_VERSION = '0.29.4';
const CDN_BASE = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;

export interface AssetSpec {
  /** Filename written into the pyodide dir. */
  file: string;
  /** Absolute download URL. */
  url: string;
  /** Reject downloads smaller than this (guards against HTML error pages). */
  minBytes: number;
}

/** Fixed-name core runtime files (resolved against the CDN). */
const CORE_FILES = [
  'pyodide.js',
  'pyodide.asm.js',
  'pyodide.asm.wasm',
  'python_stdlib.zip',
  'pyodide-lock.json',
];

/** Compiled wheels loaded via loadPackage — exact lock filenames for this version. */
const COMPILED_WHEELS = [
  'pandas-2.3.3-cp313-cp313-pyemscripten_2025_0_wasm32.whl',
  'numpy-2.2.5-cp313-cp313-pyemscripten_2025_0_wasm32.whl',
  'python_dateutil-2.9.0.post0-py2.py3-none-any.whl',
  'pytz-2025.2-py2.py3-none-any.whl',
  'six-1.17.0-py2.py3-none-any.whl',
  'micropip-0.11.1-py3-none-any.whl',
  'packaging-26.2-py3-none-any.whl',
];

/** Pure-Python wheels installed via micropip — sourced from PyPI (not in the dist). */
const PYPI_WHEELS: AssetSpec[] = [
  {
    file: 'openpyxl-3.1.5-py2.py3-none-any.whl',
    url: 'https://files.pythonhosted.org/packages/c0/da/977ded879c29cbd04de313843e76868e6e13408a94ed6b987245dc7c8506/openpyxl-3.1.5-py2.py3-none-any.whl',
    minBytes: 100_000,
  },
  {
    file: 'et_xmlfile-2.0.0-py3-none-any.whl',
    url: 'https://files.pythonhosted.org/packages/c1/8b/5fe2cc11fee489817272089c4203e679c63b570a5aaeb18d852ae3cbba6a/et_xmlfile-2.0.0-py3-none-any.whl',
    minBytes: 5_000,
  },
];

/** The complete, deterministic set of files the sandbox needs on disk. */
export function buildPyodideAssetManifest(): AssetSpec[] {
  const fromCdn = (file: string, minBytes: number): AssetSpec => ({ file, url: CDN_BASE + file, minBytes });
  return [
    ...CORE_FILES.map((f) => fromCdn(f, 1_000)),
    ...COMPILED_WHEELS.map((f) => fromCdn(f, 5_000)),
    ...PYPI_WHEELS,
  ];
}

export interface EnsureResult {
  ok: boolean;
  downloaded: number;
  error?: string;
}

export class PyodideEnsurer {
  constructor(private readonly app: App) {}

  /**
   * Ensure every manifest asset is present (and non-truncated) in `targetDir`.
   * Downloads only what's missing. Idempotent.
   */
  async ensureAssets(targetDir: string): Promise<EnsureResult> {
    const adapter = this.app.vault.adapter;
    const manifest = buildPyodideAssetManifest();

    const missing: AssetSpec[] = [];
    for (const asset of manifest) {
      if (!(await this.isPresent(`${targetDir}/${asset.file}`, asset.minBytes))) {
        missing.push(asset);
      }
    }
    if (missing.length === 0) {
      return { ok: true, downloaded: 0 };
    }

    if (!(await adapter.exists(targetDir))) {
      await adapter.mkdir(targetDir);
    }

    const notice = new Notice(
      `Setting up the Python data environment — downloading ${missing.length} files ` +
        `(~21MB, one time only)…`,
      0
    );
    let downloaded = 0;
    try {
      for (const asset of missing) {
        const data = await this.download(asset);
        if (!data) {
          notice.hide();
          return { ok: false, downloaded, error: `Failed to download ${asset.file}` };
        }
        await adapter.writeBinary(`${targetDir}/${asset.file}`, data);
        downloaded++;
      }
      notice.hide();
      new Notice('Python data environment ready.', 3000);
      return { ok: true, downloaded };
    } catch (error) {
      notice.hide();
      return { ok: false, downloaded, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private async isPresent(path: string, minBytes: number): Promise<boolean> {
    const adapter = this.app.vault.adapter;
    if (!(await adapter.exists(path))) {
      return false;
    }
    const stat = await adapter.stat(path);
    return !!stat && stat.size >= minBytes;
  }

  private async download(asset: AssetSpec): Promise<ArrayBuffer | null> {
    try {
      const res = await requestUrl({ url: asset.url, method: 'GET' });
      if (res.status !== 200) {
        return null;
      }
      const buffer = res.arrayBuffer;
      return buffer.byteLength >= asset.minBytes ? buffer : null;
    } catch {
      return null;
    }
  }
}
