/**
 * ToolExecutionStrategy — coverage of the request-boundary plumbing
 * introduced in commit b90ce865 (B4 of review/workspace-memory-batch).
 *
 * `buildRequestContext` is private; we exercise it through `handle()`,
 * which is the public entry point for every MCP tool call. Each test
 * pins one signal at a time:
 *   - 3-arg `validateSessionId(sessionId, memory, workspaceId)` shape
 *   - displaySessionId / sessionName threading into params.context
 *     and params._displaySessionId
 *   - displaySessionIdChanged → isNonStandardId + originalSessionId
 *   - validation throw → fallback to legacy SessionService
 *   - missing params.context → safely defaults
 *
 * The fallback branch is the riskiest seam: a thrown validation error
 * silently downgrades to legacy session handling, and there is no
 * explicit assertion in production code that the downgrade preserves
 * the displaySessionId thread.
 */

import { ToolExecutionStrategy } from '../../src/handlers/strategies/ToolExecutionStrategy';
import type {
  IRequestHandlerDependencies,
  ToolExecutionResult,
  SessionInfo
} from '../../src/handlers/interfaces/IRequestHandlerServices';
import type { IAgent } from '../../src/agents/interfaces/IAgent';
import type { ITool } from '../../src/agents/interfaces/ITool';
import type { SessionContextManager } from '../../src/services/SessionContextManager';

interface CapturedExecution {
  sessionInfo?: SessionInfo;
  toolParams?: Record<string, unknown>;
}

function makeStubTool(): ITool {
  return {
    slug: 'stubTool',
    name: 'Stub tool',
    description: '',
    version: '1.0.0',
    execute: jest.fn(),
    getParameterSchema: jest.fn().mockReturnValue({}),
    getResultSchema: jest.fn().mockReturnValue({})
  } as unknown as ITool;
}

function makeStubAgent(tool: ITool, name = 'stubAgent'): IAgent {
  return {
    name,
    description: '',
    version: '1.0.0',
    getTools: () => [tool],
    getTool: (slug: string) => (slug === tool.slug ? tool : undefined),
    initialize: jest.fn(),
    executeTool: jest.fn(),
    setAgentManager: jest.fn()
  };
}

function makeDeps(captured: CapturedExecution): IRequestHandlerDependencies {
  return {
    validationService: {
      validateToolParams: jest.fn(async (params: Record<string, unknown>) => params),
      validateSessionId: jest.fn(),
      validateBatchOperations: jest.fn(),
      validateBatchPaths: jest.fn()
    },
    sessionService: {
      processSessionId: jest.fn(async (sessionId: string | undefined) => ({
        sessionId: sessionId ?? 's-fallback',
        isNewSession: false,
        isNonStandardId: false
      })),
      generateSessionId: jest.fn(),
      isStandardSessionId: jest.fn(),
      shouldInjectInstructions: jest.fn().mockReturnValue(false)
    },
    toolExecutionService: {
      executeAgent: jest.fn(async (_agent, _tool, params: Record<string, unknown>) => {
        captured.toolParams = params;
        const successResult: ToolExecutionResult = { success: true, data: { ok: true } };
        return successResult;
      })
    },
    responseFormatter: {
      formatToolExecutionResponse: jest.fn((_result, sessionInfo) => {
        captured.sessionInfo = sessionInfo;
        return { content: [{ type: 'text', text: 'ok' }] };
      }),
      formatSessionInstructions: jest.fn((_id, r) => r),
      formatErrorResponse: jest.fn((err) => ({ content: [{ type: 'text', text: err.message }] }))
    },
    toolListService: {} as never,
    resourceListService: {} as never,
    resourceReadService: {} as never,
    promptsListService: {} as never,
    toolHelpService: {} as never,
    schemaEnhancementService: {} as never
  };
}

function makeContextManager(overrides: Partial<SessionContextManager> = {}): SessionContextManager {
  return {
    validateSessionId: jest.fn(),
    applyWorkspaceContext: jest.fn((_id: string, p: Record<string, unknown>) => p),
    updateFromResult: jest.fn(),
    updateSessionDescription: jest.fn(),
    hasReceivedInstructions: jest.fn().mockReturnValue(false),
    markInstructionsReceived: jest.fn(),
    ...overrides
  } as unknown as SessionContextManager;
}

function makeRequest(
  toolName: string,
  args: Record<string, unknown>
): { params: { name: string; arguments: Record<string, unknown> } } {
  return { params: { name: toolName, arguments: args } };
}

describe('ToolExecutionStrategy.buildRequestContext', () => {
  it('calls validateSessionId with the 3-arg (sessionId, memory, workspaceId) shape', async () => {
    const tool = makeStubTool();
    const agent = makeStubAgent(tool);
    const captured: CapturedExecution = {};
    const validateSessionId = jest.fn().mockResolvedValue({
      id: 's-internal-uuid',
      created: false,
      displaySessionId: 'planning chat',
      displaySessionIdChanged: false
    });
    const sessionContextManager = makeContextManager({
      validateSessionId
    } as Partial<SessionContextManager>);
    const deps = makeDeps(captured);

    const strategy = new ToolExecutionStrategy(deps, () => agent, sessionContextManager);

    await strategy.handle(makeRequest('stubAgent_stubTool', {
      tool: 'stubTool',
      sessionId: 'planning chat',
      memory: 'short memory snapshot',
      workspaceId: 'ws-target',
      context: {
        sessionId: 'planning chat',
        workspaceId: 'ws-target'
      }
    }));

    expect(validateSessionId).toHaveBeenCalledTimes(1);
    expect(validateSessionId).toHaveBeenCalledWith(
      'planning chat',
      'short memory snapshot',
      'ws-target'
    );
  });

  it('falls back to context.workspaceId when params.workspaceId is not a string', async () => {
    const tool = makeStubTool();
    const agent = makeStubAgent(tool);
    const captured: CapturedExecution = {};
    const validateSessionId = jest.fn().mockResolvedValue({
      id: 's-1',
      created: false,
      displaySessionId: 'chat',
      displaySessionIdChanged: false
    });
    const sessionContextManager = makeContextManager({
      validateSessionId
    } as Partial<SessionContextManager>);
    const deps = makeDeps(captured);

    const strategy = new ToolExecutionStrategy(deps, () => agent, sessionContextManager);

    await strategy.handle(makeRequest('stubAgent_stubTool', {
      tool: 'stubTool',
      sessionId: 'chat',
      memory: 'm',
      context: {
        sessionId: 'chat',
        workspaceId: 'ws-from-context'
      }
    }));

    expect(validateSessionId).toHaveBeenCalledWith('chat', 'm', 'ws-from-context');
  });

  it('threads displaySessionId into params.context.sessionName and params._displaySessionId', async () => {
    const tool = makeStubTool();
    const agent = makeStubAgent(tool);
    const captured: CapturedExecution = {};
    const validateSessionId = jest.fn().mockResolvedValue({
      id: 's-internal-uuid',
      created: false,
      displaySessionId: 'planning chat-2',
      displaySessionIdChanged: true
    });
    const sessionContextManager = makeContextManager({
      validateSessionId
    } as Partial<SessionContextManager>);
    const deps = makeDeps(captured);

    const strategy = new ToolExecutionStrategy(deps, () => agent, sessionContextManager);

    await strategy.handle(makeRequest('stubAgent_stubTool', {
      tool: 'stubTool',
      sessionId: 'planning chat',
      memory: 'memory',
      context: {
        sessionId: 'planning chat',
        workspaceId: 'default'
      }
    }));

    expect(captured.toolParams).toBeDefined();
    expect(captured.toolParams!._displaySessionId).toBe('planning chat-2');
    const ctx = captured.toolParams!.context as Record<string, unknown>;
    expect(ctx.sessionId).toBe('s-internal-uuid');
    expect(ctx.sessionName).toBe('planning chat-2');
    expect(captured.toolParams!.sessionId).toBe('s-internal-uuid');
  });

  it('produces isNonStandardId + originalSessionId when displaySessionIdChanged is true', async () => {
    const tool = makeStubTool();
    const agent = makeStubAgent(tool);
    const captured: CapturedExecution = {};
    const validateSessionId = jest.fn().mockResolvedValue({
      id: 's-internal-uuid',
      created: false,
      displaySessionId: 'planning chat-2',
      displaySessionIdChanged: true
    });
    const sessionContextManager = makeContextManager({
      validateSessionId
    } as Partial<SessionContextManager>);
    const deps = makeDeps(captured);

    const strategy = new ToolExecutionStrategy(deps, () => agent, sessionContextManager);

    await strategy.handle(makeRequest('stubAgent_stubTool', {
      tool: 'stubTool',
      sessionId: 'planning chat',
      memory: 'memory',
      context: { sessionId: 'planning chat', workspaceId: 'default' }
    }));

    expect(captured.sessionInfo).toBeDefined();
    expect(captured.sessionInfo!.isNonStandardId).toBe(true);
    expect(captured.sessionInfo!.originalSessionId).toBe('planning chat');
    expect(captured.sessionInfo!.displaySessionId).toBe('planning chat-2');
    expect(captured.sessionInfo!.displaySessionIdChanged).toBe(true);
  });

  it('does NOT mark isNonStandardId when displaySessionIdChanged is false', async () => {
    const tool = makeStubTool();
    const agent = makeStubAgent(tool);
    const captured: CapturedExecution = {};
    const validateSessionId = jest.fn().mockResolvedValue({
      id: 's-internal-uuid',
      created: false,
      displaySessionId: 'unique handle',
      displaySessionIdChanged: false
    });
    const sessionContextManager = makeContextManager({
      validateSessionId
    } as Partial<SessionContextManager>);
    const deps = makeDeps(captured);

    const strategy = new ToolExecutionStrategy(deps, () => agent, sessionContextManager);

    await strategy.handle(makeRequest('stubAgent_stubTool', {
      tool: 'stubTool',
      sessionId: 'unique handle',
      context: { sessionId: 'unique handle' }
    }));

    expect(captured.sessionInfo!.isNonStandardId).toBe(false);
    expect(captured.sessionInfo!.originalSessionId).toBeUndefined();
  });

  it('falls back to SessionService.processSessionId when validateSessionId throws', async () => {
    const tool = makeStubTool();
    const agent = makeStubAgent(tool);
    const captured: CapturedExecution = {};
    const validateSessionId = jest.fn().mockRejectedValue(
      new Error('SessionService not initialized - cannot validate session')
    );
    const sessionContextManager = makeContextManager({
      validateSessionId
    } as Partial<SessionContextManager>);
    const deps = makeDeps(captured);
    const processSessionId = deps.sessionService.processSessionId as jest.Mock;
    processSessionId.mockResolvedValue({
      sessionId: 's-fallback-uuid',
      isNewSession: false,
      isNonStandardId: false
    });

    const strategy = new ToolExecutionStrategy(deps, () => agent, sessionContextManager);

    const response = await strategy.handle(makeRequest('stubAgent_stubTool', {
      tool: 'stubTool',
      sessionId: 'planning chat',
      memory: 'm',
      context: { sessionId: 'planning chat', workspaceId: 'ws-target' }
    }));

    expect(processSessionId).toHaveBeenCalledWith('planning chat');
    expect(captured.toolParams!.sessionId).toBe('s-fallback-uuid');
    expect(response.content[0].text).toBe('ok');
  });

  it('routes through SessionService when no SessionContextManager is provided', async () => {
    const tool = makeStubTool();
    const agent = makeStubAgent(tool);
    const captured: CapturedExecution = {};
    const deps = makeDeps(captured);
    const processSessionId = deps.sessionService.processSessionId as jest.Mock;
    processSessionId.mockResolvedValue({
      sessionId: 's-legacy-uuid',
      isNewSession: true,
      isNonStandardId: false
    });

    const strategy = new ToolExecutionStrategy(deps, () => agent, /* no SCM */ undefined);

    await strategy.handle(makeRequest('stubAgent_stubTool', {
      tool: 'stubTool',
      sessionId: 'whatever',
      context: { sessionId: 'whatever' }
    }));

    expect(processSessionId).toHaveBeenCalledWith('whatever');
    expect(captured.toolParams!.sessionId).toBe('s-legacy-uuid');
  });
});
