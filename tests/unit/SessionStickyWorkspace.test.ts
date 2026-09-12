/**
 * Session-sticky workspace (#214, docs/plans/session-sticky-context-plan.md PR 1).
 *
 * The defect: every call had to restate `workspaceId`, and a caller that
 * copied `"workspaceId":"default"` from an example silently filed a whole
 * session's traces, sessions and states under the wrong workspace. The fix is
 * a server-side contract: a session's workspace is bound once — by an explicit
 * `workspaceId` on a successful `useTools` call, or by a successful
 * `memory load-workspace` — and inherited by every later call in that
 * session, persisted in the vault; an unbound session still fails loudly.
 *
 * Each block below names the failure it buys. The SessionContextManager is
 * REAL throughout; only storage (SessionService), the workspace lookup and the
 * persistence store are stubbed — and none of them supplies the value an
 * assertion depends on, except where the test is about that stub's data
 * (persistence round-trip, storage-miss re-create).
 */

import type { IRequestContext } from '../../src/handlers/interfaces/IRequestHandlerServices';
import type { IAgent } from '../../src/agents/interfaces/IAgent';
import type { ITool } from '../../src/agents/interfaces/ITool';
import { SessionContextManager } from '../../src/services/SessionContextManager';
import type { WorkspaceResolverLike } from '../../src/services/SessionContextManager';
import {
  parsePersistedSessionBindings,
  VaultSessionBindingsStore
} from '../../src/services/session/SessionBindingsStore';
import { WORKSPACE_ID_REQUIRED_MESSAGE } from '../../src/agents/toolManager/services/ToolCliNormalizer';
import { ToolBatchExecutionService } from '../../src/agents/toolManager/services/ToolBatchExecutionService';
import { RequestHandlerFactory } from '../../src/server/handlers/RequestHandlerFactory';
import { AgentExecutionManager } from '../../src/server/execution/AgentExecutionManager';
import { AgentRegistry } from '../../src/server/services/AgentRegistry';
import type { RequestRouter } from '../../src/handlers/RequestRouter';
import type { Server as MCPSDKServer } from '@modelcontextprotocol/sdk/server/index.js';
import type { App } from 'obsidian';
import {
  HeldBindingsStore,
  MemoryBindingsStore,
  getToolsRequest,
  makeManager,
  makeResolver,
  makeSessionService,
  makeStrategy,
  makeToolManagerAgent,
  settle,
  useToolsRequest
} from './helpers/sessionStickyFixtures';

// ---------------------------------------------------------------------------
// Resolution order
// ---------------------------------------------------------------------------

describe('resolution order: explicit → bound → unbound', () => {
  it('explicit beats bound: a call that names a workspace runs there even when the session is bound elsewhere', async () => {
    const { manager } = makeManager();
    manager.bindHandleWorkspace('nexus-cli', 'ws-blog-id');
    const { strategy, batchExecute } = makeStrategy(manager);

    await strategy.handle(useToolsRequest({ workspaceId: 'Research' }));

    expect(batchExecute).toHaveBeenCalledTimes(1);
    expect(batchExecute.mock.calls[0][0].context.workspaceId).toBe('ws-research-id');
  });

  it('bound beats nothing: a call with no workspaceId inherits the session\'s bind', async () => {
    const { manager } = makeManager();
    manager.bindHandleWorkspace('nexus-cli', 'ws-research-id');
    const { strategy, batchExecute } = makeStrategy(manager);

    await strategy.handle(useToolsRequest());

    expect(batchExecute).toHaveBeenCalledTimes(1);
    expect(batchExecute.mock.calls[0][0].context.workspaceId).toBe('ws-research-id');
  });

  it('an empty-string workspaceId counts as absent and inherits, exactly like omitting it (#214)', async () => {
    const { manager } = makeManager();
    manager.bindHandleWorkspace('nexus-cli', 'ws-research-id');
    const { strategy, batchExecute } = makeStrategy(manager);

    await strategy.handle(useToolsRequest({ workspaceId: '   ' }));

    expect(batchExecute.mock.calls[0][0].context.workspaceId).toBe('ws-research-id');
  });

  it('unbound useTools fails with the reworded "pass it once" steer and runs nothing', async () => {
    const { manager } = makeManager();
    const { strategy, captured, batchExecute } = makeStrategy(manager);

    await strategy.handle(useToolsRequest());

    expect(batchExecute).not.toHaveBeenCalled();
    expect(captured.result?.success).toBe(false);
    expect(captured.result?.error).toContain(WORKSPACE_ID_REQUIRED_MESSAGE);
    // The steer teaches "once", never the every-call habit it replaces.
    expect(captured.result?.error).toMatch(/inherit/);
    expect(manager.resolveHandleWorkspace('nexus-cli')).toBeUndefined();
  });

  it('unbound getTools proceeds, partitions the session under "default", and does NOT bind', async () => {
    const { manager, sessionService } = makeManager();
    const { strategy, captured } = makeStrategy(manager);

    await strategy.handle(getToolsRequest());

    expect(captured.result?.success).toBe(true);
    expect(sessionService.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'default', name: 'nexus-cli' })
    );
    // Discovery chose nothing, so nothing is remembered: the next useTools
    // still has to name a workspace once.
    expect(manager.resolveHandleWorkspace('nexus-cli')).toBeUndefined();
  });

  it('the handle partition follows the resolved workspace, so the same handle in two workspaces is two sessions', async () => {
    const { manager, sessionService } = makeManager();
    const { strategy } = makeStrategy(manager);

    await strategy.handle(useToolsRequest({ workspaceId: 'Research' }));
    await strategy.handle(useToolsRequest({ workspaceId: 'Blog' }));

    const created = sessionService.createSession.mock.calls.map(call => call[0].workspaceId);
    expect(created).toEqual(['ws-research-id', 'ws-blog-id']);
  });
});

// ---------------------------------------------------------------------------
// Bind point 1 — explicit workspaceId on a useTools call whose result did not fail
// ---------------------------------------------------------------------------

describe('bind point 1: explicit useTools workspaceId', () => {
  it('binds the handle when the workspace was explicit and the result did not fail', async () => {
    const { manager } = makeManager();
    const { strategy } = makeStrategy(manager);

    await strategy.handle(useToolsRequest({ workspaceId: 'Research' }));

    expect(manager.resolveHandleWorkspace('nexus-cli')).toBe('ws-research-id');
  });

  it('never binds off a returned { success: false } — a rejected workspace is not a choice', async () => {
    // handle() sets its local `success = true` for any non-throwing call, so
    // a bind keyed off that flag would remember the very value the batch
    // service just refused. The check must read the result.
    const { manager } = makeManager();
    const { strategy, captured } = makeStrategy(manager, () =>
      makeToolManagerAgent(() => ({ success: false, error: 'Invalid workspace "Nope".' }))
    );

    await strategy.handle(useToolsRequest({ workspaceId: 'Nope' }));

    expect(captured.result?.success).toBe(false);
    expect(manager.resolveHandleWorkspace('nexus-cli')).toBeUndefined();
  });

  it('never binds off a thrown error either', async () => {
    const { manager } = makeManager();
    const { strategy } = makeStrategy(manager, () =>
      makeToolManagerAgent(() => { throw new Error('boom'); })
    );

    await strategy.handle(useToolsRequest({ workspaceId: 'Research' }));

    expect(manager.resolveHandleWorkspace('nexus-cli')).toBeUndefined();
  });

  it('an inherited workspace is not a new choice: no re-bind, and no bind for getTools', async () => {
    const { manager } = makeManager();
    manager.bindHandleWorkspace('nexus-cli', 'ws-research-id');
    const bind = jest.spyOn(manager, 'bindHandleWorkspace');
    const { strategy } = makeStrategy(manager);

    await strategy.handle(useToolsRequest());
    await strategy.handle(getToolsRequest({ workspaceId: 'Blog' }));

    expect(bind).not.toHaveBeenCalled();
    expect(manager.resolveHandleWorkspace('nexus-cli')).toBe('ws-research-id');
  });

  it('switching is the same gesture as choosing: pass a different value once', async () => {
    const { manager } = makeManager();
    const { strategy, batchExecute } = makeStrategy(manager);

    await strategy.handle(useToolsRequest({ workspaceId: 'Research' }));
    await strategy.handle(useToolsRequest({ workspaceId: 'Blog' }));
    await strategy.handle(useToolsRequest());

    expect(batchExecute.mock.calls.map(call => call[0].context.workspaceId))
      .toEqual(['ws-research-id', 'ws-blog-id', 'ws-blog-id']);
  });

  it('binds the display handle too when the caller\'s handle was renamed, so the renamed name also inherits', async () => {
    const sessionService = makeSessionService();
    sessionService.getAllSessions.mockResolvedValue([{ id: 's-other', workspaceId: 'ws-research-id', name: 'nexus-cli' }]);
    const { manager } = makeManager({ sessionService });
    const { strategy, captured } = makeStrategy(manager);

    await strategy.handle(useToolsRequest({ workspaceId: 'Research' }));

    expect(captured.sessionInfo?.displaySessionId).toBe('nexus-cli-2');
    expect(manager.resolveHandleWorkspace('nexus-cli')).toBe('ws-research-id');
    expect(manager.resolveHandleWorkspace('nexus-cli-2')).toBe('ws-research-id');
  });
});

// ---------------------------------------------------------------------------
// Bind point 2 — a successful `memory load-workspace` inside a batch
// ---------------------------------------------------------------------------

describe('bind point 2: memory load-workspace', () => {
  function makeLoadWorkspaceBatch(loadResult: () => unknown, manager: SessionContextManager) {
    const loadWorkspace: ITool = {
      slug: 'loadWorkspace',
      name: 'Load Workspace',
      description: '',
      version: '1.0.0',
      execute: jest.fn(async () => loadResult()),
      getParameterSchema: jest.fn().mockReturnValue({}),
      getResultSchema: jest.fn().mockReturnValue({}),
      getExecutionPolicy: () => ({ effect: 'read', parallelSafe: true, replay: 'never' } as never)
    } as unknown as ITool;
    const memoryManager: IAgent = {
      name: 'memoryManager',
      description: '',
      version: '1.0.0',
      getTools: () => [loadWorkspace],
      getTool: (slug: string) => (slug === 'loadWorkspace' ? loadWorkspace : undefined),
      initialize: jest.fn(),
      executeTool: jest.fn(),
      setAgentManager: jest.fn()
    };
    // The batch service reaches the manager the way it reaches WorkspaceService:
    // getNexusPlugin(app) → plugin.getService('sessionContextManager').
    const app = {
      plugins: {
        getPlugin: () => ({
          getService: async (name: string) => (name === 'sessionContextManager' ? manager : null)
        })
      }
    } as unknown as App;
    const service = new ToolBatchExecutionService(app, new Map([['memoryManager', memoryManager]]));
    return { service, execute: loadWorkspace.execute as jest.Mock };
  }

  const LOADED_RESEARCH = {
    success: true,
    data: { context: { name: 'Research', rootFolder: 'Research', recentActivity: [] } },
    workspaceContext: { workspaceId: 'ws-research-id', workspacePath: [] },
    resolution: {
      requested: 'Reserch',
      autoResolved: true,
      resolvedTo: { id: 'ws-research-id', name: 'Research' },
      note: 'No workspace is named Reserch.'
    }
  };

  async function run(service: ToolBatchExecutionService, sessionId: string) {
    return service.execute({
      context: { workspaceId: 'default', sessionId, memory: 'm', goal: 'g' },
      calls: [{ agent: 'memoryManager', tool: 'loadWorkspace', params: { workspace: 'Reserch' } }]
    });
  }

  it('a near-miss load binds the RESOLVED workspace\'s id, not the typo the caller sent', async () => {
    const { manager } = makeManager();
    // Give the internal id a friendly handle so the by-id bind can reach it.
    const validated = await manager.validateSessionId('nexus-cli', undefined, 'default');
    const { service } = makeLoadWorkspaceBatch(() => LOADED_RESEARCH, manager);

    const result = await run(service, validated.id);

    expect(result.success).toBe(true);
    expect(manager.resolveHandleWorkspace('nexus-cli')).toBe('ws-research-id');
    expect(manager.resolveHandleWorkspace(validated.id)).toBe('ws-research-id');
    expect(manager.resolveHandleWorkspace('Reserch')).toBeUndefined();
  });

  it('falls back to the resolved name and canonicalises it when the result carries no workspaceContext', async () => {
    const { manager } = makeManager();
    const validated = await manager.validateSessionId('nexus-cli', undefined, 'default');
    const { workspaceContext: _stripped, ...withoutContext } = LOADED_RESEARCH;
    const { service } = makeLoadWorkspaceBatch(() => ({
      ...withoutContext,
      resolution: { ...withoutContext.resolution, resolvedTo: { name: 'Research' } }
    }), manager);

    await run(service, validated.id);

    expect(manager.resolveHandleWorkspace('nexus-cli')).toBe('ws-research-id');
  });

  it('a failed load binds nothing', async () => {
    const { manager } = makeManager();
    const validated = await manager.validateSessionId('nexus-cli', undefined, 'default');
    const { service } = makeLoadWorkspaceBatch(() => ({
      success: false,
      error: 'Workspace not found',
      data: { context: { name: 'Unknown', rootFolder: '', recentActivity: [] } }
    }), manager);

    const result = await run(service, validated.id);

    expect(result.success).toBe(false);
    expect(manager.resolveHandleWorkspace('nexus-cli')).toBeUndefined();
  });

  it('the bind then feeds resolution: the next call in that session inherits the loaded workspace', async () => {
    const { manager } = makeManager();
    const { strategy: first, batchExecute } = makeStrategy(manager);
    // First call: explicit default so it runs; the batch (stubbed here) is
    // where load-workspace would execute. Simulate its bind by id.
    await first.handle(useToolsRequest({ workspaceId: 'default', tool: 'memory load-workspace Reserch' }));
    const internalId = batchExecute.mock.calls[0][0].context.sessionId as string;
    manager.bindSessionWorkspaceById(internalId, 'ws-research-id');

    await first.handle(useToolsRequest());

    expect(batchExecute.mock.calls[1][0].context.workspaceId).toBe('ws-research-id');
  });

  it('when both bind points fire in one call, the loaded workspace wins over the explicit workspaceId', async () => {
    // `nexus use --workspace Blog -- memory load-workspace Research`: bind
    // point 2 binds Research while the batch runs; bind point 1 runs after
    // and must not overwrite it with Blog — loading is the more deliberate
    // act and it happened later in the same call.
    const { manager } = makeManager();
    const { strategy } = makeStrategy(manager, () => makeToolManagerAgent((params) => {
      manager.bindSessionWorkspaceById(params.context.sessionId as string, 'ws-research-id');
      return { success: true };
    }));

    await strategy.handle(useToolsRequest({ workspaceId: 'Blog', tool: 'memory load-workspace Research' }));

    expect(manager.resolveHandleWorkspace('nexus-cli')).toBe('ws-research-id');
  });
});

// ---------------------------------------------------------------------------
// Canonical ids
// ---------------------------------------------------------------------------

describe('canonicalisation', () => {
  it('a name and its id bind to the same canonical id', async () => {
    const { manager } = makeManager();
    expect(await manager.canonicalizeWorkspaceId('Research')).toBe('ws-research-id');
    expect(await manager.canonicalizeWorkspaceId('research')).toBe('ws-research-id');
    expect(await manager.canonicalizeWorkspaceId('ws-research-id')).toBe('ws-research-id');
  });

  it('"default" passes through without a lookup', async () => {
    const resolver = makeResolver();
    const { manager } = makeManager({ resolver });
    expect(await manager.canonicalizeWorkspaceId(' default ')).toBe('default');
    expect(resolver.getWorkspaceByNameOrId).not.toHaveBeenCalled();
  });

  it('an unresolvable value stays raw so the batch service can reject it with its steer', async () => {
    const { manager } = makeManager();
    expect(await manager.canonicalizeWorkspaceId('Nope')).toBe('Nope');
  });

  it('a lookup that throws degrades to the raw value instead of failing the call', async () => {
    const resolver: WorkspaceResolverLike = {
      getWorkspaceByNameOrId: jest.fn().mockRejectedValue(new Error('storage cold'))
    };
    const { manager } = makeManager({ resolver });
    expect(await manager.canonicalizeWorkspaceId('Research')).toBe('Research');
  });

  it('the handle partition and the bind both use the canonical id, whichever spelling the caller used', async () => {
    const { manager, sessionService } = makeManager();
    const { strategy } = makeStrategy(manager);

    await strategy.handle(useToolsRequest({ workspaceId: 'Research' }));
    await strategy.handle(useToolsRequest({ workspaceId: 'ws-research-id', sessionId: 'other' }));

    expect(sessionService.createSession.mock.calls.map(call => call[0].workspaceId))
      .toEqual(['ws-research-id', 'ws-research-id']);
    expect(manager.resolveHandleWorkspace('nexus-cli')).toBe('ws-research-id');
    expect(manager.resolveHandleWorkspace('other')).toBe('ws-research-id');
  });
});

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

describe('persistence: session-bindings.json', () => {
  it('handles and bindings round-trip through the store, and a restored handle resumes its session (no -2)', async () => {
    const store = new MemoryBindingsStore();
    const sessionService = makeSessionService();
    const { manager: before } = makeManager({ store, sessionService });
    const { strategy } = makeStrategy(before);

    await strategy.handle(useToolsRequest({ workspaceId: 'Research' }));
    const firstId = sessionService.createSession.mock.calls[0][0].id as string;
    await before.flushBindings();

    expect(store.doc?.handleWorkspace['nexus-cli']).toBe('ws-research-id');
    expect(store.doc?.handles['ws-research-id::nexus-cli']?.id).toBe(firstId);

    // "Reload": a fresh manager over the same store. Storage still lists the
    // session, so the handle must resume it — this is the exact scenario that
    // used to rename the CLI's session to nexus-cli-2 on every plugin reload.
    const afterService = makeSessionService();
    afterService.getAllSessions.mockImplementation(async (workspaceId: string) =>
      workspaceId === 'ws-research-id' ? [{ id: firstId, workspaceId, name: 'nexus-cli' }] : []
    );
    const { manager: after } = makeManager({ store, sessionService: afterService });

    expect(await after.resolveWorkspaceForSession(undefined, 'nexus-cli'))
      .toEqual({ workspaceId: 'ws-research-id', explicit: false });
    const resumed = await after.validateSessionId('nexus-cli', undefined, 'ws-research-id');
    expect(resumed.id).toBe(firstId);
    expect(resumed.created).toBe(false);
    expect(resumed.displaySessionId).toBe('nexus-cli');
    expect(afterService.createSession).not.toHaveBeenCalled();
  });

  // A restored handle is never dropped on a storage miss. `getAllSessions`
  // returns [] while storage is still hydrating after a reload, and a call a
  // few seconds in saw exactly that: the handle was dropped and a new id
  // minted — the regression this map exists to prevent. Continuity wins: the
  // same id is kept either way. Only a DEFINITE delete (a non-empty list that
  // lacks the id) re-creates the record; an empty list is ambiguous between
  // cold and empty, and re-creating there would append a duplicate
  // session_created event to the JSONL source of truth on every cold reload.
  it('a restored handle whose session was deleted (non-empty list without it) keeps the SAME id and re-creates the record with it', async () => {
    const store = new MemoryBindingsStore();
    store.doc = {
      handles: { 'default::nexus-cli': { id: 's-20260101000000', displaySessionId: 'nexus-cli', workspaceId: 'default' } },
      handleWorkspace: { 'nexus-cli': 'default' },
      cliCurrentSession: null
    };
    const sessionService = makeSessionService();
    // Storage is warm — it lists another session — and ours is not there.
    sessionService.getAllSessions.mockResolvedValue([{ id: 's-20260101000001', workspaceId: 'default', name: 'other' }]);
    const { manager } = makeManager({ store, sessionService });

    const result = await manager.validateSessionId('nexus-cli', 'resumed after reload', 'default');

    expect(result.id).toBe('s-20260101000000');
    expect(result.created).toBe(false);
    expect(result.displaySessionId).toBe('nexus-cli');
    expect(sessionService.createSession).toHaveBeenCalledTimes(1);
    expect(sessionService.createSession).toHaveBeenCalledWith({
      id: 's-20260101000000',
      name: 'nexus-cli',
      description: 'resumed after reload',
      workspaceId: 'default'
    });
    await manager.flushBindings();
    expect(store.doc?.handles['default::nexus-cli']?.id).toBe('s-20260101000000');
  });

  it('cold storage (empty list, then warm) never renames and does NOT re-create: same id every call, check runs once', async () => {
    const store = new MemoryBindingsStore();
    store.doc = {
      handles: { 'ws-research-id::live-check': { id: 's-20260912194746', displaySessionId: 'live-check', workspaceId: 'ws-research-id' } },
      handleWorkspace: { 'live-check': 'ws-research-id' },
      cliCurrentSession: 'live-check'
    };
    const sessionService = makeSessionService();
    sessionService.getAllSessions.mockResolvedValueOnce([]); // ~3 s after reload: still hydrating
    sessionService.getAllSessions.mockResolvedValue([{ id: 's-20260912194746', workspaceId: 'ws-research-id', name: 'live-check' }]);
    const { manager } = makeManager({ store, sessionService });

    const cold = await manager.validateSessionId('live-check', undefined, 'ws-research-id');
    const warm = await manager.validateSessionId('live-check', undefined, 'ws-research-id');

    expect(cold.id).toBe('s-20260912194746');
    expect(cold.displaySessionId).toBe('live-check');
    expect(cold.displaySessionIdChanged).toBe(false);
    expect(warm).toEqual(cold);
    expect(sessionService.getAllSessions).toHaveBeenCalledTimes(1);
    // The empty list is ambiguous (cold or empty workspace): no re-create,
    // so a cold reload never appends a duplicate session_created event.
    expect(sessionService.createSession).not.toHaveBeenCalled();
    expect(await manager.resolveWorkspaceForSession(undefined, 'live-check'))
      .toEqual({ workspaceId: 'ws-research-id', explicit: false });
  });

  it('a failed re-create (e.g. workspace not found) only logs; the handle is still kept', async () => {
    const store = new MemoryBindingsStore();
    store.doc = {
      handles: { 'ws-research-id::live-check': { id: 's-20260912194746', displaySessionId: 'live-check', workspaceId: 'ws-research-id' } },
      handleWorkspace: {},
      cliCurrentSession: null
    };
    const sessionService = makeSessionService();
    sessionService.getAllSessions.mockResolvedValue([{ id: 's-other', workspaceId: 'ws-research-id', name: 'other' }]);
    sessionService.createSession.mockRejectedValue(new Error('Workspace ws-research-id not found'));
    const { manager } = makeManager({ store, sessionService });

    const result = await manager.validateSessionId('live-check', undefined, 'ws-research-id');

    expect(result.id).toBe('s-20260912194746');
    expect(result.created).toBe(false);
    expect(manager.describeHandle('live-check', 'ws-research-id')?.id).toBe('s-20260912194746');
  });

  it('a storage lookup that throws keeps the restored handle rather than renaming a live session', async () => {
    const store = new MemoryBindingsStore();
    store.doc = {
      handles: { 'default::nexus-cli': { id: 's-20260101000000', displaySessionId: 'nexus-cli', workspaceId: 'default' } },
      handleWorkspace: {},
      cliCurrentSession: null
    };
    const sessionService = makeSessionService();
    sessionService.getAllSessions.mockRejectedValue(new Error('storage cold'));
    const { manager } = makeManager({ store, sessionService });

    const result = await manager.validateSessionId('nexus-cli', undefined, 'default');

    expect(result.id).toBe('s-20260101000000');
    expect(result.created).toBe(false);
  });

  it('a corrupt file loads as empty without throwing', async () => {
    const adapter = {
      exists: jest.fn().mockResolvedValue(true),
      read: jest.fn().mockResolvedValue('{ not json'),
      write: jest.fn(),
      mkdir: jest.fn()
    };
    const store = new VaultSessionBindingsStore(adapter as never, '.obsidian/plugins/nexus/data/session-bindings.json');

    await expect(store.load()).resolves.toBeNull();

    const { manager } = makeManager({ store });
    await expect(manager.resolveWorkspaceForSession(undefined, 'nexus-cli'))
      .resolves.toEqual({ workspaceId: undefined, explicit: false });
  });

  it('a foreign or half-typed document is filtered field by field, never trusted wholesale', () => {
    expect(parsePersistedSessionBindings(null)).toBeNull();
    expect(parsePersistedSessionBindings([])).toBeNull();
    expect(parsePersistedSessionBindings({
      handles: { ok: { id: 'a', displaySessionId: 'b', workspaceId: 'c' }, bad: { id: 1 } },
      handleWorkspace: { h: 'ws', blank: '   ', wrong: 7 },
      cliCurrentSession: ' research '
    })).toEqual({
      handles: { ok: { id: 'a', displaySessionId: 'b', workspaceId: 'c' } },
      handleWorkspace: { h: 'ws' },
      cliCurrentSession: 'research'
    });
  });

  // Persistence is write-through, not debounced: a 300 ms timer sat pending
  // for minutes while Obsidian was in the background (Electron throttles
  // background renderer timers, and the CLI runs precisely then), so the file
  // lagged the in-memory state. No timers anywhere in this block — the
  // HeldBindingsStore controls what is in flight.
  it('the first change writes immediately, with no timer to wait on', async () => {
    const store = new HeldBindingsStore();
    const { manager } = makeManager({ store });

    manager.bindHandleWorkspace('a', 'ws-research-id');

    expect(store.started).toHaveLength(1);
    expect(store.started[0].handleWorkspace).toEqual({ a: 'ws-research-id' });
  });

  it('a burst of N binds while a write is in flight produces exactly 2 writes, and the second carries all N', async () => {
    const store = new HeldBindingsStore();
    const { manager } = makeManager({ store });

    manager.bindHandleWorkspace('a', 'ws-research-id'); // write 1 starts, held
    manager.bindHandleWorkspace('b', 'ws-blog-id');
    manager.bindHandleWorkspace('c', 'default');
    manager.setCliCurrentSession('c');
    expect(store.started).toHaveLength(1);

    expect(store.release()).toBe(true); // write 1 settles
    await settle();

    // One follow-up, snapshotting the state as it stands now — not one write
    // per change, and not a stale copy taken when the changes happened.
    expect(store.started).toHaveLength(2);
    expect(Object.keys(store.started[1].handleWorkspace)).toEqual(['a', 'b', 'c']);
    expect(store.started[1].cliCurrentSession).toBe('c');

    expect(store.release()).toBe(true);
    await settle();
    expect(store.started).toHaveLength(2);
    expect(store.doc?.handleWorkspace).toEqual({ a: 'ws-research-id', b: 'ws-blog-id', c: 'default' });
  });

  it('flushBindings resolves once the changes made during an in-flight write are on disk', async () => {
    const store = new HeldBindingsStore();
    const { manager } = makeManager({ store });

    manager.bindHandleWorkspace('a', 'ws-research-id');
    manager.bindHandleWorkspace('b', 'ws-blog-id');
    let flushed = false;
    const flush = manager.flushBindings().then(() => { flushed = true; });

    store.release();
    await settle();
    expect(flushed).toBe(false); // the follow-up carrying b is still in flight

    store.release();
    await flush;
    expect(store.doc?.handleWorkspace).toEqual({ a: 'ws-research-id', b: 'ws-blog-id' });

    // Nothing in flight: flush writes now, so a caller can rely on "current
    // state is on disk" without knowing the writer's history.
    const second = manager.flushBindings();
    expect(store.started).toHaveLength(3);
    store.release();
    await second;
  });

  it('cleanup snapshots before the maps are cleared and writes it after the in-flight write, never the emptied state', async () => {
    const store = new HeldBindingsStore();
    const { manager } = makeManager({ store });

    manager.bindHandleWorkspace('a', 'ws-research-id'); // held
    manager.bindHandleWorkspace('d', 'default');       // dirty
    manager.cleanup();                                  // maps now empty

    expect(store.started).toHaveLength(1);
    store.release();
    await settle();

    expect(store.started).toHaveLength(2);
    expect(store.started[1].handleWorkspace).toEqual({ a: 'ws-research-id', d: 'default' });
    store.release();
    await settle();
    expect(store.doc?.handleWorkspace.d).toBe('default');
    expect(store.inFlight).toBe(0);
  });

  it('the vault store creates the data folder and writes through the adapter, never Node fs', async () => {
    const files = new Map<string, string>();
    const dirs = new Set<string>();
    const adapter = {
      exists: jest.fn(async (p: string) => files.has(p) || dirs.has(p)),
      read: jest.fn(async (p: string) => files.get(p) ?? ''),
      write: jest.fn(async (p: string, data: string) => { files.set(p, data); }),
      mkdir: jest.fn(async (p: string) => { dirs.add(p); })
    };
    const path = '.obsidian/plugins/nexus/data/session-bindings.json';
    const store = new VaultSessionBindingsStore(adapter as never, path);

    await store.save({ handles: {}, handleWorkspace: { 'nexus-cli': 'ws-research-id' }, cliCurrentSession: null });

    expect(adapter.mkdir).toHaveBeenCalledWith('.obsidian/plugins/nexus/data');
    expect(await store.load()).toEqual({
      handles: {},
      handleWorkspace: { 'nexus-cli': 'ws-research-id' },
      cliCurrentSession: null
    });
  });
});

// ---------------------------------------------------------------------------
// clientName — the per-connection hook PR 2 keys the CLI default off
// ---------------------------------------------------------------------------

describe('clientName from the MCP initialize handshake', () => {
  function captureToolsCall(getClientVersion: (() => { name: string; version: string } | undefined) | undefined) {
    const handlers = new Map<string, (request: unknown) => Promise<unknown>>();
    const server = {
      setRequestHandler: jest.fn((schema: { shape?: { method?: { value?: string } } }, handler: (r: unknown) => Promise<unknown>) => {
        // The SDK schemas expose the literal method under shape.method.value.
        handlers.set(schema.shape?.method?.value ?? String(handlers.size), handler);
      }),
      ...(getClientVersion ? { getClientVersion } : {})
    } as unknown as MCPSDKServer;
    const handleRequest = jest.fn(async () => ({ content: [] }));
    const router = { handleRequest } as unknown as RequestRouter;
    new RequestHandlerFactory(server, router).initializeHandlers();
    const toolsCall = handlers.get('tools/call');
    if (!toolsCall) throw new Error('tools/call handler was not registered');
    return { toolsCall, handleRequest };
  }

  it('attaches clientName from getClientVersion(), outside the tool arguments', async () => {
    const { toolsCall, handleRequest } = captureToolsCall(() => ({ name: 'nexus-cli', version: '0.1.0' }));

    await toolsCall({ params: { name: 'toolManager_getTools', arguments: { tool: '--help' } } });

    const routed = handleRequest.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(routed[0]).toBe('tools/call');
    expect(routed[1].clientName).toBe('nexus-cli');
    expect((routed[1].params as { arguments: Record<string, unknown> }).arguments).not.toHaveProperty('clientName');
  });

  it('is absent when the SDK has no client info, and when the method itself is missing', async () => {
    const noInfo = captureToolsCall(() => undefined);
    await noInfo.toolsCall({ params: { name: 'toolManager_getTools', arguments: { tool: '--help' } } });
    expect((noInfo.handleRequest.mock.calls[0] as unknown as [string, Record<string, unknown>])[1].clientName).toBeUndefined();

    const noMethod = captureToolsCall(undefined);
    await noMethod.toolsCall({ params: { name: 'toolManager_getTools', arguments: { tool: '--help' } } });
    expect((noMethod.handleRequest.mock.calls[0] as unknown as [string, Record<string, unknown>])[1].clientName).toBeUndefined();
  });

  it('is threaded onto IRequestContext by the strategy', async () => {
    const { manager } = makeManager();
    const { strategy } = makeStrategy(manager);
    const build = (strategy as unknown as {
      buildRequestContext(request: unknown): Promise<IRequestContext>;
    }).buildRequestContext.bind(strategy);

    const withName = await build({ ...getToolsRequest(), clientName: 'nexus-cli' });
    const withoutName = await build(getToolsRequest());

    expect(withName.clientName).toBe('nexus-cli');
    expect(withoutName.clientName).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// AgentExecutionManager — the direct-form chat path uses the same resolution
// ---------------------------------------------------------------------------

describe('AgentExecutionManager.processSessionContext shares the resolution order', () => {
  function makeDirectFormManager(manager: SessionContextManager) {
    const tool = {
      slug: 'runStub',
      name: 'stub',
      description: '',
      version: '1.0.0',
      execute: jest.fn(async () => ({ success: true })),
      getParameterSchema: jest.fn(),
      getResultSchema: jest.fn()
    } as unknown as ITool;
    const agent: IAgent = {
      name: 'stubAgent',
      description: '',
      version: '1.0.0',
      getTools: () => [tool],
      getTool: (slug: string) => (slug === 'runStub' ? tool : undefined),
      initialize: jest.fn(),
      executeTool: jest.fn(async () => ({ success: true })),
      setAgentManager: jest.fn()
    };
    const registry = new AgentRegistry();
    (registry as unknown as { registerAgent: (a: IAgent) => void }).registerAgent(agent);
    return new AgentExecutionManager(registry, manager);
  }

  it('partitions a direct-form chat handle under the chat\'s context.workspaceId, not silently under default', async () => {
    // DirectToolExecutor fills `context.workspaceId` from the chat selection;
    // the old top-level-only read ignored it and filed every such handle
    // under 'default'.
    const { manager, sessionService } = makeManager();
    const aem = makeDirectFormManager(manager);

    await aem.executeAgentTool('stubAgent', 'runStub', {
      sessionId: 'chat handle',
      context: { sessionId: 'chat handle', workspaceId: 'Research' }
    });

    expect(sessionService.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'chat handle', workspaceId: 'ws-research-id' })
    );
  });

  it('falls back to the handle\'s bind when the call names no workspace at all', async () => {
    const { manager, sessionService } = makeManager();
    manager.bindHandleWorkspace('chat handle', 'ws-blog-id');
    const aem = makeDirectFormManager(manager);

    await aem.executeAgentTool('stubAgent', 'runStub', { sessionId: 'chat handle' });

    expect(sessionService.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'ws-blog-id' })
    );
  });
});
