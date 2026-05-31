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
import { IAnalysisSandbox } from './types';
import { PyodideSandbox } from './services/PyodideSandbox';

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
  ],
};

export class DataAnalysisAgent extends BaseAppAgent {
  private sandbox: IAnalysisSandbox | null = null;

  constructor() {
    super(DATA_ANALYSIS_MANIFEST);
    this.registerTool(new RunAnalysisTool(this));
    this.registerTool(new ListCapabilitiesTool(this));
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
