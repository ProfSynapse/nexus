import type { App } from 'obsidian';
import { SystemGuidesWorkspaceProvider, SYSTEM_GUIDES_WORKSPACE_ID } from '../../src/services/workspace/SystemGuidesWorkspaceProvider';

function createMockVaultOperations() {
  const directories = new Set<string>();
  const files = new Map<string, { content: string; mtime: number }>();
  let clock = 1000;

  const parentPath = (path: string): string | null => {
    const normalized = path.replace(/\/+$/, '');
    const index = normalized.lastIndexOf('/');
    return index === -1 ? null : normalized.slice(0, index);
  };

  return {
    directories,
    files,
    ensureDirectory: jest.fn(async (path: string) => {
      directories.add(path);
      return true;
    }),
    readFile: jest.fn(async (path: string) => files.get(path)?.content ?? null),
    writeFile: jest.fn(async (path: string, content: string) => {
      const parent = parentPath(path);
      if (parent) {
        directories.add(parent);
      }
      files.set(path, { content, mtime: clock += 10 });
      return true;
    }),
    listDirectory: jest.fn(async (path: string) => {
      const prefix = `${path}/`;
      const directFiles = Array.from(files.keys()).filter(filePath => {
        if (!filePath.startsWith(prefix)) {
          return false;
        }

        const relative = filePath.slice(prefix.length);
        return !relative.includes('/');
      });

      const directFolders = Array.from(directories)
        .filter(folderPath => folderPath.startsWith(prefix))
        .filter(folderPath => {
          const relative = folderPath.slice(prefix.length);
          return relative.length > 0 && !relative.includes('/');
        });

      return { files: directFiles, folders: directFolders };
    }),
    getStats: jest.fn(async (path: string) => {
      const file = files.get(path);
      if (!file) {
        return null;
      }

      return {
        size: file.content.length,
        mtime: file.mtime,
        ctime: file.mtime,
        type: 'file' as const
      };
    })
  };
}

describe('SystemGuidesWorkspaceProvider', () => {
  it('installs managed guides and exposes a derived docs workspace payload', async () => {
    const vaultOperations = createMockVaultOperations();
    const app = { vault: { configDir: '.obsidian' } } as unknown as App;
    const provider = new SystemGuidesWorkspaceProvider(
      app,
      '5.0.0',
      vaultOperations as never,
      () => ({ storage: { rootPath: 'Assistant data', maxShardBytes: 1024, schemaVersion: 2 } })
    );

    await provider.ensureGuidesInstalled();
    const summary = await provider.getWorkspaceSummary();
    const payload = await provider.loadWorkspaceData(3);

    expect(summary.id).toBe(SYSTEM_GUIDES_WORKSPACE_ID);
    expect(summary.rootFolder).toBe('Assistant data/guides');
    expect(summary.entrypoint).toBe('Assistant data/guides/index.md');
    expect(vaultOperations.writeFile).toHaveBeenCalledWith(
      'Assistant data/guides/index.md',
      expect.stringContaining('# Assistant guides')
    );
    expect(vaultOperations.writeFile).toHaveBeenCalledWith(
      'Assistant data/guides/_meta/manifest.json',
      expect.any(String)
    );
    expect(payload.workspace.id).toBe(SYSTEM_GUIDES_WORKSPACE_ID);
    expect(payload.data.keyFiles['Assistant data/guides/index.md']).toContain('# Assistant guides');
    expect(payload.data.workspaceStructure).toEqual(expect.arrayContaining([
      'Assistant data/guides/index.md',
      'Assistant data/guides/capabilities.md'
    ]));
    expect(payload.data.workspaceStructure).not.toEqual(expect.arrayContaining([
      expect.stringContaining('_meta/manifest.json')
    ]));
  });
});
