import type { App } from 'obsidian';
import { __setRequestUrlMock } from 'obsidian';
import { SystemGuidesWorkspaceProvider, SYSTEM_GUIDES_WORKSPACE_ID } from '../../src/services/workspace/SystemGuidesWorkspaceProvider';
import { MANAGED_GUIDES } from '../../src/guides/ManagedGuidesCatalog';

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

function createProvider(vaultOperations: ReturnType<typeof createMockVaultOperations>) {
  const app = { vault: { configDir: '.obsidian' } } as unknown as App;
  return new SystemGuidesWorkspaceProvider(
    app,
    '5.0.0',
    vaultOperations as never,
    () => ({ storage: { rootPath: 'Assistant data', maxShardBytes: 1024, schemaVersion: 2 } })
  );
}

describe('SystemGuidesWorkspaceProvider', () => {
  afterEach(() => {
    // Reset requestUrl mock to default no-op after each test
    __setRequestUrlMock(async () => ({
      status: 200,
      headers: {},
      text: '',
      json: {},
      arrayBuffer: new ArrayBuffer(0)
    }));
  });

  it('installs managed guides and exposes a derived docs workspace payload', async () => {
    const vaultOperations = createMockVaultOperations();
    const provider = createProvider(vaultOperations);

    // Default requestUrl returns empty JSON — not a valid manifest, so falls back to hardcoded
    await provider.ensureGuidesInstalled();
    const summary = provider.getWorkspaceSummary();
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

  it('uses remote guides when remote version is newer', async () => {
    const vaultOperations = createMockVaultOperations();
    const provider = createProvider(vaultOperations);

    const remoteContent = '# Remote guide\n\nUpdated from GitHub.';
    __setRequestUrlMock(async () => ({
      status: 200,
      headers: {},
      text: '',
      json: {
        version: '2',
        guides: [
          { path: 'index.md', content: remoteContent },
          { path: 'capabilities.md', content: '# Remote capabilities' }
        ]
      },
      arrayBuffer: new ArrayBuffer(0)
    }));

    await provider.ensureGuidesInstalled();

    // Should have written the remote content, not the hardcoded content
    expect(vaultOperations.writeFile).toHaveBeenCalledWith(
      'Assistant data/guides/index.md',
      remoteContent
    );
    expect(vaultOperations.writeFile).toHaveBeenCalledWith(
      'Assistant data/guides/capabilities.md',
      '# Remote capabilities'
    );

    // Manifest should record version '2' from remote
    const manifestCall = vaultOperations.writeFile.mock.calls.find(
      (call: [string, string]) => call[0].includes('manifest.json')
    );
    expect(manifestCall).toBeDefined();
    const manifest = JSON.parse(manifestCall![1]);
    expect(manifest.version).toBe('2');
  });

  it('falls back to hardcoded guides when remote fetch fails', async () => {
    const vaultOperations = createMockVaultOperations();
    const provider = createProvider(vaultOperations);

    __setRequestUrlMock(async () => {
      throw new Error('Network error');
    });

    await provider.ensureGuidesInstalled();

    // Should use hardcoded content as fallback
    expect(vaultOperations.writeFile).toHaveBeenCalledWith(
      'Assistant data/guides/index.md',
      expect.stringContaining('# Assistant guides')
    );

    // All hardcoded guides should be written
    for (const guide of MANAGED_GUIDES) {
      expect(vaultOperations.writeFile).toHaveBeenCalledWith(
        `Assistant data/guides/${guide.path}`,
        guide.content
      );
    }
  });

  it('falls back to hardcoded guides when remote returns non-200', async () => {
    const vaultOperations = createMockVaultOperations();
    const provider = createProvider(vaultOperations);

    __setRequestUrlMock(async () => ({
      status: 404,
      headers: {},
      text: 'Not Found',
      json: {},
      arrayBuffer: new ArrayBuffer(0)
    }));

    await provider.ensureGuidesInstalled();

    expect(vaultOperations.writeFile).toHaveBeenCalledWith(
      'Assistant data/guides/index.md',
      expect.stringContaining('# Assistant guides')
    );
  });

  it('uses hardcoded guides when remote version is not newer', async () => {
    const vaultOperations = createMockVaultOperations();
    const provider = createProvider(vaultOperations);

    // Remote version same as local (version '1')
    __setRequestUrlMock(async () => ({
      status: 200,
      headers: {},
      text: '',
      json: {
        version: '1',
        guides: [
          { path: 'index.md', content: '# Should not be used' }
        ]
      },
      arrayBuffer: new ArrayBuffer(0)
    }));

    await provider.ensureGuidesInstalled();

    // Should write hardcoded content, not remote
    expect(vaultOperations.writeFile).toHaveBeenCalledWith(
      'Assistant data/guides/index.md',
      expect.stringContaining('# Assistant guides')
    );
    expect(vaultOperations.writeFile).not.toHaveBeenCalledWith(
      'Assistant data/guides/index.md',
      '# Should not be used'
    );
  });

  it('rejects remote manifest with missing guides array', async () => {
    const vaultOperations = createMockVaultOperations();
    const provider = createProvider(vaultOperations);

    __setRequestUrlMock(async () => ({
      status: 200,
      headers: {},
      text: '',
      json: { version: '2' }, // missing guides array
      arrayBuffer: new ArrayBuffer(0)
    }));

    await provider.ensureGuidesInstalled();

    // Falls back to hardcoded
    expect(vaultOperations.writeFile).toHaveBeenCalledWith(
      'Assistant data/guides/index.md',
      expect.stringContaining('# Assistant guides')
    );
  });
});
