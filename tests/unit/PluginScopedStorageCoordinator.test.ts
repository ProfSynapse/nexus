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
  it('returns a canonical vault-root write plan with local cache and legacy read roots', async () => {
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
            rootPath: 'storage/nexus',
            maxShardBytes: 2_097_152,
            schemaVersion: 3
          }
        })),
        saveData
      } as never,
      '.nexus'
    );

    const plan = await coordinator.prepareStoragePlan();

    expect(plan.canonicalWriteBasePath).toBe('storage/nexus');
    expect(plan.pluginCacheDbPath).toBe('.obsidian/plugins/claudesidian-mcp/data/cache.db');
    expect(plan.legacyReadBasePaths).toEqual([
      '.obsidian/plugins/claudesidian-mcp/data',
      '.obsidian/plugins/nexus/data',
      '.nexus'
    ]);
    expect(plan.state.sourceOfTruthLocation).toBe('canonical-vault-root');
    expect(plan.state.migration.activeDestination).toBe('storage/nexus');
    expect(plan.canonicalRoot.resolvedRootPath).toBe('storage/nexus');

    expect(saveData).toHaveBeenCalledTimes(1);
    const savedState = saveData.mock.calls[0][0];
    expect(savedState.pluginStorage?.sourceOfTruthLocation).toBe('canonical-vault-root');
    expect(savedState.pluginStorage?.migration.activeDestination).toBe('storage/nexus');
  });

  it('records legacy event roots that still need to be read during migration', async () => {
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

    expect(plan.canonicalWriteBasePath).toBe('Nexus');
    expect(plan.state.sourceOfTruthLocation).toBe('canonical-vault-root');
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
