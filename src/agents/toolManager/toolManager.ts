/**
 * ToolManager Agent
 * Provides the two-tool architecture: getTools and useTool
 *
 * This agent consolidates all tool access through a unified interface,
 * enforcing context-first design and reducing token usage.
 */

import { App } from 'obsidian';
import { BaseAgent } from '../baseAgent';
import { IAgent } from '../interfaces/IAgent';
import { GetToolsTool, UseToolTool } from './tools';
import { ToolBatchExecutionService } from './services/ToolBatchExecutionService';
import { ToolCliNormalizer } from './services/ToolCliNormalizer';

/**
 * Schema data injected at startup for dynamic tool descriptions
 * Allows Claude to see available workspaces, custom agents, and vault structure
 * without needing to call discovery tools first.
 */
export interface SchemaData {
  workspaces: { name: string; description?: string }[];
  customAgents: { name: string; description?: string }[];
  vaultRoot: string[];
}

/**
 * Configuration for ToolManager agent
 */
export const ToolManagerConfig = {
  name: 'toolManager',
  displayName: 'Tool Manager',
  description: 'Discover and execute tools across all agents with unified context',
  version: '1.0.0'
};

/**
 * Agent for tool discovery and execution
 * Provides the two-tool interface: getTools + useTool
 */
export class ToolManagerAgent extends BaseAgent {
  private app: App;
  private allAgents: Map<string, IAgent>;
  private toolBatchExecutionService: ToolBatchExecutionService;
  private toolCliNormalizer: ToolCliNormalizer;
  private getToolsTool: GetToolsTool;
  private useToolTool: UseToolTool;

  /**
   * Create a new ToolManagerAgent
   * @param app Obsidian app instance
   * @param agentRegistry Map of all registered agents (excluding toolManager itself)
   * @param schemaData Dynamic data for tool descriptions (workspaces, custom agents, vault structure)
   */
  constructor(app: App, agentRegistry: Map<string, IAgent>, schemaData?: SchemaData) {
    super(
      ToolManagerConfig.name,
      ToolManagerConfig.description,
      ToolManagerConfig.version
    );

    this.app = app;
    this.allAgents = agentRegistry;

    // Default schema data if not provided
    const data: SchemaData = schemaData || { workspaces: [], customAgents: [], vaultRoot: [] };
    this.toolBatchExecutionService = new ToolBatchExecutionService(app, agentRegistry, data.workspaces);
    this.toolCliNormalizer = new ToolCliNormalizer(agentRegistry);

    // Register the two tools with schema data
    this.getToolsTool = new GetToolsTool(agentRegistry, data);
    this.useToolTool = new UseToolTool(this.toolBatchExecutionService, this.toolCliNormalizer);
    this.registerTool(this.getToolsTool);
    this.registerTool(this.useToolTool);
  }

  /**
   * Get the agent registry
   * @returns Map of agent name to agent instance
   */
  getAgentRegistry(): Map<string, IAgent> {
    return this.allAgents;
  }

  /**
   * Get the shared batch execution service for useTools.
   */
  getToolBatchExecutionService(): ToolBatchExecutionService {
    return this.toolBatchExecutionService;
  }

  /**
   * Get the shared CLI normalizer used by useTools. Callers outside the agent
   * (e.g. DirectToolExecutor) should reuse this instance instead of building
   * a parallel normalizer, so parser behavior stays single-source.
   */
  getToolCliNormalizer(): ToolCliNormalizer {
    return this.toolCliNormalizer;
  }

  registerDynamicAgent(agent: IAgent): void {
    this.allAgents.set(agent.name, agent);
    this.getToolsTool.refreshDescription();
  }

  unregisterDynamicAgent(agentName: string): void {
    this.allAgents.delete(agentName);
    this.getToolsTool.refreshDescription();
  }

  refreshSchemaData(schemaData: SchemaData): void {
    this.getToolsTool.refreshDescription(schemaData);
  }
}
