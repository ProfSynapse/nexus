import { App, Plugin, normalizePath } from 'obsidian';
import type { MCPSettings } from '../../types/plugin/PluginTypes';
import {
  resolveVaultRoot,
  type VaultRootResolution
} from '../storage/VaultRootResolver';
import {
  resolvePluginStorageRoot,
  ResolvedPluginStorageRoot
} from '../storage/PluginStoragePathResolver';
import { pluginDataLock } from '../../utils/pluginDataLock';
import { appendMobileMarkdownLog } from './MobileMarkdownLogger';

const STORAGE_VERSION = 2;
const STORAGE_CATEGORIES = ['workspaces', 'conversations', 'tasks'] as const;
const MIGRATION_TRACE_PREFIX = '[NexusMigrationTrace]';

type StoredPluginData = MCPSettings & {
  pluginStorage?: PluginScopedStorageState;
};

export type SourceOfTruthLocation = 'legacy-dotnexus' | 'plugin-data' | 'vault-root';
export type PluginScopedMigrationState = 'not_needed' | 'pending' | 'verified' | 'failed';

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
  vaultWriteBasePath: string;
  legacyReadBasePaths: string[];
  pluginCacheDbPath: string;
  mobileLogPath: string;
  state: PluginScopedStorageState;
  roots: ResolvedPluginStorageRoot;
  vaultRoot: VaultRootResolution;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function buildUniquePaths(...basePaths: string[]): string[] {
  return Array.from(new Set(basePaths.filter(path => typeof path === 'string' && path.trim().length > 0)));
}

function traceMigration(
  app: App,
  mobileLogPath: string,
  message: string,
  details?: unknown
): void {
  if (details !== undefined) {
    console.error(`${MIGRATION_TRACE_PREFIX} ${message}`, details);
    appendMobileMarkdownLog(app, mobileLogPath, message, details);
    return;
  }

  console.error(`${MIGRATION_TRACE_PREFIX} ${message}`);
  appendMobileMarkdownLog(app, mobileLogPath, message);
}

/**
 * Runtime storage-plan coordinator for plugin-scoped infrastructure.
 *
 * The primary event store now lives in a vault-root data directory.
 * SQLite remains local in plugin data, while legacy plugin-data and `.nexus`
 * roots stay available as read fallbacks during migration.
 */
export class PluginScopedStorageCoordinator {
  readonly roots: ResolvedPluginStorageRoot;

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
   * The runtime always writes synced event data into the configured vault-root
   * path, while SQLite remains local in plugin data. Legacy plugin-data and
   * `.nexus` roots stay on the read path during migration.
   */
  async prepareStoragePlan(): Promise<PluginScopedStoragePlan> {
    const pluginData = await this.loadPluginData();
    const vaultRoot = resolveVaultRoot(pluginData, { configDir: this.app.vault.configDir });
    const rootExists = await this.app.vault.adapter.exists(vaultRoot.resolvedPath);
    const vaultWriteBasePath = vaultRoot.dataPath;
    const mobileLogPath = normalizePath(`${vaultWriteBasePath}/_meta/mobile-sync-log.md`);
    const legacyReadBasePaths = buildUniquePaths(
      this.roots.dataRoot,
      ...this.roots.compatibilityDataRoots,
      this.legacyBasePath
    );
    traceMigration(this.app, mobileLogPath, 'prepareStoragePlan', {
      configuredRootPath: vaultRoot.configuredPath,
      resolvedRootPath: vaultRoot.resolvedPath,
      rootExists,
      pluginDataRoot: this.roots.dataRoot,
      legacyReadOrder: legacyReadBasePaths
    });
    if (!rootExists) {
      traceMigration(this.app, mobileLogPath, 'vault root does not exist yet; migration will create it if needed', {
        resolvedRootPath: vaultRoot.resolvedPath
      });
    }
    const legacySourcesDetected = await this.collectExistingLegacySources(legacyReadBasePaths);
    const vaultRootHasEventData = await this.hasEventData(vaultWriteBasePath);
    const state = this.buildRuntimeState(pluginData, vaultWriteBasePath, legacySourcesDetected, vaultRootHasEventData);
    if (
      pluginData.pluginStorage?.migration.state === 'verified'
      && state.migration.state === 'pending'
      && legacySourcesDetected.length > 0
      && !vaultRootHasEventData
    ) {
      traceMigration(this.app, mobileLogPath, 'verified storage state invalidated because vault-root data is missing', {
        vaultWriteBasePath,
        legacySourcesDetected
      });
    }
    traceMigration(this.app, mobileLogPath, 'runtime storage state resolved', {
      sourceOfTruthLocation: state.sourceOfTruthLocation,
      migrationState: state.migration.state,
      activeDestination: state.migration.activeDestination,
      legacySourcesDetected
    });
    await this.saveState(state);
    const plan: PluginScopedStoragePlan = {
      vaultWriteBasePath,
      legacyReadBasePaths,
      pluginCacheDbPath: normalizePath(`${this.roots.dataRoot}/cache.db`),
      mobileLogPath,
      state,
      roots: this.roots,
      vaultRoot
    };
    return plan;
  }

  private buildRuntimeState(
    pluginData: StoredPluginData,
    vaultWriteBasePath: string,
    legacySourcesDetected: string[],
    vaultRootHasEventData: boolean
  ): PluginScopedStorageState {
    const persistedState = pluginData.pluginStorage;

    if (persistedState?.migration.state === 'verified') {
      if (!vaultRootHasEventData && legacySourcesDetected.length > 0) {
        return this.createPendingState(
          vaultWriteBasePath,
          legacySourcesDetected,
          persistedState.migration.startedAt,
          'Vault-root data is missing; migration will rerun.'
        );
      }
      return this.normalizePersistedState(persistedState, vaultWriteBasePath, legacySourcesDetected);
    }

    if (legacySourcesDetected.length === 0) {
      return this.createNotNeededState(vaultWriteBasePath);
    }

    return this.createPendingState(
      vaultWriteBasePath,
      legacySourcesDetected,
      persistedState?.migration.startedAt,
      persistedState?.migration.lastError
    );
  }

  private async saveState(state: PluginScopedStorageState): Promise<void> {
    await pluginDataLock.acquire(async () => {
      const pluginData = await this.loadPluginData();
      pluginData.pluginStorage = state;
      await this.plugin.saveData(pluginData);
    });
  }

  async persistMigrationState(
    plan: PluginScopedStoragePlan,
    migrationState: PluginScopedMigrationState,
    options: {
      completedAt?: number;
      verifiedAt?: number;
      lastError?: string;
    } = {}
  ): Promise<PluginScopedStorageState> {
    const pluginData = await this.loadPluginData();
    const nextState = this.buildPersistedState(
      pluginData.pluginStorage,
      plan.vaultWriteBasePath,
      plan.state.migration.legacySourcesDetected,
      migrationState,
      options
    );
    await this.saveState(nextState);
    traceMigration(this.app, plan.mobileLogPath, 'migration state persisted', {
      migrationState: nextState.migration.state
    });
    return nextState;
  }

  private async loadPluginData(): Promise<StoredPluginData> {
    const data = await this.plugin.loadData() as StoredPluginData | null;
    if (!isRecord(data)) {
      return {} as StoredPluginData;
    }

    return data as StoredPluginData;
  }

  private async collectExistingLegacySources(basePaths: string[]): Promise<string[]> {
    const detected: string[] = [];

    for (const basePath of basePaths) {
      if (await this.hasEventData(basePath)) {
        detected.push(basePath);
      }
    }

    return detected;
  }

  private async hasEventData(basePath: string): Promise<boolean> {
    for (const category of STORAGE_CATEGORIES) {
      const categoryPath = normalizePath(`${basePath}/${category}`);
      if (await this.app.vault.adapter.exists(categoryPath)) {
        const listing = await this.app.vault.adapter.list(categoryPath);
        const hasFiles = listing.files.some(filePath => normalizePath(filePath).startsWith(`${categoryPath}/`));
        const hasFolders = listing.folders.some(folderPath => normalizePath(folderPath).startsWith(`${categoryPath}/`));
        if (hasFiles || hasFolders) {
          return true;
        }
      }
    }
    return false;
  }

  private buildPersistedState(
    persistedState: PluginScopedStorageState | undefined,
    vaultWriteBasePath: string,
    legacySourcesDetected: string[],
    migrationState: PluginScopedMigrationState,
    options: {
      completedAt?: number;
      verifiedAt?: number;
      lastError?: string;
    } = {}
  ): PluginScopedStorageState {
    const baseState = persistedState ?? this.createNotNeededState(vaultWriteBasePath);

    if (migrationState === 'not_needed') {
      return this.createNotNeededState(vaultWriteBasePath);
    }

    if (migrationState === 'pending') {
      return this.createPendingState(
        vaultWriteBasePath,
        legacySourcesDetected,
        baseState.migration.startedAt,
        baseState.migration.lastError
      );
    }

    if (migrationState === 'verified') {
      return {
        storageVersion: STORAGE_VERSION,
        sourceOfTruthLocation: 'vault-root',
        migration: {
          state: 'verified',
          startedAt: baseState.migration.startedAt,
          completedAt: options.completedAt ?? Date.now(),
          verifiedAt: options.verifiedAt ?? Date.now(),
          lastError: undefined,
          legacySourcesDetected,
          activeDestination: vaultWriteBasePath
        }
      };
    }

    return {
      storageVersion: STORAGE_VERSION,
      sourceOfTruthLocation: 'legacy-dotnexus',
      migration: {
        state: 'failed',
        startedAt: baseState.migration.startedAt ?? Date.now(),
        completedAt: options.completedAt ?? Date.now(),
        verifiedAt: undefined,
        lastError: options.lastError,
        legacySourcesDetected,
        activeDestination: vaultWriteBasePath
      }
    };
  }

  private createNotNeededState(activeDestination: string): PluginScopedStorageState {
    return {
      storageVersion: STORAGE_VERSION,
      sourceOfTruthLocation: 'vault-root',
      migration: {
        state: 'not_needed',
        legacySourcesDetected: [],
        activeDestination
      }
    };
  }

  private createPendingState(
    activeDestination: string,
    legacySourcesDetected: string[],
    startedAt?: number,
    lastError?: string
  ): PluginScopedStorageState {
    return {
      storageVersion: STORAGE_VERSION,
      sourceOfTruthLocation: 'legacy-dotnexus',
      migration: {
        state: 'pending',
        startedAt: startedAt ?? Date.now(),
        lastError,
        legacySourcesDetected,
        activeDestination
      }
    };
  }

  private normalizePersistedState(
    persistedState: PluginScopedStorageState,
    vaultWriteBasePath: string,
    legacySourcesDetected: string[]
  ): PluginScopedStorageState {
    const sourceOfTruthLocation: SourceOfTruthLocation =
      persistedState.migration.state === 'verified'
        ? 'vault-root'
        : 'legacy-dotnexus';

    return {
      storageVersion: STORAGE_VERSION,
      sourceOfTruthLocation,
      migration: {
        ...persistedState.migration,
        legacySourcesDetected,
        activeDestination: vaultWriteBasePath
      }
    };
  }
}
