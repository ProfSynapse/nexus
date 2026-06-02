/**
 * Resolves the vendored Pyodide asset directory inside the plugin folder.
 *
 * Delivery follows the SQLite `WasmEnsurer` ethos: the heavy runtime + wheels
 * live next to main.js (never bundled into it) and are loaded at runtime. The
 * worker loads Pyodide from a local app:// indexURL so execution is offline —
 * file:// is blocked in Electron worker contexts ("not allowed to load local
 * resource"), but Obsidian's app:// resource scheme is permitted.
 *
 * Desktop-only — requires a FileSystemAdapter.
 */

import { App, FileSystemAdapter } from 'obsidian';

const KNOWN_PLUGIN_FOLDERS = ['nexus', 'claudesidian-mcp'];
const MICROPIP_WHEEL_RE = /^(openpyxl|et_xmlfile)-.*\.whl$/;

export interface PyodideAssetInfo {
  /** app:// URL to the pyodide asset directory, trailing slash included. */
  indexUrl: string;
  /** Exact wheel filenames to install via micropip (pure-Python, not in dist). */
  micropipWheels: string[];
}

function getFsAdapter(app: App): FileSystemAdapter {
  const adapter = app.vault.adapter;
  if (!(adapter instanceof FileSystemAdapter)) {
    throw new Error('Data Analysis requires a desktop filesystem vault.');
  }
  return adapter;
}

async function detectPluginFolder(app: App, adapter: FileSystemAdapter): Promise<string> {
  const configDir = app.vault.configDir;
  for (const folder of KNOWN_PLUGIN_FOLDERS) {
    // Detect by the always-present manifest.json so the write target resolves
    // even before the pyodide assets have been vendored.
    if (await adapter.exists(`${configDir}/plugins/${folder}/manifest.json`)) {
      return folder;
    }
  }
  return KNOWN_PLUGIN_FOLDERS[0];
}

/** Vault-relative path to the pyodide asset directory (the download target). */
export async function resolvePyodideDirVaultPath(app: App): Promise<string> {
  const adapter = getFsAdapter(app);
  const folder = await detectPluginFolder(app, adapter);
  return `${app.vault.configDir}/plugins/${folder}/pyodide`;
}

/** True when the Pyodide runtime has been vendored into the plugin folder. */
export async function pyodideAssetsPresent(app: App): Promise<boolean> {
  let adapter: FileSystemAdapter;
  try {
    adapter = getFsAdapter(app);
  } catch {
    return false;
  }
  const configDir = app.vault.configDir;
  for (const folder of KNOWN_PLUGIN_FOLDERS) {
    if (await adapter.exists(`${configDir}/plugins/${folder}/pyodide/pyodide.js`)) {
      return true;
    }
  }
  return false;
}

export async function resolvePyodideAssets(app: App): Promise<PyodideAssetInfo> {
  const adapter = getFsAdapter(app);
  const configDir = app.vault.configDir;
  const folder = await detectPluginFolder(app, adapter);
  const dir = `${configDir}/plugins/${folder}/pyodide`;

  const listing = await adapter
    .list(dir)
    .catch(() => ({ files: [] as string[], folders: [] as string[] }));
  const micropipWheels = (listing.files || [])
    .map((p) => p.split('/').pop() || '')
    .filter((name) => MICROPIP_WHEEL_RE.test(name));

  // Electron blocks file:// loads from a Worker ("Not allowed to load local
  // resource"), which is fatal for `importScripts(indexURL + 'pyodide.js')` and
  // Pyodide's own asset fetches. Address the vendored files through Obsidian's
  // app:// resource scheme instead — the renderer and its workers are permitted
  // to fetch it. Derive the directory base from a probe file's resource path by
  // stripping the filename and the cache-busting query (Pyodide appends bare
  // filenames to indexURL, and app:// resolves by path regardless of query).
  const probe = adapter.getResourcePath(`${dir}/pyodide.js`);
  const indexUrl = probe.replace(/pyodide\.js(\?.*)?$/, '');
  return { indexUrl, micropipWheels };
}
