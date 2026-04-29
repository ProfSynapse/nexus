/**
 * Characterization Tests: findByNameOrId Pattern
 *
 * Documents the current behavior of WorkspaceService's unified lookup methods:
 * - getWorkspaceByNameOrId: ID-first, then case-insensitive name fallback
 * - getSessionByNameOrId: same pattern for sessions within a workspace
 * - getStateByNameOrId: same pattern for states within a session
 *
 * All three follow the same strategy:
 * 1. Try getXxx(identifier) — treats identifier as ID
 * 2. If not found, search by name (case-insensitive)
 * 3. If name match found, call getXxx(matchedId)
 *
 * These tests lock down behavior BEFORE any extraction.
 */

import { WorkspaceService } from '../../src/services/WorkspaceService';
import { createMockPlugin, createMockFileSystem, createMockIndexManager, createMockAdapter } from '../helpers/mockFactories';

function expectDefined<T>(value: T | null | undefined): T {
  expect(value).toBeDefined();
  return value as T;
}

describe('getWorkspaceByNameOrId characterization', () => {
  const plugin = createMockPlugin();

  it('returns workspace when found by ID (adapter path)', async () => {
    const fs = createMockFileSystem();
    const idx = createMockIndexManager();
    const adapter = createMockAdapter(true);

    // getWorkspace returns a result for the ID
    adapter.getWorkspace.mockResolvedValue({
      id: 'ws-id-123', name: 'My Workspace', description: 'desc',
      rootFolder: '/', created: 1000, lastAccessed: 2000, isActive: true,
    });

    const service = new WorkspaceService(plugin, fs, idx, adapter);
    const result = await service.getWorkspaceByNameOrId('ws-id-123');

    expect(result).not.toBeNull();
    expect(expectDefined(result).id).toBe('ws-id-123');
    // Characterization: ID lookup happens first, name lookup is never attempted
    expect(adapter.getWorkspaces).not.toHaveBeenCalled();
  });

  it('falls back to case-insensitive name lookup when ID not found (adapter path)', async () => {
    const fs = createMockFileSystem();
    const idx = createMockIndexManager();
    const adapter = createMockAdapter(true);

    // First call (ID lookup) returns null
    // Second call (after finding by name) returns the workspace
    adapter.getWorkspace
      .mockResolvedValueOnce(null) // ID lookup fails
      .mockResolvedValueOnce({ // Name lookup succeeds, then fetch by matched ID
        id: 'ws-actual-id', name: 'My Workspace', description: 'desc',
        rootFolder: '/', created: 1000, lastAccessed: 2000, isActive: true,
      });

    // Search returns a match by name
    adapter.getWorkspaces.mockResolvedValue({
      items: [
        { id: 'ws-actual-id', name: 'My Workspace', description: 'desc',
          rootFolder: '/', created: 1000, lastAccessed: 2000, isActive: true },
      ],
      page: 0, pageSize: 100, totalItems: 1, totalPages: 1, hasNextPage: false,
    });

    const service = new WorkspaceService(plugin, fs, idx, adapter);
    // Characterization: case-insensitive name match
    const result = await service.getWorkspaceByNameOrId('my workspace');

    expect(result).not.toBeNull();
    expect(expectDefined(result).id).toBe('ws-actual-id');
  });

  it('treats default as an alias for Default Workspace when no literal default ID exists', async () => {
    const fs = createMockFileSystem();
    const idx = createMockIndexManager();
    const adapter = createMockAdapter(true);

    adapter.getWorkspace
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: 'default-workspace-uuid', name: 'Default Workspace', description: 'desc',
        rootFolder: '/', created: 1000, lastAccessed: 2000, isActive: true,
      });

    adapter.getWorkspaces.mockResolvedValue({
      items: [
        { id: 'default-workspace-uuid', name: 'Default Workspace', description: 'desc',
          rootFolder: '/', created: 1000, lastAccessed: 2000, isActive: true },
      ],
      page: 0, pageSize: 100, totalItems: 1, totalPages: 1, hasNextPage: false,
    });

    const service = new WorkspaceService(plugin, fs, idx, adapter);
    const result = await service.getWorkspaceByNameOrId('default');

    expect(result).not.toBeNull();
    expect(expectDefined(result).id).toBe('default-workspace-uuid');
    expect(adapter.getWorkspaces).toHaveBeenCalledWith({
      search: 'Default Workspace',
      pageSize: 100
    });
  });

  it('returns null when neither ID nor name matches (legacy path)', async () => {
    const fs = createMockFileSystem();
    const idx = createMockIndexManager();

    fs.readWorkspace.mockResolvedValue(null); // ID lookup fails
    idx.loadWorkspaceIndex.mockResolvedValue({
      workspaces: {
        'other-ws': { id: 'other-ws', name: 'Other', description: '', rootFolder: '/', created: 1000, lastAccessed: 2000, isActive: true },
      },
      byName: {}, byDescription: {}, byFolder: {},
    });

    const service = new WorkspaceService(plugin, fs, idx, undefined);
    const result = await service.getWorkspaceByNameOrId('nonexistent');

    expect(result).toBeNull();
  });
});

describe('getSessionByNameOrId characterization', () => {
  const plugin = createMockPlugin();

  it('returns session when found by ID (adapter path)', async () => {
    const fs = createMockFileSystem();
    const idx = createMockIndexManager();
    const adapter = createMockAdapter(true);

    adapter.getSession.mockResolvedValue({
      id: 'session-1', workspaceId: 'ws1', name: 'My Session', description: 'desc',
      startTime: 1000, isActive: true,
    });

    const service = new WorkspaceService(plugin, fs, idx, adapter);
    const result = await service.getSessionByNameOrId('ws1', 'session-1');

    expect(result).not.toBeNull();
    expect(expectDefined(result).id).toBe('session-1');
  });

  it('falls back to name lookup when ID not found (legacy path)', async () => {
    const fs = createMockFileSystem();
    const idx = createMockIndexManager();

    fs.readWorkspace
      .mockResolvedValueOnce({ // First read for ID lookup (getSession)
        id: 'ws1', name: 'WS', sessions: {
          's1': { id: 's1', name: 'Target Session', startTime: 1000, isActive: true, memoryTraces: {}, states: {} },
        }, created: 1000, lastAccessed: 2000,
      })
      .mockResolvedValueOnce({ // Second read for name lookup
        id: 'ws1', name: 'WS', sessions: {
          's1': { id: 's1', name: 'Target Session', startTime: 1000, isActive: true, memoryTraces: {}, states: {} },
        }, created: 1000, lastAccessed: 2000,
      });

    const service = new WorkspaceService(plugin, fs, idx, undefined);
    // Characterization: case-insensitive name match
    const result = await service.getSessionByNameOrId('ws1', 'target session');

    expect(result).not.toBeNull();
    expect(expectDefined(result).id).toBe('s1');
    expect(expectDefined(result).name).toBe('Target Session');
  });
});

describe('getStateByNameOrId characterization', () => {
  const plugin = createMockPlugin();

  it('returns state when found by ID (adapter path)', async () => {
    const fs = createMockFileSystem();
    const idx = createMockIndexManager();
    const adapter = createMockAdapter(true);

    adapter.getState.mockResolvedValue({
      id: 'state-1', name: 'My State', created: 1000,
      content: { key: 'value' },
    });

    const service = new WorkspaceService(plugin, fs, idx, adapter);
    const result = await service.getStateByNameOrId('ws1', 's1', 'state-1');

    expect(result).not.toBeNull();
    expect(expectDefined(result).id).toBe('state-1');
    // Characterization: adapter path maps `content` to `state`
    expect(expectDefined(result).state).toEqual({ key: 'value' });
  });

  it('returns null when neither ID nor name matches (legacy path)', async () => {
    const fs = createMockFileSystem();
    const idx = createMockIndexManager();

    fs.readWorkspace.mockResolvedValue({
      id: 'ws1', name: 'WS', sessions: {
        's1': {
          id: 's1', name: 'Session', startTime: 1000, isActive: true,
          memoryTraces: {},
          states: {
            'other-state': { id: 'other-state', name: 'Other State', created: 1000, state: {} },
          },
        },
      }, created: 1000, lastAccessed: 2000,
    });

    const service = new WorkspaceService(plugin, fs, idx, undefined);
    const result = await service.getStateByNameOrId('ws1', 's1', 'nonexistent');

    expect(result).toBeNull();
  });
});
