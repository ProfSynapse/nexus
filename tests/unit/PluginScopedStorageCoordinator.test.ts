import { PluginScopedStorageCoordinator } from '../../src/database/migration/PluginScopedStorageCoordinator';
import { resolvePluginStorageRoot } from '../../src/database/storage/PluginStoragePathResolver';

type AdapterFileEntry = {
  content?: string;
  mtime: number;
  size: number;
};

type MockAdapter = {
  exists: jest.Mock<Promise<boolean>, [string]>;
  read: jest.Mock<Promise<string>, [string]>;
  write: jest.Mock<Promise<void>, [string, string]>;
  stat: jest.Mock<Promise<{ mtime: number; size: number } | null>, [string]>;
  list: jest.Mock<Promise<{ files: string[]; folders: string[] }>, [string]>;
  mkdir: jest.Mock<Promise<void>, [string]>;
};

function createMockAdapter(initialFiles: Record<string, string>): MockAdapter {
  const files = new Map<string, AdapterFileEntry>();
  const directories = new Set<string>();

  const addDirectoryTree = (path: string): void => {
    const parts = path.split('/').filter(Boolean);
    let current = '';
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      directories.add(current);
    }
  };

  for (const [path, content] of Object.entries(initialFiles)) {
    files.set(path, { content, mtime: Date.now(), size: content.length });
    const parent = path.includes('/') ? path.substring(0, path.lastIndexOf('/')) : '';
    if (parent) {
      addDirectoryTree(parent);
    }
  }

  return {
    exists: jest.fn(async (path: string) => files.has(path) || directories.has(path)),
    read: jest.fn(async (path: string) => {
      const entry = files.get(path);
      if (!entry?.content) {
        throw new Error(`Missing file: ${path}`);
      }
      return entry.content;
    }),
    write: jest.fn(async (path: string, content: string) => {
      const parent = path.includes('/') ? path.substring(0, path.lastIndexOf('/')) : '';
      if (parent) {
        addDirectoryTree(parent);
      }
      files.set(path, { content, mtime: Date.now(), size: content.length });
    }),
    stat: jest.fn(async (path: string) => {
      const entry = files.get(path);
      if (!entry) {
        return null;
      }
      return { mtime: entry.mtime, size: entry.size };
    }),
    list: jest.fn(async (path: string) => {
      const directFiles = Array.from(files.keys()).filter(filePath => filePath.startsWith(`${path}/`));
      return { files: directFiles, folders: [] };
    }),
    mkdir: jest.fn(async (path: string) => {
      addDirectoryTree(path);
    })
  };
}

describe('PluginScopedStorageCoordinator', () => {
  it('returns a not-needed state when no legacy event roots exist', async () => {
    const adapter = createMockAdapter({});
    const saveData = jest.fn(async () => undefined);
    const coordinator = new PluginScopedStorageCoordinator(
      {
        vault: { adapter, configDir: '.obsidian' }
      } as never,
      {
        manifest: {
          id: 'nexus',
          dir: '/mock/.obsidian/plugins/claudesidian-mcp'
        },
        loadData: jest.fn(async () => ({
          storage: {
            rootPath: 'storage/assistant-data',
            maxShardBytes: 2_097_152,
            schemaVersion: 3
          }
        })),
        saveData
      } as never,
      '.nexus'
    );

    const plan = await coordinator.prepareStoragePlan();

    expect(plan.vaultWriteBasePath).toBe('storage/assistant-data/data');
    expect(plan.state.storageVersion).toBe(2);
    expect(plan.pluginCacheDbPath).toBe('.obsidian/plugins/claudesidian-mcp/data/cache.db');
    expect(plan.legacyReadBasePaths).toEqual([
      '.obsidian/plugins/claudesidian-mcp/data',
      '.obsidian/plugins/nexus/data',
      '.nexus'
    ]);
    expect(plan.state.sourceOfTruthLocation).toBe('vault-root');
    expect(plan.state.migration.state).toBe('not_needed');
    expect(plan.state.migration.activeDestination).toBe('storage/assistant-data/data');
    expect(plan.vaultRoot.resolvedPath).toBe('storage/assistant-data');
    expect(plan.vaultRoot.guidesPath).toBe('storage/assistant-data/guides');
    expect(plan.vaultRoot.dataPath).toBe('storage/assistant-data/data');

    expect(saveData).toHaveBeenCalledTimes(1);
    const savedState = saveData.mock.calls[0][0];
    expect(savedState.pluginStorage?.sourceOfTruthLocation).toBe('vault-root');
    expect(savedState.pluginStorage?.storageVersion).toBe(2);
    expect(savedState.pluginStorage?.migration.state).toBe('not_needed');
    expect(savedState.pluginStorage?.migration.activeDestination).toBe('storage/assistant-data/data');
  });

  it('returns a pending state when legacy event roots are detected', async () => {
    const adapter = createMockAdapter({
      '.obsidian/plugins/claudesidian-mcp/data/conversations/conv_alpha.jsonl': '{"id":"plugin-evt"}\n',
      '.nexus/workspaces/ws_alpha.jsonl': '{"id":"legacy-evt"}\n'
    });
    const saveData = jest.fn(async () => undefined);
    const coordinator = new PluginScopedStorageCoordinator(
      {
        vault: { adapter, configDir: '.obsidian' }
      } as never,
      {
        manifest: {
          id: 'nexus',
          dir: '/mock/.obsidian/plugins/claudesidian-mcp'
        },
        loadData: jest.fn(async () => ({})),
        saveData
      } as never,
      '.nexus'
    );

    const plan = await coordinator.prepareStoragePlan();

    expect(plan.vaultWriteBasePath).toBe('Nexus/data');
    expect(plan.state.storageVersion).toBe(2);
    expect(plan.state.sourceOfTruthLocation).toBe('legacy-dotnexus');
    expect(plan.state.migration.state).toBe('pending');
    expect(plan.state.migration.legacySourcesDetected).toEqual([
      '.obsidian/plugins/claudesidian-mcp/data',
      '.nexus'
    ]);
    expect(plan.legacyReadBasePaths).toEqual([
      '.obsidian/plugins/claudesidian-mcp/data',
      '.obsidian/plugins/nexus/data',
      '.nexus'
    ]);
  });

  it('persists verified and failed migration outcomes', async () => {
    const adapter = createMockAdapter({
      '.nexus/conversations/conv_alpha.jsonl': '{"id":"legacy-evt"}\n'
    });

    const saveData = jest.fn(async () => undefined);
    const coordinator = new PluginScopedStorageCoordinator(
      {
        vault: { adapter, configDir: '.obsidian' }
      } as never,
      {
        manifest: {
          id: 'nexus',
          dir: '/mock/.obsidian/plugins/claudesidian-mcp'
        },
        loadData: jest.fn(async () => ({})),
        saveData
      } as never,
      '.nexus'
    );

    const plan = await coordinator.prepareStoragePlan();

    const verified = await coordinator.persistMigrationState(plan, 'verified', {
      completedAt: 123,
      verifiedAt: 456
    });
    expect(verified.sourceOfTruthLocation).toBe('vault-root');
    expect(verified.storageVersion).toBe(2);
    expect(verified.migration.state).toBe('verified');
    expect(verified.migration.completedAt).toBe(123);
    expect(verified.migration.verifiedAt).toBe(456);

    const failed = await coordinator.persistMigrationState(plan, 'failed', {
      completedAt: 789,
      lastError: 'boom'
    });
    expect(failed.sourceOfTruthLocation).toBe('legacy-dotnexus');
    expect(failed.storageVersion).toBe(2);
    expect(failed.migration.state).toBe('failed');
    expect(failed.migration.completedAt).toBe(789);
    expect(failed.migration.lastError).toBe('boom');
  });

  it('downgrades a stale verified state when vault-root has no event data yet legacy roots do', async () => {
    const adapter = createMockAdapter({
      '.obsidian/plugins/claudesidian-mcp/data/conversations/conv_alpha.jsonl': '{"id":"plugin-evt"}\n'
    });
    await adapter.mkdir('Nexus/data/conversations');
    await adapter.mkdir('Nexus/data/workspaces');
    await adapter.mkdir('Nexus/data/tasks');

    const saveData = jest.fn(async () => undefined);
    const coordinator = new PluginScopedStorageCoordinator(
      {
        vault: { adapter, configDir: '.obsidian' }
      } as never,
      {
        manifest: {
          id: 'nexus',
          dir: '/mock/.obsidian/plugins/claudesidian-mcp'
        },
        loadData: jest.fn(async () => ({
          pluginStorage: {
            storageVersion: 2,
            sourceOfTruthLocation: 'vault-root',
            migration: {
              state: 'verified',
              startedAt: 111,
              completedAt: 222,
              verifiedAt: 333,
              legacySourcesDetected: ['.obsidian/plugins/claudesidian-mcp/data'],
              activeDestination: 'Nexus/data'
            }
          }
        })),
        saveData
      } as never,
      '.nexus'
    );

    const plan = await coordinator.prepareStoragePlan();

    expect(plan.state.sourceOfTruthLocation).toBe('legacy-dotnexus');
    expect(plan.state.migration.state).toBe('pending');
    expect(plan.state.migration.startedAt).toBe(111);
    expect(plan.state.migration.lastError).toBe('Vault-root data is missing; migration will rerun.');
  });

  it('retries a previously failed migration on the next boot when legacy roots still exist', async () => {
    const adapter = createMockAdapter({
      '.nexus/conversations/conv_alpha.jsonl': '{"id":"legacy-evt"}\n'
    });

    const saveData = jest.fn(async () => undefined);
    const coordinator = new PluginScopedStorageCoordinator(
      {
        vault: { adapter, configDir: '.obsidian' }
      } as never,
      {
        manifest: {
          id: 'nexus',
          dir: '/mock/.obsidian/plugins/claudesidian-mcp'
        },
        loadData: jest.fn(async () => ({
          pluginStorage: {
            storageVersion: 1,
            sourceOfTruthLocation: 'legacy-dotnexus',
            migration: {
              state: 'failed',
              startedAt: 111,
              completedAt: 222,
              lastError: 'previous failure',
              legacySourcesDetected: ['.nexus'],
              activeDestination: 'Assistant data/data'
            }
          }
        })),
        saveData
      } as never,
      '.nexus'
    );

    const plan = await coordinator.prepareStoragePlan();

    expect(plan.state.migration.state).toBe('pending');
    expect(plan.state.storageVersion).toBe(2);
    expect(plan.state.migration.startedAt).toBe(111);
    expect(plan.state.migration.lastError).toBe('previous failure');
    expect(plan.state.migration.legacySourcesDetected).toEqual(['.nexus']);
    expect(plan.state.sourceOfTruthLocation).toBe('legacy-dotnexus');
  });

  it('resolves the active plugin directory from manifest.dir', () => {
    const roots = resolvePluginStorageRoot(
      {
        vault: {
          configDir: '.obsidian'
        }
      } as never,
      {
        manifest: {
          id: 'nexus',
          dir: '/mock/.obsidian/plugins/claudesidian-mcp'
        }
      } as never
    );

    expect(roots.pluginDir).toBe('.obsidian/plugins/claudesidian-mcp');
    expect(roots.dataRoot).toBe('.obsidian/plugins/claudesidian-mcp/data');
  });
});
