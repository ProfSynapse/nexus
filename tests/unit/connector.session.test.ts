/**
 * Connector session-handle resolution — coverage of the
 * 'Default Session' defaulting + 3-arg validateSessionId path
 * introduced in commit b90ce865 (B4 of review/workspace-memory-batch).
 *
 * The MCPConnector's `callTool` (src/connector.ts:529-534) computes:
 *
 *   const providedSessionId = (toolManagerMetaTool ? typedParams.sessionId
 *     : (typedParams.context?.sessionId || typedParams.sessionId));
 *   const validationResult = await sessionContextManager.validateSessionId(
 *     providedSessionId || 'Default Session',
 *     typeof typedParams.memory === 'string' ? typedParams.memory : undefined,
 *     typeof typedParams.workspaceId === 'string' ? typedParams.workspaceId : undefined
 *   );
 *
 * Building a full MCPConnector requires plugin + agentManager + service
 * container wiring, all far beyond the surface this test cares about.
 * Instead, this test exercises the contract the connector relies on:
 * `SessionContextManager.validateSessionId` is the seam the connector
 * calls into, and these tests pin its behavior under exactly the inputs
 * the connector synthesizes.
 *
 * Backend-reviewer flag (preserved verbatim): the friendly-name
 * workspaceId is passed straight through to the validator, so a model
 * that sends `workspaceId: "Engineering"` will get a session bound to
 * the literal name "Engineering" rather than its resolved UUID. The
 * test below documents the current behavior; it is not asserted to
 * be desired or undesired.
 */

import { SessionContextManager } from '../../src/services/SessionContextManager';

interface SessionServiceStub {
  getSession: jest.Mock;
  getAllSessions: jest.Mock;
  createSession: jest.Mock;
  updateSession: jest.Mock;
}

function makeSessionService(): SessionServiceStub {
  return {
    getSession: jest.fn().mockResolvedValue(null),
    getAllSessions: jest.fn().mockResolvedValue([]),
    createSession: jest.fn().mockResolvedValue(undefined),
    updateSession: jest.fn().mockResolvedValue(undefined)
  };
}

describe("connector session resolution — 'Default Session' default + 3-arg validateSessionId", () => {
  it("creates a fresh session keyed to the literal display 'Default Session' when no sessionId is provided", async () => {
    const manager = new SessionContextManager();
    const sessionService = makeSessionService();
    manager.setSessionService(sessionService);

    // Connector default: providedSessionId is undefined so falls through
    // to the literal 'Default Session' string.
    const providedSessionId: string | undefined = undefined;
    const result = await manager.validateSessionId(
      providedSessionId || 'Default Session',
      'short memory',
      'default'
    );

    expect(result.id).toMatch(/^s-/);
    expect(result.created).toBe(true);
    expect(result.displaySessionId).toBe('Default Session');
    expect(sessionService.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        id: result.id,
        name: 'Default Session',
        description: 'short memory',
        workspaceId: 'default'
      })
    );
  });

  it("returns the same internal id on the second call with 'Default Session' (handle reuse)", async () => {
    const manager = new SessionContextManager();
    const sessionService = makeSessionService();
    manager.setSessionService(sessionService);

    const first = await manager.validateSessionId('Default Session', 'memory', 'default');
    const second = await manager.validateSessionId('Default Session', undefined, 'default');

    expect(second.id).toBe(first.id);
    expect(second.created).toBe(false);
    expect(second.displaySessionId).toBe('Default Session');
    expect(sessionService.createSession).toHaveBeenCalledTimes(1);
  });

  it('passes memory through as the session description on auto-create', async () => {
    const manager = new SessionContextManager();
    const sessionService = makeSessionService();
    manager.setSessionService(sessionService);

    await manager.validateSessionId('Default Session', 'pivotal memory text', 'default');

    expect(sessionService.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ description: 'pivotal memory text' })
    );
  });

  it('routes Default Session into the supplied workspaceId, not the global default', async () => {
    const manager = new SessionContextManager();
    const sessionService = makeSessionService();
    manager.setSessionService(sessionService);

    await manager.validateSessionId('Default Session', undefined, 'ws-engineering');

    expect(sessionService.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'ws-engineering' })
    );
  });

  it("explicit sessionId provided by the caller wins over 'Default Session' fallback", async () => {
    const manager = new SessionContextManager();
    const sessionService = makeSessionService();
    manager.setSessionService(sessionService);

    const providedSessionId: string | undefined = 'planning chat';
    const result = await manager.validateSessionId(
      providedSessionId || 'Default Session',
      'mem',
      'default'
    );

    expect(result.displaySessionId).toBe('planning chat');
    expect(sessionService.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'planning chat' })
    );
  });

  it('documents current behavior: friendly-name workspaceId is passed straight through to createSession', async () => {
    // Backend-reviewer flag: the connector does not resolve a friendly
    // workspace handle (e.g., "Engineering") to its UUID before calling
    // validateSessionId. As a result, the resulting session is bound
    // to the literal name as its workspaceId. This test pins that
    // behavior; whether it is desired is a product decision, not a
    // test concern.
    const manager = new SessionContextManager();
    const sessionService = makeSessionService();
    manager.setSessionService(sessionService);

    await manager.validateSessionId('Default Session', undefined, 'Engineering');

    expect(sessionService.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'Engineering' })
    );
  });

  it("guards against the 'Default Session' display being suffixed when an existing real session already uses that name", async () => {
    const manager = new SessionContextManager();
    const sessionService = makeSessionService();
    sessionService.getAllSessions.mockResolvedValue([
      { id: 's-existing', workspaceId: 'default', name: 'Default Session' }
    ]);
    manager.setSessionService(sessionService);

    const result = await manager.validateSessionId('Default Session', undefined, 'default');

    // When a workspace already has a "Default Session", the validator
    // emits a unique-suffixed display handle and flags the change.
    expect(result.displaySessionId).toBe('Default Session-2');
    expect(result.displaySessionIdChanged).toBe(true);
  });
});
