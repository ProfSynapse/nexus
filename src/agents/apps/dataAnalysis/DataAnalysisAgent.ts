/**
 * DataAnalysisAgent — desktop-only app for running Python (pandas) against
 * vault CSV/Excel data inside a sandboxed, network-isolated Pyodide worker.
 *
 * Registered in: AppManager.getBuiltInAppRegistry() (desktop only).
 * Exported from: src/agents/apps/index.ts
 *
 * The heavy Pyodide runtime is created lazily on first use and torn down on
 * unload. No external API keys required.
 */

import { BaseAppAgent } from '../BaseAppAgent';
import { AppManifest } from '../../../types/apps/AppTypes';
import { RunPythonTool } from './tools/runPython';
import { ListCapabilitiesTool } from './tools/listCapabilities';
import { IAnalysisSandbox } from './types';
import { PyodideSandbox } from './services/PyodideSandbox';
import { HucreEnsurer } from './services/HucreEnsurer';
import type { HucreModule } from './spreadsheet/HucreModule';
import { resolveVaultRoot } from '../../../database/storage/VaultRootResolver';
import { isDesktop } from '../../../utils/platform';
import { SpreadsheetAutoSync } from './spreadsheet/SpreadsheetAutoSync';
import { WorkbookAutoMirror } from './spreadsheet/WorkbookAutoMirror';
import { WorkbookMirrorService } from './spreadsheet/WorkbookMirrorService';
import { WorkbookWriteBackService } from './spreadsheet/WorkbookWriteBackService';
import { HucreXlsxSource } from './spreadsheet/HucreXlsxSource';
import { HucreXlsxWriter } from './spreadsheet/HucreXlsxWriter';
import { workbookIdFromPath } from './spreadsheet/workbookId';
import type { MirrorManifest } from './spreadsheet/types';
import { SnapshotArchiveService } from '../../../services/storage/SnapshotArchiveService';
import { App, EventRef, Notice, normalizePath } from 'obsidian';

const DATA_ANALYSIS_MANIFEST: AppManifest = {
  id: 'data',
  name: 'Data Analysis',
  description:
    'Run Python (pandas) on vault CSV/Excel data in an isolated runtime (off-thread, ' +
    'no Node, in-memory filesystem). Best-effort isolation that blocks accidental network/vault ' +
    'access — not a hard sandbox for hostile code. Desktop only.',
  version: '0.1.0',
  author: 'Nexus',
  credentials: [],
  validation: { mode: 'none' },
  tools: [
    { slug: 'runPython', description: 'Run pandas/Python on CSV/XLSX inputs and return a bounded result' },
    { slug: 'listCapabilities', description: 'List the available Python packages and supported input formats' },
  ],
};

export class DataAnalysisAgent extends BaseAppAgent {
  private sandbox: IAnalysisSandbox | null = null;
  private hucre: HucreEnsurer | null = null;
  private autoSync: SpreadsheetAutoSync | null = null;
  private autoMirror: WorkbookAutoMirror | null = null;
  private vaultModifyRef: EventRef | null = null;
  private vaultCreateRef: EventRef | null = null;

  constructor() {
    super(DATA_ANALYSIS_MANIFEST);
    this.registerTool(new RunPythonTool(this));
    this.registerTool(new ListCapabilitiesTool(this));
  }

  /** Lazily vendor + load the hucre xlsx engine (desktop-only runtime asset). */
  async getHucreModule(): Promise<HucreModule> {
    const app = this.getApp();
    if (!app) {
      throw new Error('Obsidian app is not available.');
    }
    if (!this.hucre) {
      this.hucre = new HucreEnsurer(app);
    }
    return this.hucre.loadModule();
  }

  /**
   * Resolved mirror storage settings: the synced Nexus root (renameable in
   * Settings → Data) and the per-file shard cap. Falls back to defaults when the
   * runtime context isn't wired.
   */
  getMirrorStorage(): { root: string; maxShardBytes: number } {
    const settings = this.getRuntimeContext()?.getSettings();
    const resolution = resolveVaultRoot({ storage: settings?.storage });
    return { root: resolution.resolvedPath, maxShardBytes: resolution.maxShardBytes };
  }

  /**
   * Project a source `.xlsx`/`.xlsm` into the CSV-package mirror under
   * `<root>/spreadsheets/<id>/`. Driven automatically by the WorkbookAutoMirror
   * watcher (mirroring is no longer a manual tool). Idempotent: an unchanged workbook returns
   * `regenerated: false` without rewriting shards.
   */
  async mirrorWorkbook(path: string): Promise<{
    regenerated: boolean;
    workbookId: string;
    manifest: MirrorManifest;
    mirrorDir: string;
  }> {
    const vault = this.getVault();
    if (!vault) {
      throw new Error('Vault not available.');
    }
    const buffer = await vault.adapter.readBinary(normalizePath(path));
    const mod = await this.getHucreModule();
    const source = new HucreXlsxSource(() => Promise.resolve(mod));
    const workbook = await source.readWorkbook(new Uint8Array(buffer));

    const { root, maxShardBytes } = this.getMirrorStorage();
    const workbookId = workbookIdFromPath(path);
    const mirror = new WorkbookMirrorService(vault.adapter);
    const target = { root, workbookId, maxShardBytes, sourcePath: normalizePath(path) };
    const { manifest, regenerated } = await mirror.generate(workbook, target);

    return { regenerated, workbookId, manifest, mirrorDir: mirror.mirrorDir(target) };
  }

  /** Auto-mirror impl wired into the watcher: mirror + a one-line Notice on real change. */
  private async autoMirrorWorkbook(path: string): Promise<void> {
    try {
      const { regenerated, workbookId } = await this.mirrorWorkbook(path);
      if (regenerated) {
        new Notice(`Mirrored ${path} → spreadsheets/${workbookId}/ (CSV).`, 4000);
      }
    } catch (error) {
      // Don't let a failure vanish silently (the upstream watcher swallows it):
      // surface it to the user so a broken engine/workbook is visible.
      new Notice(`Data Analysis: failed to mirror ${path} — ${error instanceof Error ? error.message : String(error)}`, 6000);
      throw error;
    }
  }

  /** Lazily create + initialize the desktop-only Pyodide sandbox. */
  async getSandbox(): Promise<IAnalysisSandbox> {
    if (!this.sandbox) {
      const app = this.getApp();
      if (!app) {
        throw new Error('Obsidian app is not available.');
      }
      this.sandbox = new PyodideSandbox(app);
    }
    await this.sandbox.ensureReady();
    return this.sandbox;
  }

  /** Test seam: inject a fake sandbox to exercise the tool without Pyodide. */
  setSandbox(sandbox: IAnalysisSandbox): void {
    this.sandbox = sandbox;
  }

  /** Inject the App/Vault only. The vault watchers are wired in onload(). */
  setApp(app: App): void {
    super.setApp(app);
  }

  /**
   * Start the auto-mirror + auto-sync vault watchers. Called ONCE by AppManager
   * for a genuinely loaded+enabled app — unlike setApp(), which also runs for the
   * throwaway agents created to populate the Settings → Apps list. Wiring here
   * (not in setApp) prevents those preview instances from leaking duplicate
   * watchers that would double-mirror and race on write-back.
   */
  onload(): void {
    const app = this.getApp();
    // Auto-sync is desktop-only (hucre engine) and needs a real vault event bus —
    // guard all of these so non-desktop, test/mocked, and app-less agents no-op.
    if (!app || this.vaultModifyRef || !isDesktop() || typeof app.vault?.on !== 'function') {
      return;
    }
    // FORWARD: source `.xlsx`/`.xlsm` change → auto-project into the CSV mirror.
    this.autoMirror = new WorkbookAutoMirror({
      getRoot: () => this.getMirrorStorage().root,
      mirror: (path) => this.autoMirrorWorkbook(path),
    });
    // REVERSE: mirror CSV edit → write back into the source workbook losslessly.
    this.autoSync = new SpreadsheetAutoSync({
      getRoot: () => this.getMirrorStorage().root,
      sync: (workbookId) => this.syncWorkbook(workbookId),
    });

    const onChange = (path: string): void => {
      // A path is either a source workbook (forward) or a mirror CSV shard
      // (reverse); each scheduler ignores paths that aren't its concern.
      this.autoMirror?.notifyChanged(path);
      this.autoSync?.notifyModified(path);
    };
    this.vaultModifyRef = app.vault.on('modify', (file) => onChange(file.path));
    this.vaultCreateRef = app.vault.on('create', (file) => onChange(file.path));

    // Startup catch-up: mirror Excel files that already existed before the app
    // loaded (the vault `create`/`modify` events only fire for changes AFTER
    // this point). Deferred so it doesn't block init / the metadata cache warm-up.
    window.setTimeout(() => void this.mirrorExistingWorkbooks(), 1500);
  }

  /**
   * One-shot scan: mirror every source `.xlsx`/`.xlsm` in the vault that isn't
   * already up to date. Idempotent (hash-gated generate skips unchanged files),
   * best-effort per file. Excludes the mirror tree + `_archive/` snapshots.
   */
  private async mirrorExistingWorkbooks(): Promise<void> {
    const app = this.getApp();
    if (!app) {
      return;
    }
    const { root } = this.getMirrorStorage();
    const mirrorPrefix = `${root}/spreadsheets/`;
    const workbooks = app.vault
      .getFiles()
      .filter((f) => /\.(xlsx|xlsm)$/i.test(f.path))
      .filter((f) => !f.path.startsWith(mirrorPrefix) && !f.path.includes('/_archive/'));

    for (const file of workbooks) {
      try {
        await this.autoMirrorWorkbook(file.path);
      } catch {
        // A single bad workbook must not abort the rest of the scan
        // (autoMirrorWorkbook surfaces its own failure Notice).
      }
    }
  }

  /**
   * Auto write-back for one mirrored workbook: read the manifest for its source
   * `.xlsx`, apply the edited CSV shards back losslessly, and persist. Triggered
   * (debounced) by the vault watcher when a mirror shard changes; a no-op when
   * there's no manifest or nothing actually changed.
   */
  private async syncWorkbook(workbookId: string): Promise<void> {
    const app = this.getApp();
    const vault = this.getVault();
    if (!app || !vault) {
      return;
    }
    const { root, maxShardBytes } = this.getMirrorStorage();
    const mirror = new WorkbookMirrorService(vault.adapter);
    const manifest = await mirror.readManifest({ root, workbookId, maxShardBytes });
    if (!manifest || !manifest.sourcePath) {
      return;
    }

    let buffer: ArrayBuffer;
    try {
      buffer = await vault.adapter.readBinary(normalizePath(manifest.sourcePath));
    } catch {
      return; // source moved/deleted — skip silently
    }

    const mod = await this.getHucreModule();
    const writeBack = new WorkbookWriteBackService(
      vault.adapter,
      new HucreXlsxSource(() => Promise.resolve(mod)),
      new HucreXlsxWriter(() => Promise.resolve(mod)),
      mirror,
      new SnapshotArchiveService(vault.adapter)
    );

    const target = { root, workbookId, maxShardBytes, sourcePath: manifest.sourcePath };
    const result = await writeBack.apply(target, new Uint8Array(buffer));

    if (result.applied && result.newBytes) {
      await vault.adapter.writeBinary(normalizePath(manifest.sourcePath), result.newBytes.slice().buffer);
      const blocked = result.summary.cellsBlocked > 0 ? `, ${result.summary.cellsBlocked} formula cell(s) skipped` : '';
      new Notice(`Synced ${result.summary.cellsApplied} change(s) to ${manifest.sourcePath}${blocked}.`, 4000);
    }
  }

  onunload(): void {
    const app = this.getApp();
    if (this.vaultModifyRef) {
      app?.vault.offref(this.vaultModifyRef);
      this.vaultModifyRef = null;
    }
    if (this.vaultCreateRef) {
      app?.vault.offref(this.vaultCreateRef);
      this.vaultCreateRef = null;
    }
    this.autoMirror?.dispose();
    this.autoMirror = null;
    this.autoSync?.dispose();
    this.autoSync = null;
    this.sandbox?.dispose();
    this.sandbox = null;
    super.onunload();
  }
}
