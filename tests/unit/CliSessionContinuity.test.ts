/**
 * CLI session continuity (#214, docs/plans/session-sticky-context-plan.md PR 2).
 *
 * The defect: every CLI command had to restate `--session`, and when it did
 * not, the CLI filled `sessionId: 'nexus-cli'` (and `workspaceId: 'default'`)
 * client-side — a second source of defaults outside the vault, and the
 * `'default'` half is exactly how #214's misfiling happened. The fix moves
 * both defaults to the server: the vault remembers the handle the CLI last
 * chose with an explicit `--session` on a successful call (`cliCurrentSession`,
 * bind point 3), a CLI call with no `--session` continues it, and only
 * connections that identified themselves as the CLI on `initialize` get any of
 * this. MCP clients and native chat are untouched.
 *
 * Also covered here: the ONE exemption from PR 1's UNBOUND rule — a useTools
 * batch made entirely of workspace-selection commands runs under 'default'
 * without binding, because the steer tells a fresh session to run exactly
 * those, and `load-workspace` cannot need the workspace it is about to load.
 *
 * The SessionContextManager and ToolExecutionStrategy are REAL; see
 * helpers/sessionStickyFixtures.ts for what is stubbed and why.
 */

import {
  CLI_CLIENT_NAME,
  CLI_DEFAULT_SESSION_HANDLE
} from '../../src/handlers/strategies/ToolExecutionStrategy';
import { parsePersistedSessionBindings } from '../../src/services/session/SessionBindingsStore';
import {
  WORKSPACE_ID_REQUIRED_MESSAGE,
  isWorkspaceSelectionOnlyCommand
} from '../../src/agents/toolManager/services/ToolCliNormalizer';
import {
  MemoryBindingsStore,
  getToolsRequest,
  makeManager,
  makeSessionService,
  makeStrategy,
  makeToolManagerAgent,
  useToolsRequest
} from './helpers/sessionStickyFixtures';

type Request = ReturnType<typeof useToolsRequest> & { clientName?: string };

/** A request as the CLI sends it: identified on the connection, keys only when flags were given. */
function cliRequest(base: Request, overrides: { sessionId?: string; workspaceId?: string } = {}): Request {
  const args: Record<string, unknown> = { ...base.params.arguments };
  delete args.sessionId;
  delete args.workspaceId;
  if (overrides.sessionId !== undefined) args.sessionId = overrides.sessionId;
  if (overrides.workspaceId !== undefined) args.workspaceId = overrides.workspaceId;
  return { params: { ...base.params, arguments: args }, clientName: CLI_CLIENT_NAME };
}

function cliUse(overrides: { sessionId?: string; workspaceId?: string; tool?: string } = {}): Request {
  const { tool, ...rest } = overrides;
  return cliRequest(useToolsRequest(tool ? { tool } : {}), rest);
}

function cliGetTools(overrides: { sessionId?: string; workspaceId?: string } = {}): Request {
  return cliRequest(getToolsRequest(), overrides);
}

// ---------------------------------------------------------------------------
// The CLI default: cliCurrentSession ?? 'nexus-cli', CLI connections only
// ---------------------------------------------------------------------------

describe('CLI session default', () => {
  it('a CLI call with no sessionId and nothing remembered runs as "nexus-cli" — and that default is NOT bound', async () => {
    const { manager, sessionService } = makeManager();
    const { strategy, captured } = makeStrategy(manager);

    await strategy.handle(cliGetTools());

    expect(captured.result?.success).toBe(true);
    expect(captured.sessionInfo?.displaySessionId).toBe(CLI_DEFAULT_SESSION_HANDLE);
    expect(sessionService.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'nexus-cli', workspaceId: 'default' })
    );
    // Falling back is not choosing: the vault still remembers nothing.
    expect(manager.getCliCurrentSession()).toBeNull();
  });

  it('a non-CLI connection gets no default: with no sessionId it takes the pre-PR-2 fallback path', async () => {
    // Red/green for the `clientName === 'nexus-cli'` gate: drop the gate and
    // this call is partitioned as "nexus-cli" instead of reaching the
    // SessionService fallback that MCP clients have always used.
    const { manager, sessionService } = makeManager();
    const { strategy, captured } = makeStrategy(manager);
    const request = cliGetTools();

    await strategy.handle({ ...request, clientName: 'claude-desktop' });
    await strategy.handle({ ...request, clientName: undefined });

    expect(sessionService.createSession).not.toHaveBeenCalled();
    expect(captured.sessionInfo?.displaySessionId).toBeUndefined();
    expect(captured.sessionInfo?.sessionId).toBe('s-fallback');
    expect(manager.getCliCurrentSession()).toBeNull();
  });

  it('a non-CLI connection never binds a current session, even with an explicit sessionId on a successful call', async () => {
    const { manager } = makeManager();
    const { strategy, captured } = makeStrategy(manager);

    await strategy.handle({ ...useToolsRequest({ sessionId: 'research', workspaceId: 'Research' }), clientName: 'claude-desktop' });
    await strategy.handle(useToolsRequest({ sessionId: 'research', workspaceId: 'Research' }));

    expect(captured.result?.success).toBe(true);
    // PR 1 behaviour is intact: the workspace bind still happened...
    expect(manager.resolveHandleWorkspace('research')).toBe('ws-research-id');
    // ...but the CLI's slot is untouched.
    expect(manager.getCliCurrentSession()).toBeNull();
  });

  it('a blank explicit sessionId on a CLI connection counts as absent and takes the default', async () => {
    const { manager } = makeManager();
    const { strategy, captured } = makeStrategy(manager);

    await strategy.handle(cliGetTools({ sessionId: '   ' }));

    expect(captured.sessionInfo?.displaySessionId).toBe(CLI_DEFAULT_SESSION_HANDLE);
    expect(manager.getCliCurrentSession()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Bind point 3 — an explicit --session on a CLI connection, once the call succeeds
// ---------------------------------------------------------------------------

describe('bind point 3: explicit --session on a CLI connection', () => {
  it('remembers the handle after a successful useTools, and the next CLI call with no --session continues it AND inherits its workspace', async () => {
    const { manager, sessionService } = makeManager();
    const { strategy, batchExecute } = makeStrategy(manager);

    await strategy.handle(cliUse({ sessionId: 'research', workspaceId: 'Research' }));
    expect(manager.getCliCurrentSession()).toBe('research');

    await strategy.handle(cliUse());

    expect(batchExecute).toHaveBeenCalledTimes(2);
    // Same internal session both times — the handle was resumed, not recreated.
    expect(batchExecute.mock.calls[1][0].context.sessionId).toBe(batchExecute.mock.calls[0][0].context.sessionId);
    expect(sessionService.createSession).toHaveBeenCalledTimes(1);
    // The workspace partition followed the RESOLVED handle: the inherited
    // session inherited research's bind, so no workspaceId was needed.
    expect(batchExecute.mock.calls[1][0].context.workspaceId).toBe('ws-research-id');
  });

  it('does not bind off a returned { success: false }', async () => {
    // Red/green for the success guard: read handle()'s local `success` flag
    // instead of the result and this remembers a session whose only call
    // was refused.
    const { manager } = makeManager();
    const { strategy, captured } = makeStrategy(manager, () =>
      makeToolManagerAgent(() => ({ success: false, error: 'Invalid workspace "Nope".' }))
    );

    await strategy.handle(cliUse({ sessionId: 'research', workspaceId: 'Nope' }));

    expect(captured.result?.success).toBe(false);
    expect(manager.getCliCurrentSession()).toBeNull();
  });

  it('does not bind off a thrown call — including the unbound-workspace steer', async () => {
    const { manager } = makeManager();
    const { strategy, captured } = makeStrategy(manager);

    // Fresh session, no workspace, a real tool: PR 1's steer is thrown by the
    // normalizer and surfaces as a failed result.
    await strategy.handle(cliUse({ sessionId: 'research' }));

    expect(captured.result?.success).toBe(false);
    expect(captured.result?.error).toContain(WORKSPACE_ID_REQUIRED_MESSAGE);
    expect(manager.getCliCurrentSession()).toBeNull();
  });

  it('binds off a non-throwing getTools, so discovery can be the call that chooses the session', async () => {
    const { manager } = makeManager();
    const { strategy, captured } = makeStrategy(manager);

    await strategy.handle(cliGetTools({ sessionId: 'research' }));

    expect(captured.result?.success).toBe(true);
    expect(manager.getCliCurrentSession()).toBe('research');
    // Choosing a session chooses no workspace.
    expect(manager.resolveHandleWorkspace('research')).toBeUndefined();
  });

  it('switching is the same gesture as choosing: pass a different --session once', async () => {
    const { manager } = makeManager();
    const { strategy, batchExecute } = makeStrategy(manager);

    await strategy.handle(cliUse({ sessionId: 'research', workspaceId: 'Research' }));
    await strategy.handle(cliUse({ sessionId: 'blog', workspaceId: 'Blog' }));
    await strategy.handle(cliUse());

    expect(manager.getCliCurrentSession()).toBe('blog');
    expect(batchExecute.mock.calls.map(call => call[0].context.workspaceId))
      .toEqual(['ws-research-id', 'ws-blog-id', 'ws-blog-id']);
  });

  it('the inherited handle is not a new choice: no write when the CLI keeps calling without --session', async () => {
    const { manager } = makeManager();
    const set = jest.spyOn(manager, 'setCliCurrentSession');
    const { strategy } = makeStrategy(manager);

    await strategy.handle(cliUse({ sessionId: 'research', workspaceId: 'Research' }));
    await strategy.handle(cliUse());
    await strategy.handle(cliUse());

    expect(set).toHaveBeenCalledTimes(1);
  });

  it('remembers the handle the caller typed even when the display name was renamed, so it resumes the same session', async () => {
    const sessionService = makeSessionService();
    sessionService.getAllSessions.mockResolvedValue([{ id: 's-other', workspaceId: 'ws-research-id', name: 'research' }]);
    const { manager } = makeManager({ sessionService });
    const { strategy, captured, batchExecute } = makeStrategy(manager);

    await strategy.handle(cliUse({ sessionId: 'research', workspaceId: 'Research' }));
    expect(captured.sessionInfo?.displaySessionId).toBe('research-2');
    expect(manager.getCliCurrentSession()).toBe('research');

    await strategy.handle(cliUse());

    expect(batchExecute.mock.calls[1][0].context.sessionId).toBe(batchExecute.mock.calls[0][0].context.sessionId);
  });
});

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

describe('persistence: cliCurrentSession in session-bindings.json', () => {
  it('round-trips through the store and a fresh manager over the same store resumes it', async () => {
    const store = new MemoryBindingsStore();
    const { manager: before } = makeManager({ store });
    const { strategy } = makeStrategy(before);

    await strategy.handle(cliUse({ sessionId: 'research', workspaceId: 'Research' }));
    await before.flushBindings();
    expect(store.doc?.cliCurrentSession).toBe('research');

    // "Reload": the next CLI call with no --session must land in research.
    const { manager: after } = makeManager({ store });
    const resumed = makeStrategy(after);
    await resumed.strategy.handle(cliUse());

    expect(after.getCliCurrentSession()).toBe('research');
    expect(resumed.batchExecute.mock.calls[0][0].context.workspaceId).toBe('ws-research-id');
  });

  it('is null in a fresh document and after clearAll', async () => {
    const store = new MemoryBindingsStore();
    const { manager } = makeManager({ store });
    await manager.flushBindings();
    expect(store.doc?.cliCurrentSession).toBeNull();

    manager.setCliCurrentSession('research');
    manager.clearAll();
    expect(manager.getCliCurrentSession()).toBeNull();
  });

  it('the parser keeps a trimmed string and drops blank or non-string values', () => {
    const base = { handles: {}, handleWorkspace: {} };
    expect(parsePersistedSessionBindings({ ...base, cliCurrentSession: ' research ' })?.cliCurrentSession).toBe('research');
    expect(parsePersistedSessionBindings({ ...base, cliCurrentSession: '   ' })?.cliCurrentSession).toBeNull();
    expect(parsePersistedSessionBindings({ ...base, cliCurrentSession: 7 })?.cliCurrentSession).toBeNull();
    expect(parsePersistedSessionBindings({ ...base, cliCurrentSession: null })?.cliCurrentSession).toBeNull();
    // A PR 1 file has no slot at all.
    expect(parsePersistedSessionBindings(base)?.cliCurrentSession).toBeNull();
  });

  it('setCliCurrentSession trims, ignores blanks, and does not schedule a save for an unchanged value', async () => {
    const store = new MemoryBindingsStore();
    const { manager } = makeManager({ store });

    manager.setCliCurrentSession(' research ');
    manager.setCliCurrentSession('');
    expect(manager.getCliCurrentSession()).toBe('research');
    await manager.flushBindings();
    const savesAfterFirst = store.saves;

    manager.setCliCurrentSession('research');
    await manager.flushBindings();
    // flushBindings always writes; what matters is that the unchanged set
    // scheduled nothing on its own.
    expect(store.saves).toBe(savesAfterFirst + 1);
    expect(store.doc?.cliCurrentSession).toBe('research');
  });
});

// ---------------------------------------------------------------------------
// The workspace-selection exemption from the UNBOUND rule
// ---------------------------------------------------------------------------

describe('unbound useTools: the workspace-selection exemption', () => {
  it('an unbound `memory list-workspaces` runs under "default" and binds nothing', async () => {
    const { manager, sessionService } = makeManager();
    const { strategy, captured, batchExecute } = makeStrategy(manager);

    await strategy.handle(cliUse({ tool: 'memory list-workspaces' }));

    expect(captured.result?.success).toBe(true);
    expect(batchExecute).toHaveBeenCalledTimes(1);
    expect(batchExecute.mock.calls[0][0].context.workspaceId).toBe('default');
    expect(sessionService.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'default', name: 'nexus-cli' })
    );
    // A partition is not a choice: the next real command still has to name one.
    expect(manager.resolveHandleWorkspace('nexus-cli')).toBeUndefined();
  });

  it('an unbound `memory create-workspace --name X` runs under "default" and leaves the handle unbound (create, then load)', async () => {
    const { manager } = makeManager();
    const { strategy, captured, batchExecute } = makeStrategy(manager);

    await strategy.handle(cliUse({ tool: 'memory create-workspace --name "Q3 Launch"' }));

    expect(captured.result?.success).toBe(true);
    expect(batchExecute).toHaveBeenCalledTimes(1);
    expect(batchExecute.mock.calls[0][0].context.workspaceId).toBe('default');
    // Creating is part of choosing, but it is not the choice: the load does that.
    expect(manager.resolveHandleWorkspace('nexus-cli')).toBeUndefined();
  });

  it('an unbound `memory load-workspace research` runs, and ends bound to the LOADED workspace via bind point 2', async () => {
    const { manager } = makeManager();
    // The stubbed batch does what the real ToolBatchExecutionService does on a
    // successful load: binds by the internal id it was handed.
    const { strategy, batchExecute } = makeStrategy(manager, () => makeToolManagerAgent((params) => {
      manager.bindSessionWorkspaceById(params.context.sessionId as string, 'ws-research-id');
      return { success: true };
    }));

    await strategy.handle(cliUse({ tool: 'memory load-workspace research' }));

    expect(batchExecute.mock.calls[0][0].context.workspaceId).toBe('default');
    expect(manager.resolveHandleWorkspace('nexus-cli')).toBe('ws-research-id');

    // ...and the follow-up inherits it with no workspaceId at all.
    await strategy.handle(cliUse());
    expect(batchExecute.mock.calls[1][0].context.workspaceId).toBe('ws-research-id');
  });

  it('a mixed batch on an unbound session gets the steer and runs nothing — the trailing command must not run under "default"', async () => {
    const { manager } = makeManager();
    const { strategy, captured, batchExecute } = makeStrategy(manager);

    await strategy.handle(cliUse({ tool: 'memory load-workspace research, content read --path notes/a.md' }));

    expect(batchExecute).not.toHaveBeenCalled();
    expect(captured.result?.success).toBe(false);
    expect(captured.result?.error).toContain(WORKSPACE_ID_REQUIRED_MESSAGE);
    expect(captured.result?.error).toMatch(/own call/);
    expect(manager.resolveHandleWorkspace('nexus-cli')).toBeUndefined();
  });

  it('the exemption is a partition, not a choice: bind point 1 never fires off it', async () => {
    const { manager } = makeManager();
    const bind = jest.spyOn(manager, 'bindHandleWorkspace');
    const { strategy } = makeStrategy(manager);

    await strategy.handle(cliUse({ tool: 'memory list-workspaces' }));
    await strategy.handle(cliUse({ tool: 'memory load-workspace research' }));

    expect(bind).not.toHaveBeenCalled();
  });

  it('applies to MCP callers too — it is about the command, not the client', async () => {
    const { manager } = makeManager();
    const { strategy, captured } = makeStrategy(manager);

    await strategy.handle(useToolsRequest({ tool: 'memory list-workspaces' }));

    expect(captured.result?.success).toBe(true);
    expect(manager.resolveHandleWorkspace('nexus-cli')).toBeUndefined();
  });

  it('isWorkspaceSelectionOnlyCommand accepts only batches made entirely of the three selection commands', () => {
    expect(isWorkspaceSelectionOnlyCommand('memory load-workspace research')).toBe(true);
    expect(isWorkspaceSelectionOnlyCommand('memory load-workspace "My Research, v2"')).toBe(true);
    expect(isWorkspaceSelectionOnlyCommand('memory list-workspaces')).toBe(true);
    expect(isWorkspaceSelectionOnlyCommand('memory create-workspace --name X')).toBe(true);
    expect(isWorkspaceSelectionOnlyCommand('memoryManager loadWorkspace --workspace research')).toBe(true);
    expect(isWorkspaceSelectionOnlyCommand('memory list-workspaces, memory load-workspace research')).toBe(true);
    expect(isWorkspaceSelectionOnlyCommand('memory create-workspace --name X, memory load-workspace X')).toBe(true);

    expect(isWorkspaceSelectionOnlyCommand('memory load-workspace research, content read --path a.md')).toBe(false);
    expect(isWorkspaceSelectionOnlyCommand('memory create-workspace --name X, content read --path a.md')).toBe(false);
    expect(isWorkspaceSelectionOnlyCommand('content read --path a.md')).toBe(false);
    expect(isWorkspaceSelectionOnlyCommand('memory delete-workspace --id X')).toBe(false);
    expect(isWorkspaceSelectionOnlyCommand('memory')).toBe(false);
    expect(isWorkspaceSelectionOnlyCommand('')).toBe(false);
    expect(isWorkspaceSelectionOnlyCommand(undefined)).toBe(false);
  });
});
