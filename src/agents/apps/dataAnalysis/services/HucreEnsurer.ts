/**
 * HucreEnsurer — vendors the `hucre/xlsx` engine into the plugin's `hucre`
 * folder on first use and loads it at runtime, mirroring {@link PyodideEnsurer}.
 *
 * Why vendored (not bundled): the xlsx entry is ~302 KB minified, over main.js's
 * ~218 KB headroom against the 5 MB ceiling (spike S2). It is downloaded once
 * (dependency-bundled ESM from esm.sh) and loaded locally thereafter.
 *
 * Load mechanism: the vendored file is read as text and imported via a Blob URL
 * (`import(blob:…)`), the same realm trick the Pyodide worker uses — this dodges
 * esbuild's static `import()` resolution (so hucre never enters the bundle) and
 * avoids `file://`/CSP quirks in the Electron renderer.
 *
 * ⚠️ PENDING Electron validation: the download URL shape and the Blob-import load
 * path must be exercised in a real Obsidian desktop build (not runnable headless).
 */

import { App, FileSystemAdapter, Notice, requestUrl } from 'obsidian';
import { HUCRE_XLSX_ASSET } from '../spreadsheet/HucreAssets';
import type { HucreModule } from '../spreadsheet/HucreModule';

const KNOWN_PLUGIN_FOLDERS = ['nexus', 'claudesidian-mcp'] as const;

function getFsAdapter(app: App): FileSystemAdapter {
  const adapter = app.vault.adapter;
  if (!(adapter instanceof FileSystemAdapter)) {
    throw new Error('Spreadsheet sync requires a desktop filesystem vault.');
  }
  return adapter;
}

async function detectPluginFolder(app: App): Promise<string> {
  const configDir = app.vault.configDir;
  for (const folder of KNOWN_PLUGIN_FOLDERS) {
    if (await app.vault.adapter.exists(`${configDir}/plugins/${folder}/manifest.json`)) {
      return folder;
    }
  }
  return KNOWN_PLUGIN_FOLDERS[0];
}

/** Vault-relative path to the vendored hucre file. */
export async function resolveHucreAssetPath(app: App): Promise<string> {
  const folder = await detectPluginFolder(app);
  return `${app.vault.configDir}/plugins/${folder}/hucre/${HUCRE_XLSX_ASSET.file}`;
}

export class HucreEnsurer {
  private cached: HucreModule | null = null;

  constructor(private readonly app: App) {}

  /** Ensure the vendored bundle is present (download once if missing). */
  async ensure(): Promise<{ ok: boolean; error?: string }> {
    const adapter = getFsAdapter(this.app);
    const path = await resolveHucreAssetPath(this.app);

    if (await this.isPresent(path)) {
      return { ok: true };
    }

    const dir = path.slice(0, path.lastIndexOf('/'));
    if (!(await adapter.exists(dir))) {
      await adapter.mkdir(dir);
    }

    const notice = new Notice('Setting up the spreadsheet engine — downloading once…', 0);
    try {
      const res = await requestUrl({ url: HUCRE_XLSX_ASSET.url, method: 'GET' });
      const bytes = res.arrayBuffer?.byteLength ?? 0;
      if (res.status !== 200) {
        notice.hide();
        return { ok: false, error: `Failed to download the spreadsheet engine (HTTP ${res.status}).` };
      }
      // A 200 with a tiny body means the CDN served a re-export shim rather than
      // the bundled module — distinguish it from a transport failure so the cause
      // is obvious (the shim's relative imports can't resolve from a blob: URL).
      if (bytes < HUCRE_XLSX_ASSET.minBytes) {
        notice.hide();
        return {
          ok: false,
          error:
            `Spreadsheet engine download too small (${bytes}B < ${HUCRE_XLSX_ASSET.minBytes}B min) — ` +
            `the CDN returned a shim, not the bundled module. URL: ${HUCRE_XLSX_ASSET.url}`,
        };
      }
      await adapter.writeBinary(path, res.arrayBuffer);
      notice.hide();
      new Notice('Spreadsheet engine ready.', 3000);
      return { ok: true };
    } catch (error) {
      notice.hide();
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** Ensure + load the hucre module (cached after first load). */
  async loadModule(): Promise<HucreModule> {
    if (this.cached) {
      return this.cached;
    }
    const ensured = await this.ensure();
    if (!ensured.ok) {
      throw new Error(ensured.error ?? 'Spreadsheet engine unavailable.');
    }

    const path = await resolveHucreAssetPath(this.app);
    const code = await this.app.vault.adapter.read(path);

    const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
    try {
      // Function-wrapped native dynamic import so esbuild does not statically
      // resolve/bundle it (hucre must stay a runtime asset, never in main.js).
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      const importEsm = new Function('u', 'return import(u);') as (u: string) => Promise<Record<string, unknown>>;
      const mod = await importEsm(url);
      const openXlsx = mod.openXlsx as HucreModule['openXlsx'] | undefined;
      const saveXlsx = mod.saveXlsx as HucreModule['saveXlsx'] | undefined;
      if (typeof openXlsx !== 'function' || typeof saveXlsx !== 'function') {
        throw new Error('Vendored hucre bundle is missing openXlsx/saveXlsx.');
      }
      this.cached = { openXlsx, saveXlsx };
      return this.cached;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  private async isPresent(path: string): Promise<boolean> {
    const adapter = getFsAdapter(this.app);
    if (!(await adapter.exists(path))) {
      return false;
    }
    const stat = await adapter.stat(path);
    return !!stat && stat.size >= HUCRE_XLSX_ASSET.minBytes;
  }
}
