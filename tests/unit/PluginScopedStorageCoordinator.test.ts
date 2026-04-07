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

  it('copies verified legacy JSONL data into plugin-scoped storage and cuts over reads and writes', async () => {
    const adapter = createMockAdapter({
      '.nexus/workspaces/ws_alpha.jsonl': '{"id":"evt-ws"}\n',
      '.nexus/conversations/conv_alpha.jsonl': '{"id":"evt-conv"}\n'
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

    expect(plan.writeBasePath).toBe('.obsidian/plugins/claudesidian-mcp/data');
    expect(plan.readBasePaths).toEqual([
      '.obsidian/plugins/claudesidian-mcp/data',
      '.nexus'
    ]);
    expect(plan.state.sourceOfTruthLocation).toBe('plugin-data');
    expect(plan.state.migration.state).toBe('verified');
    expect(adapter.write).toHaveBeenCalledWith(
      '.obsidian/plugins/claudesidian-mcp/data/workspaces/ws_alpha.jsonl',
      '{"id":"evt-ws"}\n'
    );
    expect(adapter.write).toHaveBeenCalledWith(
      '.obsidian/plugins/claudesidian-mcp/data/conversations/conv_alpha.jsonl',
      '{"id":"evt-conv"}\n'
    );
    expect(adapter.exists).toHaveBeenCalledWith('.nexus/workspaces');
    expect(saveData).toHaveBeenCalled();
  });

  it('does not overwrite newer plugin-scoped data and falls back to legacy writes when migration detects conflicts', async () => {
    const adapter = createMockAdapter({
      '.nexus/workspaces/ws_alpha.jsonl': '{"id":"legacy-evt"}\n',
      '.obsidian/plugins/claudesidian-mcp/data/workspaces/ws_alpha.jsonl': '{"id":"plugin-evt","newer":true}\n'
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

    expect(plan.writeBasePath).toBe('.nexus');
    expect(plan.readBasePaths).toEqual(['.nexus']);
    expect(plan.state.sourceOfTruthLocation).toBe('legacy-dotnexus');
    expect(plan.state.migration.state).toBe('failed');
    expect(plan.state.migration.lastError).toContain('destination already exists with different content');
    expect(adapter.write).not.toHaveBeenCalledWith(
      '.obsidian/plugins/claudesidian-mcp/data/workspaces/ws_alpha.jsonl',
      '{"id":"legacy-evt"}\n'
    );
    await expect(
      adapter.read('.obsidian/plugins/claudesidian-mcp/data/workspaces/ws_alpha.jsonl')
    ).resolves.toBe('{"id":"plugin-evt","newer":true}\n');
    expect(saveData).toHaveBeenCalled();
  });
});