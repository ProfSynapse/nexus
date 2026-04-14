import { resolveAdapter, resolveReadableAdapter, withDualBackend, withReadableBackend } from '../../src/services/helpers/DualBackendExecutor';
import type { IStorageAdapter } from '../../src/database/interfaces/IStorageAdapter';

function createAdapter(overrides: Partial<IStorageAdapter> & { isReady?: () => boolean; isQueryReady?: () => boolean } = {}): IStorageAdapter {
  return {
    isReady: () => true,
    initialize: async () => undefined,
    close: async () => undefined,
    sync: async () => ({
      success: true,
      eventsApplied: 0,
      eventsSkipped: 0,
      errors: [],
      duration: 0,
      filesProcessed: [],
      lastSyncTimestamp: 0
    }),
    getWorkspace: async () => null,
    getWorkspaces: async () => ({ items: [], page: 0, pageSize: 0, totalItems: 0, totalPages: 0, hasNextPage: false, hasPreviousPage: false }),
    createWorkspace: async () => 'ws',
    updateWorkspace: async () => undefined,
    deleteWorkspace: async () => undefined,
    searchWorkspaces: async () => [],
    getSession: async () => null,
    getSessions: async () => ({ items: [], page: 0, pageSize: 0, totalItems: 0, totalPages: 0, hasNextPage: false, hasPreviousPage: false }),
    createSession: async () => 'session',
    updateSession: async () => undefined,
    deleteSession: async () => undefined,
    saveState: async () => 'state',
    getState: async () => null,
    getStates: async () => ({ items: [], page: 0, pageSize: 0, totalItems: 0, totalPages: 0, hasNextPage: false, hasPreviousPage: false }),
    updateState: async () => undefined,
    deleteState: async () => undefined,
    addTrace: async () => 'trace',
    getTraces: async () => ({ items: [], page: 0, pageSize: 0, totalItems: 0, totalPages: 0, hasNextPage: false, hasPreviousPage: false }),
    searchTraces: async () => [],
    deleteTrace: async () => undefined,
    createConversation: async () => 'conv',
    getConversation: async () => null,
    getConversations: async () => ({ items: [], page: 0, pageSize: 0, totalItems: 0, totalPages: 0, hasNextPage: false, hasPreviousPage: false }),
    updateConversation: async () => undefined,
    deleteConversation: async () => undefined,
    addMessage: async () => 'msg',
    getMessages: async () => ({ items: [], page: 0, pageSize: 0, totalItems: 0, totalPages: 0, hasNextPage: false, hasPreviousPage: false }),
    updateMessage: async () => undefined,
    deleteMessage: async () => undefined,
    searchConversations: async () => [],
    getProjects: async () => ({ items: [], page: 0, pageSize: 0, totalItems: 0, totalPages: 0, hasNextPage: false, hasPreviousPage: false }),
    getProject: async () => null,
    createProject: async () => 'project',
    updateProject: async () => undefined,
    deleteProject: async () => undefined,
    getTasks: async () => ({ items: [], page: 0, pageSize: 0, totalItems: 0, totalPages: 0, hasNextPage: false, hasPreviousPage: false }),
    getTask: async () => null,
    createTask: async () => 'task',
    updateTask: async () => undefined,
    deleteTask: async () => undefined,
    searchTasks: async () => [],
    exportConversationsForFineTuning: async () => '',
    exportAllData: async () => ({ conversations: [], workspaces: [], traces: [] }),
    importData: async () => undefined,
    ...overrides
  } as IStorageAdapter;
}

describe('DualBackendExecutor', () => {
  it('resolveAdapter uses basic readiness for write-capable routing', () => {
    const adapter = createAdapter({
      isReady: () => true,
      isQueryReady: () => false
    });

    expect(resolveAdapter(adapter)).toBe(adapter);
  });

  it('resolveReadableAdapter requires query readiness when exposed', () => {
    const adapter = createAdapter({
      isReady: () => true,
      isQueryReady: () => false
    });

    expect(resolveReadableAdapter(adapter)).toBeUndefined();
  });

  it('withReadableBackend falls back to legacy while query hydration is incomplete', async () => {
    const adapter = createAdapter({
      isReady: () => true,
      isQueryReady: () => false
    });

    const result = await withReadableBackend(
      adapter,
      async () => 'adapter',
      async () => 'legacy'
    );

    expect(result).toBe('legacy');
  });

  it('withDualBackend still uses adapter for writes while query hydration is incomplete', async () => {
    const adapter = createAdapter({
      isReady: () => true,
      isQueryReady: () => false
    });

    const result = await withDualBackend(
      adapter,
      async () => 'adapter',
      async () => 'legacy'
    );

    expect(result).toBe('adapter');
  });
});
