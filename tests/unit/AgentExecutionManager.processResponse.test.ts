/**
 * AgentExecutionManager — coverage of the user-visible message + correctedId
 * semantic introduced in commit b90ce865 (B4 of review/workspace-memory-batch).
 *
 * Surface tested: `executeAgentTool` end-to-end, focusing on
 * `addSessionInstructions` (private). The flow:
 *   1. params._isNonStandardId === true and params._originalSessionId is set.
 *   2. SessionContextManager has not yet recorded instructions for this session.
 *   3. The agent returns a CommonResult; AEM enriches it with
 *      `sessionIdCorrection: { originalId, correctedId, message }`.
 *
 * Pre-b90ce865, `correctedId` was the standardized internal session ID.
 * Post-b90ce865, `correctedId === originalSessionId` (the human-readable
 * handle the model originally sent). External consumers that read
 * `sessionIdCorrection.correctedId` to update their session pointer
 * will get the friendly handle, not the internal UUID.
 *
 * NOTE: this test asserts the **current post-b90ce865 behavior**.
 * If the coder reverts that semantic flip ("revert" decision), the
 * assertion in the first test below should change to assert
 * `correctedId === <internal validated id>` instead of `originalHandle`.
 * TODO: confirm with coder decision (flip|revert) before merge.
 */

import { AgentExecutionManager } from '../../src/server/execution/AgentExecutionManager';
import { AgentRegistry } from '../../src/server/services/AgentRegistry';
import { SessionContextManager } from '../../src/services/SessionContextManager';
import type { IAgent } from '../../src/agents/interfaces/IAgent';
import type { ITool } from '../../src/agents/interfaces/ITool';

function makeAgent(toolSlug: string, executeReturnFactory: () => unknown): IAgent {
  const tool = {
    slug: toolSlug,
    name: 'Stub tool',
    description: '',
    version: '1.0.0',
    execute: jest.fn(async () => executeReturnFactory()),
    getParameterSchema: jest.fn(),
    getResultSchema: jest.fn()
  } as unknown as ITool;

  return {
    name: 'stubAgent',
    description: 'stub',
    version: '1.0.0',
    getTools: () => [tool],
    getTool: (slug: string) => (slug === toolSlug ? tool : undefined),
    initialize: jest.fn().mockResolvedValue(undefined),
    executeTool: jest.fn(async (slug: string) => {
      if (slug !== toolSlug) {
        throw new Error(`unknown tool ${slug}`);
      }
      return executeReturnFactory();
    }),
    setAgentManager: jest.fn()
  };
}

function makeRegistry(agent: IAgent): AgentRegistry {
  const registry = new AgentRegistry();
  // The registry exposes registerAgent in src; relying on the public method
  // keeps this test resilient to internal map shape changes.
  (registry as unknown as { registerAgent: (a: IAgent) => void }).registerAgent(agent);
  return registry;
}

describe('AgentExecutionManager.executeAgentTool — sessionIdCorrection semantic', () => {
  it('sets correctedId to the original human-readable handle (post-b90ce865) and surfaces the new message', async () => {
    const agent = makeAgent('runStub', () => ({
      success: true,
      data: { ok: true },
      workspaceContext: { workspaceId: 'default' }
    }));
    const registry = makeRegistry(agent);
    const sessionContextManager = new SessionContextManager();

    // The instructions-injection path is gated by hasReceivedInstructions
    // returning false; force that without exercising the rest of the
    // SessionContextManager state machine.
    sessionContextManager.hasReceivedInstructions = jest.fn().mockReturnValue(false);
    sessionContextManager.markInstructionsReceived = jest.fn();

    // processSessionContext also calls validateSessionId; stub it to
    // pass through so addSessionInstructions sees the params we pass in.
    sessionContextManager.validateSessionId = jest.fn().mockResolvedValue({
      id: 's-internal-uuid',
      created: false,
      displaySessionId: 'planning chat-2',
      displaySessionIdChanged: true
    });
    sessionContextManager.applyWorkspaceContext = jest.fn((_id, p) => p);
    sessionContextManager.updateFromResult = jest.fn();

    const aem = new AgentExecutionManager(registry, sessionContextManager);

    const params: Record<string, unknown> = {
      sessionId: 's-internal-uuid',
      _isNonStandardId: true,
      _originalSessionId: 'planning chat',
      memory: 'short memory'
    };

    const result = await aem.executeAgentTool('stubAgent', 'runStub', params) as {
      sessionIdCorrection?: { originalId: string; correctedId: string; message: string };
    };

    expect(result.sessionIdCorrection).toBeDefined();
    expect(result.sessionIdCorrection!.originalId).toBe('planning chat');

    // Current b90ce865 semantic: correctedId === originalSessionId (the friendly handle).
    expect(result.sessionIdCorrection!.correctedId).toBe('planning chat');

    // New user-facing message guides the model to keep using the friendly name.
    expect(result.sessionIdCorrection!.message).toMatch(/human-readable session name/i);
    expect(result.sessionIdCorrection!.message).not.toMatch(/standardized/i);
  });

  it('does NOT add sessionIdCorrection when isNonStandardId is false', async () => {
    const agent = makeAgent('runStub', () => ({ success: true, data: { ok: true } }));
    const registry = makeRegistry(agent);
    const sessionContextManager = new SessionContextManager();
    sessionContextManager.hasReceivedInstructions = jest.fn().mockReturnValue(false);
    sessionContextManager.markInstructionsReceived = jest.fn();
    sessionContextManager.validateSessionId = jest.fn().mockResolvedValue({
      id: 's-internal-uuid',
      created: false,
      displaySessionId: 'standard handle',
      displaySessionIdChanged: false
    });
    sessionContextManager.applyWorkspaceContext = jest.fn((_id, p) => p);
    sessionContextManager.updateFromResult = jest.fn();

    const aem = new AgentExecutionManager(registry, sessionContextManager);

    const result = await aem.executeAgentTool('stubAgent', 'runStub', {
      sessionId: 's-internal-uuid'
    }) as Record<string, unknown>;

    expect(result.sessionIdCorrection).toBeUndefined();
  });

  it('does NOT re-emit sessionIdCorrection on a follow-up call once instructions have been received', async () => {
    const agent = makeAgent('runStub', () => ({ success: true, data: { ok: true } }));
    const registry = makeRegistry(agent);
    const sessionContextManager = new SessionContextManager();

    // First call: not yet received → emit. Second call: already received → silent.
    sessionContextManager.hasReceivedInstructions = jest.fn()
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    sessionContextManager.markInstructionsReceived = jest.fn();
    sessionContextManager.validateSessionId = jest.fn().mockResolvedValue({
      id: 's-internal-uuid',
      created: false,
      displaySessionId: 'planning chat-2',
      displaySessionIdChanged: true
    });
    sessionContextManager.applyWorkspaceContext = jest.fn((_id, p) => p);
    sessionContextManager.updateFromResult = jest.fn();

    const aem = new AgentExecutionManager(registry, sessionContextManager);

    const baseParams: Record<string, unknown> = {
      sessionId: 's-internal-uuid',
      _isNonStandardId: true,
      _originalSessionId: 'planning chat'
    };

    const first = await aem.executeAgentTool('stubAgent', 'runStub', { ...baseParams }) as Record<string, unknown>;
    const second = await aem.executeAgentTool('stubAgent', 'runStub', { ...baseParams }) as Record<string, unknown>;

    expect(first.sessionIdCorrection).toBeDefined();
    expect(second.sessionIdCorrection).toBeUndefined();
  });
});
