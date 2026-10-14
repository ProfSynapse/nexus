/**
 * Regression: the default workspace was re-created on every plugin load.
 *
 * Observed live (Obsidian 1.14.4, vault-root install): each reload logged
 *
 *   [SQLiteCacheManager] Run failed: SQLITE_CONSTRAINT_UNIQUE ... workspaces.name
 *   [workspaceRepository] create failed: ...
 *
 * and appended one more `workspace_created` event for `default` to
 * `Nexus/data/workspaces/ws_default/`. DefaultWorkspaceManager initializes in
 * the background while the hybrid adapter is still starting. Its existence
 * check (`getWorkspace` → `withReadableBackend`) fell back to the legacy
 * `.workspaces` index because the adapter was not ready yet — and that index
 * never holds hybrid workspaces — so it answered "missing". The create then
 * waited for the adapter (`resolveWritableAdapter`) and wrote through it,
 * where the workspace had existed all along.
 *
 * The fake adapter below reproduces the part that caused it: it is not ready
 * when the manager starts, becomes ready later, and already holds the
 * workspace. The legacy store is the real WorkspaceService fallback over empty
 * mocks, exactly what a vault-root install has.
 */

import { WorkspaceService } from '../../src/services/WorkspaceService';
import { DefaultWorkspaceManager } from '../../src/services/workspace/DefaultWorkspaceManager';
import { WorkspaceConflictError } from '../../src/database/repositories/interfaces/IWorkspaceRepository';
import type { WorkspaceMetadata } from '../../src/types/storage/HybridStorageTypes';
import type { App } from 'obsidian';
import { createMockPlugin, createMockFileSystem, createMockIndexManager } from '../helpers/mockFactories';

type Row = WorkspaceMetadata;

/**
 * Hybrid adapter stand-in with the real readiness contract: `isReady()` is
 * false until init settles, `isQueryReady()` until hydration settles, and the
 * wait methods resolve when those flip. `createWorkspace` behaves like the
 * repository: a taken id or name is rejected, anything else becomes a row and
 * an event.
 */
function createStartingAdapter(initialRows: Row[]) {
  const rows = new Map(initialRows.map(row => [row.id, row]));
  const events: Array<{ type: 'workspace_created'; id: string }> = [];
  let ready = false;
  let queryReady = false;
  let settle!: () => void;
  const settled = new Promise<void>(resolve => { settle = resolve; });

  const adapter = {
    isReady: () => ready,
    isQueryReady: () => ready && queryReady,
    waitForReady: async () => { await settled; return true; },
    waitForQueryReady: async () => { await settled; return true; },
    getInitError: () => null,
    getWorkspace: jest.fn(async (id: string) => rows.get(id) ?? null),
    getWorkspaces: jest.fn(async (options?: { search?: string }) => {
      const term = options?.search?.toLowerCase() ?? '';
      const items = [...rows.values()].filter(row => row.name.toLowerCase().includes(term));
      return {
        items, page: 0, pageSize: 100, totalItems: items.length, totalPages: 1,
        hasNextPage: false, hasPreviousPage: false
      };
    }),
    createWorkspace: jest.fn(async (data: Omit<Row, 'id'> & { id?: string }) => {
      const id = data.id ?? `ws_${rows.size + 1}`;
      const clash = rows.get(id) ?? [...rows.values()].find(row => row.name === data.name);
      if (clash) {
        throw new WorkspaceConflictError(clash.id === id ? 'id' : 'name', clash.id, data.name);
      }
      rows.set(id, { ...data, id } as Row);
      events.push({ type: 'workspace_created', id });
      return id;
    })
  };

  return {
    adapter,
    rows,
    events,
    /** Finish startup: init, then hydration. */
    becomeReady: () => { ready = true; queryReady = true; settle(); }
  };
}

const EXISTING_DEFAULT: Row = {
  id: 'default',
  name: 'Default Workspace',
  description: 'Default workspace for tool calls without explicit workspace context',
  rootFolder: '/',
  created: 1000,
  lastAccessed: 1000,
  isActive: true
};

function createService(adapter: ReturnType<typeof createStartingAdapter>['adapter']) {
  return new WorkspaceService(
    createMockPlugin(),
    createMockFileSystem() as never,
    createMockIndexManager() as never,
    // A getter, as production wires it.
    () => adapter as never
  );
}

/** Start the manager while storage is still starting, then let storage finish. */
async function initializeDuringStartup(
  store: ReturnType<typeof createStartingAdapter>,
  manager: DefaultWorkspaceManager
): Promise<void> {
  const init = manager.initialize();
  // Let the manager run its existence check against the not-yet-ready adapter.
  for (let i = 0; i < 10; i++) await Promise.resolve();
  store.becomeReady();
  await init;
}

describe('DefaultWorkspaceManager during plugin startup', () => {
  let consoleError: jest.SpyInstance;

  beforeEach(() => {
    consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleError.mockRestore();
  });

  it('does not re-create a default workspace that the event store already holds', async () => {
    const store = createStartingAdapter([EXISTING_DEFAULT]);
    const manager = new DefaultWorkspaceManager({} as App, createService(store.adapter));

    await initializeDuringStartup(store, manager);

    // Pre-fix: one create attempt per load, i.e. one more workspace_created
    // in the source of truth (the real repository appended before failing).
    expect(store.adapter.createWorkspace).not.toHaveBeenCalled();
    expect(store.events).toHaveLength(0);
    expect(consoleError).not.toHaveBeenCalled();
    expect(manager.getDefaultWorkspaceId()).toBe('default');
  });

  it('adopts a legacy default saved under another id instead of duplicating it', async () => {
    const store = createStartingAdapter([{ ...EXISTING_DEFAULT, id: 'ws_legacy_default' }]);
    const manager = new DefaultWorkspaceManager({} as App, createService(store.adapter));

    await initializeDuringStartup(store, manager);

    expect(store.adapter.createWorkspace).not.toHaveBeenCalled();
    expect(manager.getDefaultWorkspaceId()).toBe('ws_legacy_default');
  });

  it('creates the default workspace exactly once on a fresh vault', async () => {
    const store = createStartingAdapter([]);
    const manager = new DefaultWorkspaceManager({} as App, createService(store.adapter));

    await initializeDuringStartup(store, manager);

    expect(store.events).toEqual([{ type: 'workspace_created', id: 'default' }]);
    expect(store.rows.get('default')?.name).toBe('Default Workspace');
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('a second owner after the first has created it finds it rather than creating', async () => {
    // Two plugin-load owners over one store (e.g. a reload racing an unload):
    // the second must see the first one's workspace.
    const store = createStartingAdapter([]);
    const first = new DefaultWorkspaceManager({} as App, createService(store.adapter));
    const second = new DefaultWorkspaceManager({} as App, createService(store.adapter));

    await initializeDuringStartup(store, first);
    await second.initialize();

    expect(store.events).toHaveLength(1);
    expect(store.adapter.createWorkspace).toHaveBeenCalledTimes(1);
    expect(second.getDefaultWorkspaceId()).toBe('default');
  });
});
