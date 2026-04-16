/**
 * tests/eval/headless/HeadlessAgentStack.ts — Factory that initializes
 * real Nexus agents against a TestVault for the eval harness.
 *
 * Creates: ContentManager, StorageManager, CanvasManager, SearchManager
 * (vector off), and ToolManager. Returns the two-tool interface
 * (getTools/useTools) that LiveToolExecutor routes through.
 */

import { TestApp, TestAppOptions } from './TestApp';
import { ContentManagerAgent } from '../../../src/agents/contentManager/contentManager';
import { StorageManagerAgent } from '../../../src/agents/storageManager/storageManager';
import { CanvasManagerAgent } from '../../../src/agents/canvasManager/canvasManager';
import { SearchManagerAgent } from '../../../src/agents/searchManager/searchManager';
import { ToolManagerAgent, SchemaData } from '../../../src/agents/toolManager/toolManager';
import type { IAgent } from '../../../src/agents/interfaces/IAgent';
import type { GetToolsParams, GetToolsResult, UseToolParams, UseToolResult } from '../../../src/agents/toolManager/types';

export interface HeadlessAgentStackResult {
  app: TestApp;
  agentRegistry: Map<string, IAgent>;
  toolManager: ToolManagerAgent;
  getTools: (params: GetToolsParams) => Promise<GetToolsResult>;
  useTools: (params: UseToolParams) => Promise<UseToolResult>;
}

/**
 * Create a headless agent stack backed by a real filesystem directory.
 *
 * @param options - TestApp options (basePath, vaultName)
 * @returns Initialized stack with getTools/useTools entry points
 */
export async function createHeadlessAgentStack(
  options: TestAppOptions,
): Promise<HeadlessAgentStackResult> {
  // Ensure document exists for SearchManager's createMinimalPlugin fallback
  if (typeof document === 'undefined') {
    (globalThis as Record<string, unknown>).document = {
      createElement: () => ({}),
    };
  }

  const testApp = new TestApp(options);
  const app = testApp.asApp();

  // Initialize agents with real constructors
  const contentManager = new ContentManagerAgent(app);
  const storageManager = new StorageManagerAgent(app);
  const canvasManager = new CanvasManagerAgent(app);
  const searchManager = new SearchManagerAgent(app, false);

  // Build agent registry
  const agentRegistry = new Map<string, IAgent>();
  agentRegistry.set('contentManager', contentManager);
  agentRegistry.set('storageManager', storageManager);
  agentRegistry.set('canvasManager', canvasManager);
  agentRegistry.set('searchManager', searchManager);

  // Create ToolManager with empty schema data (no workspaces/custom agents in test)
  const schemaData: SchemaData = {
    workspaces: [],
    customAgents: [],
    vaultRoot: [],
  };
  const toolManager = new ToolManagerAgent(app, agentRegistry, schemaData);

  // Set agent manager references so cross-agent tool lookup works
  const agentManagerStub = {
    getAgent: (name: string) => agentRegistry.get(name),
  };
  Array.from(agentRegistry.values()).forEach(agent => {
    agent.setAgentManager(agentManagerStub as never);
  });

  // Initialize all agents
  await Promise.all([
    contentManager.initialize(),
    storageManager.initialize(),
    canvasManager.initialize(),
    searchManager.initialize(),
  ]);

  // Build getTools/useTools entry points via ToolManager's tools
  const getToolsTool = toolManager.getTool('getTools')!;
  const useToolsTool = toolManager.getTool('useTools')!;

  const getTools = async (params: GetToolsParams): Promise<GetToolsResult> => {
    return (await getToolsTool.execute(params as unknown as Record<string, unknown>)) as unknown as GetToolsResult;
  };

  const useTools = async (params: UseToolParams): Promise<UseToolResult> => {
    return (await useToolsTool.execute(params as unknown as Record<string, unknown>)) as unknown as UseToolResult;
  };

  return {
    app: testApp,
    agentRegistry,
    toolManager,
    getTools,
    useTools,
  };
}
