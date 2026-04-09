import { App, Plugin, normalizePath } from 'obsidian';
import type { MCPSettings } from '../../types/plugin/PluginTypes';
import {
  resolveCanonicalVaultRoot,
  type CanonicalVaultRootResolution
} from '../storage/CanonicalVaultRootResolver';
import {
  resolvePluginStorageRoot,
  ResolvedPluginStorageRoot
} from '../storage/PluginStoragePathResolver';
import { pluginDataLock } from '../../utils/pluginDataLock';

const STORAGE_VERSION = 1;
const STORAGE_CATEGORIES = ['workspaces', 'conversations', 'tasks'] as const;

type StoredPluginData = MCPSettings & {
  pluginStorage?: PluginScopedStorageState;
};

export type SourceOfTruthLocation = 'legacy-dotnexus' | 'plugin-data' | 'canonical-vault-root';
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
  canonicalWriteBasePath: string;
  legacyReadBasePaths: string[];
  pluginCacheDbPath: string;
  state: PluginScopedStorageState;
  roots: ResolvedPluginStorageRoot;
  canonicalRoot: CanonicalVaultRootResolution;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function buildUniquePaths(...basePaths: string[]): string[] {
  return Array.from(new Set(basePaths.filter(path => typeof path === 'string' && path.trim().length > 0)));
}

/**
 * Runtime storage-plan coordinator for plugin-scoped infrastructure.
 *
 * The canonical event store now lives in a vault-root Nexus directory.
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
   * The runtime always writes canonical data into the configured vault-root
   * Nexus path, while SQLite remains local in plugin data. Legacy plugin-data
   * and `.nexus` roots stay on the read path during migration.
   */
  async prepareStoragePlan(): Promise<PluginScopedStoragePlan> {
    const pluginData = await this.loadPluginData();
    const canonicalRoot = resolveCanonicalVaultRoot(pluginData, { configDir: this.app.vault.configDir });
    const canonicalWriteBasePath = canonicalRoot.resolvedRootPath;
    const legacyReadBasePaths = buildUniquePaths(
      this.roots.dataRoot,
      ...this.roots.compatibilityDataRoots,
      this.legacyBasePath
    );
    const legacySourcesDetected = await this.collectExistingLegacySources(legacyReadBasePaths);
    const state = this.buildRuntimeState(pluginData, canonicalWriteBasePath, legacySourcesDetected);
    await this.saveState(state);
    return {
      canonicalWriteBasePath,
      legacyReadBasePaths,
      pluginCacheDbPath: normalizePath(`${this.roots.dataRoot}/cache.db`),
      state,
      roots: this.roots,
      canonicalRoot
    };
  }

  private buildRuntimeState(
    pluginData: StoredPluginData,
    canonicalWriteBasePath: string,
    legacySourcesDetected: string[]
  ): PluginScopedStorageState {
    const persistedState = pluginData.pluginStorage ?? this.createDefaultState(canonicalWriteBasePath);

    return {
      ...persistedState,
      storageVersion: STORAGE_VERSION,
      sourceOfTruthLocation: 'canonical-vault-root',
      migration: {
        ...persistedState.migration,
        state: 'verified',
        legacySourcesDetected,
        activeDestination: canonicalWriteBasePath,
        completedAt: persistedState.migration.completedAt ?? Date.now(),
        verifiedAt: Date.now(),
        lastError: undefined
      }
    };
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
        return true;
      }
    }

    return false;
  }

  private createDefaultState(activeDestination: string): PluginScopedStorageState {
    return {
      storageVersion: STORAGE_VERSION,
      sourceOfTruthLocation: 'canonical-vault-root',
      migration: {
        state: 'verified',
        legacySourcesDetected: [],
        activeDestination
      }
    };
  }
}
