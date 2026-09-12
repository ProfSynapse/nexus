/**
 * Shared fixtures for the session-sticky context tests (#214,
 * docs/plans/session-sticky-context-plan.md): SessionStickyWorkspace.test.ts
 * (PR 1) and CliSessionContinuity.test.ts (PR 2).
 *
 * The SessionContextManager is REAL; only storage (SessionService), the
 * workspace lookup and the persistence store are stubbed — and none of them
 * supplies the value an assertion depends on, except where a test is about
 * that stub's data (persistence round-trip, deleted-session drop).
 */

import { ToolExecutionStrategy } from '../../../src/handlers/strategies/ToolExecutionStrategy';
import type {
  IRequestHandlerDependencies,
  SessionInfo,
  ToolExecutionResult
} from '../../../src/handlers/interfaces/IRequestHandlerServices';
import type { IAgent } from '../../../src/agents/interfaces/IAgent';
import type { ITool } from '../../../src/agents/interfaces/ITool';
import { SessionContextManager } from '../../../src/services/SessionContextManager';
import type { WorkspaceResolverLike } from '../../../src/services/SessionContextManager';
import type {
  PersistedSessionBindings,
  SessionBindingsStore
} from '../../../src/services/session/SessionBindingsStore';
import { ToolCliNormalizer } from '../../../src/agents/toolManager/services/ToolCliNormalizer';
import { UseToolTool } from '../../../src/agents/toolManager/tools/useTools';
import { GetToolsTool } from '../../../src/agents/toolManager/tools/getTools';
import type { ToolBatchExecutionService } from '../../../src/agents/toolManager/services/ToolBatchExecutionService';

/** Two real workspaces plus the global one; `Reserch` is a deliberate near-miss. */
export const WORKSPACES = [
  { id: 'ws-research-id', name: 'Research' },
  { id: 'ws-blog-id', name: 'Blog' }
];

export function makeResolver(): WorkspaceResolverLike & { getWorkspaceByNameOrId: jest.Mock } {
  return {
    getWorkspaceByNameOrId: jest.fn(async (identifier: string) => {
      const match = WORKSPACES.find(ws => ws.id === identifier || ws.name.toLowerCase() === identifier.toLowerCase());
      return match ? { id: match.id, name: match.name } : null;
    })
  };
}

export interface SessionServiceStub {
  getSession: jest.Mock;
  getAllSessions: jest.Mock;
  createSession: jest.Mock;
  updateSession: jest.Mock;
}

export function makeSessionService(): SessionServiceStub {
  return {
    getSession: jest.fn().mockResolvedValue(null),
    getAllSessions: jest.fn().mockResolvedValue([]),
    createSession: jest.fn().mockResolvedValue(undefined),
    updateSession: jest.fn().mockResolvedValue(undefined)
  };
}

/** In-memory store standing in for the vault file. */
export class MemoryBindingsStore implements SessionBindingsStore {
  doc: PersistedSessionBindings | null = null;
  saves = 0;
  async load(): Promise<PersistedSessionBindings | null> {
    return this.doc ? JSON.parse(JSON.stringify(this.doc)) : null;
  }
  async save(doc: PersistedSessionBindings): Promise<void> {
    this.saves += 1;
    this.doc = JSON.parse(JSON.stringify(doc));
  }
}

export function makeManager(options: {
  sessionService?: SessionServiceStub;
  resolver?: WorkspaceResolverLike | null;
  store?: SessionBindingsStore | null;
} = {}): { manager: SessionContextManager; sessionService: SessionServiceStub } {
  const sessionService = options.sessionService ?? makeSessionService();
  const manager = new SessionContextManager();
  manager.setSessionService(sessionService);
  manager.setWorkspaceResolver(options.resolver === undefined ? makeResolver() : options.resolver);
  if (options.store) {
    manager.setBindingsStore(options.store);
  }
  return { manager, sessionService };
}

/**
 * A toolManager agent whose useTools/getTools are the REAL tools over a real
 * ToolCliNormalizer, so the unbound-useTools steer comes from production code
 * rather than a stub. The batch service is stubbed: it records the context it
 * was handed and returns whatever the test says the workspace guard decided.
 * `batchResult` receives the batch params so a test can act mid-execution the
 * way the real service does (bind point 2 fires inside `execute`).
 */
export type BatchParams = Parameters<ToolBatchExecutionService['execute']>[0];

export function makeToolManagerAgent(
  batchResult: (params: BatchParams) => unknown = () => ({ success: true })
): {
  agent: IAgent;
  batchExecute: jest.Mock;
} {
  // Minimal registry so normalizeExecutionCalls can resolve `content read`,
  // `memory load-workspace` and `memory list-workspaces` — the normalizer
  // rejects unknown commands.
  const readTool = {
    slug: 'read', name: 'Read', description: 'Read a note', version: '1.0.0',
    execute: jest.fn().mockResolvedValue({ success: true }),
    getParameterSchema: () => ({ type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }),
    getResultSchema: () => ({ type: 'object' })
  } as unknown as ITool;
  const loadWorkspaceTool = {
    slug: 'loadWorkspace', name: 'Load Workspace', description: 'Load a workspace', version: '1.0.0',
    execute: jest.fn().mockResolvedValue({ success: true }),
    getParameterSchema: () => ({ type: 'object', properties: { workspace: { type: 'string' } }, required: ['workspace'] }),
    getResultSchema: () => ({ type: 'object' })
  } as unknown as ITool;
  const listWorkspacesTool = {
    slug: 'listWorkspaces', name: 'List Workspaces', description: 'List workspaces', version: '1.0.0',
    execute: jest.fn().mockResolvedValue({ success: true }),
    getParameterSchema: () => ({ type: 'object', properties: {} }),
    getResultSchema: () => ({ type: 'object' })
  } as unknown as ITool;
  const stubAgent = (name: string, tools: ITool[]): IAgent => ({
    name, description: '', version: '1.0.0',
    getTools: () => tools,
    getTool: (slug: string) => tools.find(tool => tool.slug === slug),
    initialize: jest.fn(), executeTool: jest.fn(), setAgentManager: jest.fn()
  });
  const registry = new Map<string, IAgent>([
    ['contentManager', stubAgent('contentManager', [readTool])],
    ['memoryManager', stubAgent('memoryManager', [loadWorkspaceTool, listWorkspacesTool])]
  ]);
  const normalizer = new ToolCliNormalizer(registry);
  const batchExecute = jest.fn(async (params: BatchParams) => batchResult(params));
  const batchService = { execute: batchExecute } as unknown as ToolBatchExecutionService;
  const useTools = new UseToolTool(batchService, normalizer);
  const getTools = new GetToolsTool(registry, { workspaces: [], customAgents: [], vaultRoot: [] });
  const tools = new Map<string, ITool>([['useTools', useTools], ['getTools', getTools]]);
  const agent: IAgent = {
    name: 'toolManager',
    description: '',
    version: '1.0.0',
    getTools: () => Array.from(tools.values()),
    getTool: (slug: string) => tools.get(slug),
    initialize: jest.fn(),
    executeTool: jest.fn(async (slug: string, params: Record<string, unknown>) => {
      const tool = tools.get(slug);
      if (!tool) throw new Error(`unknown tool ${slug}`);
      return tool.execute(params);
    }),
    setAgentManager: jest.fn()
  };
  return { agent, batchExecute };
}

export interface Captured {
  result?: ToolExecutionResult;
  sessionInfo?: SessionInfo;
}

export function makeDeps(captured: Captured): IRequestHandlerDependencies {
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
      // Real dispatch into the agent so a thrown normalizer steer propagates
      // exactly the way ToolExecutionService.executeAgent rethrows it.
      executeAgent: jest.fn(async (agent: IAgent, tool: string, params: Record<string, unknown>) => {
        return await agent.executeTool(tool, params) as ToolExecutionResult;
      })
    },
    responseFormatter: {
      formatToolExecutionResponse: jest.fn((result: ToolExecutionResult, sessionInfo?: SessionInfo) => {
        captured.result = result;
        captured.sessionInfo = sessionInfo;
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
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

export const ENVELOPE = {
  sessionId: 'nexus-cli',
  memory: 'Listed the vault and the workspaces.',
  goal: 'Read one note.'
};

export function useToolsRequest(extra: Record<string, unknown> = {}) {
  return {
    params: {
      name: 'toolManager_useTools',
      arguments: { ...ENVELOPE, tool: 'content read --path notes/a.md', ...extra }
    }
  };
}

export function getToolsRequest(extra: Record<string, unknown> = {}) {
  return {
    params: {
      name: 'toolManager_getTools',
      arguments: { ...ENVELOPE, tool: '--help', ...extra }
    }
  };
}

export function makeStrategy(manager: SessionContextManager, agentFactory = makeToolManagerAgent) {
  const captured: Captured = {};
  const { agent, batchExecute } = agentFactory();
  const strategy = new ToolExecutionStrategy(makeDeps(captured), () => agent, manager);
  return { strategy, captured, batchExecute };
}
