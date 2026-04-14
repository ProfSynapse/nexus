import type { Plugin } from 'obsidian';
import { WorkspaceService } from '../../src/services/WorkspaceService';
import { SYSTEM_GUIDES_WORKSPACE_ID } from '../../src/services/workspace/SystemGuidesWorkspaceProvider';
import { createMockAdapter, createMockFileSystem, createMockIndexManager, createMockPlugin } from '../helpers/mockFactories';

function createMockVaultOperations() {
  return {
    ensureDirectory: jest.fn().mockResolvedValue(true),
    readFile: jest.fn(async (path: string) => {
      if (path.endsWith('index.md')) {
        return '# Assistant guides';
      }
      return null;
    }),
    writeFile: jest.fn().mockResolvedValue(true),
    listDirectory: jest.fn(async (path: string) => {
      if (path.endsWith('/guides')) {
        return {
          files: [`${path}/index.md`, `${path}/capabilities.md`],
          folders: [`${path}/_meta`]
        };
      }

      return { files: [], folders: [] };
    }),
    getStats: jest.fn().mockResolvedValue({
      size: 10,
      mtime: 123,
      ctime: 123,
      type: 'file'
    })
  };
}

describe('WorkspaceService system guides workspace', () => {
  function createService() {
    const plugin = createMockPlugin() as Plugin & { app: { vault: { configDir: string } } };
    plugin.app = { vault: { configDir: '.obsidian' } } as never;
    plugin.manifest.version = '5.0.0';

    return new WorkspaceService(
      plugin,
      createMockFileSystem() as never,
      createMockIndexManager() as never,
      createMockAdapter(false),
      {
        vaultOperations: createMockVaultOperations() as never,
        getSettings: () => ({ storage: { rootPath: 'Assistant data', maxShardBytes: 1024, schemaVersion: 2 } })
      }
    );
  }

  it('returns the reserved guides workspace by id and keeps it out of normal listings', async () => {
    const service = createService();

    const systemWorkspace = await service.getWorkspace(SYSTEM_GUIDES_WORKSPACE_ID);
    const listed = await service.listWorkspaces();

    expect(systemWorkspace?.id).toBe(SYSTEM_GUIDES_WORKSPACE_ID);
    expect(systemWorkspace?.rootFolder).toBe('Assistant data/guides');
    expect(listed).toEqual([]);
  });

  it('resolves the reserved guides workspace by name case-insensitively without exposing it in listings', async () => {
    const service = createService();

    const byName = await service.getWorkspaceByNameOrId('Assistant guides');
    const byLowerName = await service.getWorkspaceByNameOrId('assistant guides');
    const listed = await service.listWorkspaces();

    expect(byName?.id).toBe(SYSTEM_GUIDES_WORKSPACE_ID);
    expect(byLowerName?.id).toBe(SYSTEM_GUIDES_WORKSPACE_ID);
    expect(listed).toEqual([]);
  });

  it('rejects mutation attempts for the reserved guides workspace', async () => {
    const service = createService();

    await expect(service.updateWorkspace(SYSTEM_GUIDES_WORKSPACE_ID, { name: 'Nope' } as never))
      .rejects
      .toThrow('system-managed');
  });
});
