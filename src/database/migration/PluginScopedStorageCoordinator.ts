import { App, Notice, Plugin, normalizePath } from 'obsidian';
import type { MCPSettings } from '../../types/plugin/PluginTypes';
import {
  resolvePluginStorageRoot,
  ResolvedPluginStorageRoot
} from '../storage/PluginStoragePathResolver';
import { pluginDataLock } from '../../utils/pluginDataLock';

const STORAGE_VERSION = 1;
const STORAGE_CATEGORIES = ['workspaces', 'conversations', 'tasks'] as const;

type StorageCategory = typeof STORAGE_CATEGORIES[number];

type StoredPluginData = MCPSettings & {
  pluginStorage?: PluginScopedStorageState;
};

export type SourceOfTruthLocation = 'legacy-dotnexus' | 'plugin-data';
export type PluginScopedMigrationState = 'not_started' | 'copying' | 'copied' | 'verified' | 'failed';

export interface PluginScopedStorageState {
  storageVersion: number;
  sourceOfTruthLocation: SourceOfTruthLocation;
  migration: {
    state: PluginScopedMigrationState;
    startedAt?: number;
    completedAt?: number;
    verifiedAt?: number;
    lastError?: string;
    legacySourcesDetected: string[];
    activeDestination: string;
  };
}

export interface PluginScopedStoragePlan {
  writeBasePath: string;
  readBasePaths: string[];
  state: PluginScopedStorageState;
  roots: ResolvedPluginStorageRoot;
}

interface MigrationManifestFileEntry {
  relativePath: string;
  size: number;
  modifiedAt: number;
  status: 'copied' | 'unchanged' | 'conflict';
}

interface MigrationManifest {
  generatedAt: number;
  legacyBasePath: string;
  destinationDataRoot: string;
  files: MigrationManifestFileEntry[];
}

interface VerificationReport {
  generatedAt: number;
  success: boolean;
  checkedFiles: string[];
  failures: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Two-stage migration coordinator for plugin-scoped storage.
 *
 * Stage 1 (first boot with legacy data): Returns legacy paths immediately,
 *   kicks off file copy + verify as fire-and-forget background work.
 *   When complete, persists state as 'verified'. No path changes this session.
 *
 * Stage 2 (subsequent boot after verified): Returns plugin-data paths instantly.
 *   No file I/O needed — the copy was completed in a prior session.
 *
 * Failed state: Stays on legacy paths. Background copy may retry on next boot.
 */
export class PluginScopedStorageCoordinator {
  readonly roots: ResolvedPluginStorageRoot;

  /** Exposed for testing — resolves when background migration finishes. */
  backgroundMigration: Promise<void> | null = null;

  constructor(
    private readonly app: App,
    private readonly plugin: Plugin,
    private readonly legacyBasePath: string
  ) {
    this.roots = resolvePluginStorageRoot(app, plugin);
  }

  /**
   * Return a storage plan quickly. Never blocks on file copy I/O.
   *
   * - verified: instant cutover to plugin-data paths
   * - not_started/copying/copied/failed with legacy files: legacy paths,
   *   background copy kicked off
   * - no legacy files: plugin-data paths (nothing to migrate)
   */
  async prepareStoragePlan(): Promise<PluginScopedStoragePlan> {
    const state = await this.loadState();

    // Stage 2: migration already verified in a prior session — instant cutover
    if (state.migration.state === 'verified') {
      return this.buildPluginDataPlan(state);
    }

    // Check whether legacy files exist (lightweight directory listing)
    const legacyFiles = await this.collectLegacyFiles();

    // No legacy data — go straight to plugin-data paths
    if (legacyFiles.length === 0) {
      const freshState: PluginScopedStorageState = {
        ...state,
        sourceOfTruthLocation: 'plugin-data',
        migration: {
          ...state.migration,
          activeDestination: this.roots.dataRoot,
          legacySourcesDetected: [],
          // Preserve failed state if a prior attempt failed
          state: state.migration.state === 'failed' ? 'failed' : state.migration.state,
          lastError: state.migration.state === 'failed' ? state.migration.lastError : undefined
        }
      };
      await this.saveState(freshState);
      return {
        writeBasePath: this.roots.dataRoot,
        readBasePaths: [this.roots.dataRoot],
        state: freshState,
        roots: this.roots
      };
    }

    // Stage 1: legacy files exist — return legacy plan immediately,
    // kick off copy+verify in the background
    const legacyState: PluginScopedStorageState = {
      ...state,
      sourceOfTruthLocation: 'legacy-dotnexus',
      migration: {
        ...state.migration,
        activeDestination: this.roots.dataRoot,
        legacySourcesDetected: [this.legacyBasePath]
      }
    };

    this.backgroundMigration = this.runBackgroundMigration(legacyState, legacyFiles);

    return {
      writeBasePath: this.legacyBasePath,
      readBasePaths: [this.legacyBasePath],
      state: legacyState,
      roots: this.roots
    };
  }

  /**
   * Fire-and-forget background migration. Copies legacy files to plugin-scoped
   * storage, verifies them, and saves state as 'verified'. Errors are caught
   * and persisted as 'failed' state — they don't propagate to the caller.
   */
  private async runBackgroundMigration(
    state: PluginScopedStorageState,
    legacyFiles: string[]
  ): Promise<void> {
    try {
      new Notice('Preparing your data for cross-device sync…');
      await this.ensureDirectory(this.roots.dataRoot);
      await this.ensureDirectory(this.roots.migrationRoot);

      const finalState = await this.runCopyOnlyMigration(state, legacyFiles);
      if (finalState.migration.state === 'verified') {
        console.warn('[PluginScopedStorageCoordinator] Background migration verified — cutover will happen on next boot');
        new Notice('Data migration complete — changes take effect on next restart.');
      }
    } catch (error) {
      console.error('[PluginScopedStorageCoordinator] Background migration failed:', error);
      new Notice('Data migration encountered an issue — see console for details.');
      await this.saveFailureState(state, error instanceof Error ? error.message : String(error)).catch(() => {
        // Best-effort — don't let state save failure mask the original error
      });
    }
  }

  private buildPluginDataPlan(state: PluginScopedStorageState): PluginScopedStoragePlan {
    return {
      writeBasePath: this.roots.dataRoot,
      readBasePaths: [this.roots.dataRoot, this.legacyBasePath],
      state: {
        ...state,
        sourceOfTruthLocation: 'plugin-data',
        migration: {
          ...state.migration,
          activeDestination: this.roots.dataRoot
        }
      },
      roots: this.roots
    };
  }

  private async runCopyOnlyMigration(
    state: PluginScopedStorageState,
    legacyFiles: string[]
  ): Promise<PluginScopedStorageState> {
    const startedAt = Date.now();
    const copyingState: PluginScopedStorageState = {
      ...state,
      migration: {
        ...state.migration,
        state: 'copying',
        startedAt,
        lastError: undefined
      }
    };
    await this.saveState(copyingState);

    const manifestEntries: MigrationManifestFileEntry[] = [];
    const conflicts: string[] = [];
    for (const relativePath of legacyFiles) {
      const sourcePath = normalizePath(`${this.legacyBasePath}/${relativePath}`);
      const destinationPath = normalizePath(`${this.roots.dataRoot}/${relativePath}`);
      const sourceContent = await this.app.vault.adapter.read(sourcePath);
      const sourceStat = await this.app.vault.adapter.stat(sourcePath);

      let status: 'copied' | 'unchanged' | 'conflict' = 'copied';
      if (await this.app.vault.adapter.exists(destinationPath)) {
        const existingContent = await this.app.vault.adapter.read(destinationPath);
        if (existingContent === sourceContent) {
          status = 'unchanged';
        } else {
          status = 'conflict';
          conflicts.push(
            `${relativePath}: destination already exists with different content; leaving plugin-scoped data unchanged`
          );
        }
      } else {
        await this.ensureDirectory(destinationPath.substring(0, destinationPath.lastIndexOf('/')));
        await this.app.vault.adapter.write(destinationPath, sourceContent);
      }

      manifestEntries.push({
        relativePath,
        size: sourceStat?.size ?? sourceContent.length,
        modifiedAt: sourceStat?.mtime ?? startedAt,
        status
      });
    }

    await this.writeMigrationManifest(manifestEntries);

    if (conflicts.length > 0) {
      await this.writeVerificationReport({
        generatedAt: Date.now(),
        success: false,
        checkedFiles: legacyFiles,
        failures: conflicts
      });
      return this.saveFailureState(state, conflicts.join('; '));
    }

    const copiedState: PluginScopedStorageState = {
      ...copyingState,
      migration: {
        ...copyingState.migration,
        state: 'copied',
        completedAt: Date.now()
      }
    };
    await this.saveState(copiedState);

    return this.verifyCopiedData(copiedState, legacyFiles);
  }

  private async verifyCopiedData(
    state: PluginScopedStorageState,
    legacyFiles: string[]
  ): Promise<PluginScopedStorageState> {
    const failures: string[] = [];

    for (const relativePath of legacyFiles) {
      const sourcePath = normalizePath(`${this.legacyBasePath}/${relativePath}`);
      const destinationPath = normalizePath(`${this.roots.dataRoot}/${relativePath}`);

      if (!(await this.app.vault.adapter.exists(destinationPath))) {
        failures.push(`${relativePath}: missing destination file`);
        continue;
      }

      const [sourceContent, destinationContent] = await Promise.all([
        this.app.vault.adapter.read(sourcePath),
        this.app.vault.adapter.read(destinationPath)
      ]);

      if (sourceContent !== destinationContent) {
        failures.push(`${relativePath}: content mismatch`);
      }
    }

    await this.writeVerificationReport({
      generatedAt: Date.now(),
      success: failures.length === 0,
      checkedFiles: legacyFiles,
      failures
    });

    if (failures.length > 0) {
      return this.saveFailureState(state, failures.join('; '));
    }

    const verifiedState: PluginScopedStorageState = {
      ...state,
      migration: {
        ...state.migration,
        state: 'verified',
        completedAt: Date.now(),
        verifiedAt: Date.now(),
        lastError: undefined
      }
    };
    await this.saveState(verifiedState);
    return verifiedState;
  }

  private async saveFailureState(
    state: PluginScopedStorageState,
    errorMessage: string
  ): Promise<PluginScopedStorageState> {
    const failedState: PluginScopedStorageState = {
      ...state,
      sourceOfTruthLocation: 'legacy-dotnexus',
      migration: {
        ...state.migration,
        state: 'failed',
        lastError: errorMessage,
        completedAt: Date.now()
      }
    };
    await this.saveState(failedState);
    return failedState;
  }

  private async collectLegacyFiles(): Promise<string[]> {
    const files = new Set<string>();

    for (const category of STORAGE_CATEGORIES) {
      const categoryFiles = await this.listJsonlFiles(this.legacyBasePath, category);
      for (const relativePath of categoryFiles) {
        files.add(relativePath);
      }
    }

    return Array.from(files).sort();
  }

  private async listJsonlFiles(basePath: string, category: StorageCategory): Promise<string[]> {
    const categoryPath = normalizePath(`${basePath}/${category}`);
    if (!(await this.app.vault.adapter.exists(categoryPath))) {
      return [];
    }

    const listing = await this.app.vault.adapter.list(categoryPath);
    return listing.files
      .filter(filePath => filePath.endsWith('.jsonl'))
      .map(filePath => normalizePath(`${category}/${filePath.split('/').pop() ?? ''}`))
      .filter(relativePath => relativePath.endsWith('.jsonl'));
  }

  private async writeMigrationManifest(files: MigrationManifestFileEntry[]): Promise<void> {
    const manifest: MigrationManifest = {
      generatedAt: Date.now(),
      legacyBasePath: this.legacyBasePath,
      destinationDataRoot: this.roots.dataRoot,
      files
    };

    await this.app.vault.adapter.write(
      normalizePath(`${this.roots.migrationRoot}/manifest.json`),
      JSON.stringify(manifest, null, 2)
    );
  }

  private async writeVerificationReport(report: VerificationReport): Promise<void> {
    await this.app.vault.adapter.write(
      normalizePath(`${this.roots.migrationRoot}/verification.json`),
      JSON.stringify(report, null, 2)
    );
  }

  private async loadState(): Promise<PluginScopedStorageState> {
    const pluginData = await this.loadPluginData();
    return pluginData.pluginStorage ?? this.createDefaultState();
  }

  private async saveState(state: PluginScopedStorageState): Promise<void> {
    await pluginDataLock.acquire(async () => {
      const pluginData = await this.loadPluginData();
      pluginData.pluginStorage = state;
      await this.plugin.saveData(pluginData);
    });
  }

  private async loadPluginData(): Promise<StoredPluginData> {
    const data = await this.plugin.loadData() as StoredPluginData | null;
    if (!isRecord(data)) {
      return {} as StoredPluginData;
    }

    return data as StoredPluginData;
  }

  private createDefaultState(): PluginScopedStorageState {
    return {
      storageVersion: STORAGE_VERSION,
      sourceOfTruthLocation: 'legacy-dotnexus',
      migration: {
        state: 'not_started',
        legacySourcesDetected: [],
        activeDestination: this.roots.dataRoot
      }
    };
  }

  private async ensureDirectory(path: string): Promise<void> {
    if (!path || await this.app.vault.adapter.exists(path)) {
      return;
    }

    await this.app.vault.adapter.mkdir(path);
  }
}
