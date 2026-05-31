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
import { RunAnalysisTool } from './tools/runAnalysis';
import { ListCapabilitiesTool } from './tools/listCapabilities';
import { MirrorWorkbookTool } from './tools/mirrorWorkbook';
import { ApplyToWorkbookTool } from './tools/applyToWorkbook';
import { IAnalysisSandbox } from './types';
import { PyodideSandbox } from './services/PyodideSandbox';
import { HucreEnsurer } from './services/HucreEnsurer';
import type { HucreModule } from './spreadsheet/HucreModule';
import { resolveVaultRoot } from '../../../database/storage/VaultRootResolver';

const DATA_ANALYSIS_MANIFEST: AppManifest = {
  id: 'data-analysis',
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
    { slug: 'runAnalysis', description: 'Run pandas/Python on CSV/XLSX inputs and return a bounded result' },
    { slug: 'listCapabilities', description: 'List the available Python packages and supported input formats' },
    { slug: 'mirrorWorkbook', description: 'Project an .xlsx into editable CSV shards under <root>/spreadsheets/' },
    { slug: 'applyToWorkbook', description: 'Apply CSV edits back into the .xlsx losslessly (charts/formulas preserved)' },
  ],
};

export class DataAnalysisAgent extends BaseAppAgent {
  private sandbox: IAnalysisSandbox | null = null;
  private hucre: HucreEnsurer | null = null;

  constructor() {
    super(DATA_ANALYSIS_MANIFEST);
    this.registerTool(new RunAnalysisTool(this));
    this.registerTool(new ListCapabilitiesTool(this));
    this.registerTool(new MirrorWorkbookTool(this));
    this.registerTool(new ApplyToWorkbookTool(this));
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

  onunload(): void {
    this.sandbox?.dispose();
    this.sandbox = null;
    super.onunload();
  }
}
