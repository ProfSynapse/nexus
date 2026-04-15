/**
 * tests/eval/headless/TestApp.ts — Minimal Obsidian App stub wrapping TestVault.
 *
 * Provides the subset of the App interface that agents actually use:
 * - app.vault (TestVault)
 * - app.fileManager.trashFile (delegates to vault.trash)
 * - app.metadataCache.getFileCache (returns null — no frontmatter cache)
 * - app.workspace (empty stub)
 * - app.plugins.getPlugin (returns null)
 *
 * Cast to App for agent constructors that require the Obsidian App type.
 */

import type { App, TAbstractFile } from 'obsidian';
import { TestVault } from './TestVault';

export interface TestAppOptions {
  basePath: string;
  vaultName?: string;
}

export class TestApp {
  public vault: TestVault;

  public fileManager: {
    trashFile: (file: TAbstractFile) => Promise<void>;
    renameFile: (file: TAbstractFile, newPath: string) => Promise<void>;
  };

  public metadataCache: {
    getFileCache: (file: unknown) => null;
    getFirstLinkpathDest: (linkpath: string, sourcePath: string) => null;
  };

  public workspace: Record<string, unknown>;

  public plugins: {
    getPlugin: (id: string) => null;
    enabledPlugins: Set<string>;
  };

  /** Obsidian App.version — agents may read this */
  public version = '1.0.0';

  constructor(options: TestAppOptions) {
    this.vault = new TestVault(options.basePath, options.vaultName);

    this.fileManager = {
      trashFile: async (file: TAbstractFile) => {
        await this.vault.trash(file, false);
      },
      renameFile: async (file: TAbstractFile, newPath: string) => {
        await this.vault.rename(file, newPath);
      },
    };

    this.metadataCache = {
      getFileCache: () => null,
      getFirstLinkpathDest: () => null,
    };

    this.workspace = {
      getLeaf: () => ({
        openFile: async () => { /* noop */ },
      }),
      onLayoutReady: (cb: () => void) => cb(),
    };

    this.plugins = {
      getPlugin: () => null,
      enabledPlugins: new Set(),
    };
  }

  /**
   * Cast to the Obsidian App type for agent constructors.
   * The agents only use the subset of App that TestApp provides.
   */
  asApp(): App {
    return this as unknown as App;
  }
}
