// Import ITool from separate file
import { ITool } from './ITool';

/**
 * Interface for agents in the MCP plugin
 * Each agent is responsible for a specific domain and provides a set of tools
 */
export interface IAgent {
  /**
   * Name of the agent
   */
  name: string;

  /**
   * Description of the agent
   */
  description: string;

  /**
   * Version of the agent
   */
  version: string;

  /**
   * Get all tools provided by this agent
   * @returns Array of tools
   */
  getTools(): ITool[];

  /**
   * Get a specific tool by slug
   * @param toolSlug Slug of the tool to get
   * @returns Tool with the specified slug or undefined if not found
   */
  getTool(toolSlug: string): ITool | undefined;

  /**
   * Initialize the agent
   * @returns Promise that resolves when initialization is complete
   */
  initialize(): Promise<void>;

  /**
   * Execute a tool with parameters
   * @param toolSlug Slug of the tool to execute
   * @param params Parameters to pass to the tool
   * @returns Promise that resolves with the tool's result
   */
  executeTool(toolSlug: string, params: any): Promise<any>;

  /**
   * Set the agent manager reference
   * @param agentManager Agent manager instance
   */
  setAgentManager(agentManager: any): void;

}