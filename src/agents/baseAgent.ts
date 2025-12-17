import { IAgent } from './interfaces/IAgent';
import { ITool } from './interfaces/ITool';
import { CommonResult } from '../types';

/**
 * Base class for all agents in the MCP plugin
 * Provides common functionality for agent implementation
 */
export abstract class BaseAgent implements IAgent {
  name: string;
  protected _description: string;
  version: string;
  protected tools: Map<string, ITool> = new Map();

  // Reference to agent manager
  protected agentManager?: {
    getAgent(agentName: string): IAgent | undefined;
  };
  
  /**
   * Create a new agent
   * @param name Name of the agent
   * @param description Description of the agent
   * @param version Version of the agent
   */
  constructor(name: string, description: string, version: string) {
    this.name = name;
    this._description = description;
    this.version = version;
  }

  /**
   * Get the agent description
   * Can be overridden by subclasses for dynamic descriptions
   */
  get description(): string {
    return this._description;
  }
  
  /**
   * Set the agent manager reference
   * @param manager Agent manager instance
   */
  setAgentManager(manager: { getAgent(agentName: string): IAgent | undefined }): void {
    this.agentManager = manager;
  }
  
  /**
   * Get all tools provided by this agent
   * @returns Array of tools
   */
  getTools(): ITool[] {
    return Array.from(this.tools.values());
  }

  /**
   * Get a specific tool by slug
   * @param toolSlug Slug of the tool to get
   * @returns Tool with the specified slug or undefined if not found
   */
  getTool(toolSlug: string): ITool | undefined {
    return this.tools.get(toolSlug);
  }

  /**
   * Register a tool with this agent
   * @param tool Tool to register
   */
  registerTool(tool: ITool): void {
    this.tools.set(tool.slug, tool);
  }

  /**
   * Unregister a tool from this agent
   * @param toolSlug Slug of the tool to unregister
   * @returns true if tool was removed, false if it didn't exist
   */
  unregisterTool(toolSlug: string): boolean {
    return this.tools.delete(toolSlug);
  }

  /**
   * Check if a tool is registered
   * @param toolSlug Slug of the tool to check
   */
  hasTool(toolSlug: string): boolean {
    return this.tools.has(toolSlug);
  }
  
  /**
   * Initialize the agent
   * Default implementation does nothing
   * @returns Promise that resolves when initialization is complete
   */
  async initialize(): Promise<void> {
    // Default implementation does nothing
  }
  
  /**
   * Execute a tool by slug
   * @param toolSlug Slug of the tool to execute
   * @param params Parameters to pass to the tool (tool-specific only, no context)
   * @returns Promise that resolves with the tool's result
   * @throws Error if tool not found
   */
  async executeTool(toolSlug: string, params: Record<string, unknown>): Promise<CommonResult> {
    const tool = this.tools.get(toolSlug);
    if (!tool) {
      // Build helpful error with suggestions
      const errorInfo = this.buildToolNotFoundError(toolSlug);
      throw new Error(errorInfo);
    }

    // Execute the tool with its specific params
    // Context/session validation happens at useTool level, not here
    const result = await tool.execute(params);

    return result;
  }
  
  
  /**
   * Clean up resources when the agent is unloaded
   * This is a base implementation that child classes can extend
   */
  onunload(): void {
    // Default implementation does nothing
  }

  /**
   * Build a helpful error message when a tool is not found
   * Checks if the tool exists on other agents and suggests the correct one
   */
  private buildToolNotFoundError(toolSlug: string): string {
    const lines: string[] = [];

    // Check if this tool exists on another agent
    if (this.agentManager) {
      const correctAgent = this.findToolInOtherAgents(toolSlug);
      if (correctAgent) {
        lines.push(`Tool "${toolSlug}" not found in "${this.name}".`);
        lines.push(`💡 Did you mean: ${correctAgent.agentName} with tool: ${correctAgent.toolName}?`);
        lines.push('');
        lines.push('Correct usage:');
        lines.push(`  Agent: ${correctAgent.agentName}`);
        lines.push(`  Arguments: { "tool": "${correctAgent.toolName}", ... }`);
        return lines.join('\n');
      }
    }

    // List available tools on this agent
    const availableTools = Array.from(this.tools.keys());
    lines.push(`Tool "${toolSlug}" not found in agent "${this.name}".`);
    lines.push('');
    lines.push(`Available tools for ${this.name}:`);
    availableTools.forEach(t => lines.push(`  - ${t}`));

    return lines.join('\n');
  }

  /**
   * Search other agents for a tool by slug
   * Returns the agent name and tool slug if found
   */
  private findToolInOtherAgents(toolSlug: string): { agentName: string; toolName: string } | null {
    if (!this.agentManager) return null;

    // Common LLM mistakes - maps FAKE tool names to correct agent/tool
    // Only include tools that DON'T exist anywhere
    const toolAliases: Record<string, { agent: string; tool: string }> = {
      // LLMs often use "Note" instead of "Content" for content ops
      // Note: deleteNote EXISTS on vaultManager, so not included here
      'createNote': { agent: 'contentManager', tool: 'createContent' },
      'readNote': { agent: 'contentManager', tool: 'readContent' },
      'appendNote': { agent: 'contentManager', tool: 'appendContent' },
      'writeNote': { agent: 'contentManager', tool: 'createContent' },
      'editNote': { agent: 'contentManager', tool: 'replaceContent' },

      // LLMs might call generic "search" on wrong agent
      'search': { agent: 'vaultLibrarian', tool: 'searchContent' },
    };

    // Check aliases first
    const alias = toolAliases[toolSlug];
    if (alias && alias.agent !== this.name) {
      return { agentName: alias.agent, toolName: alias.tool };
    }

    // Search known agent names for exact tool match
    const agentNames = ['vaultManager', 'contentManager', 'vaultLibrarian', 'memoryManager', 'commandManager', 'agentManager'];

    for (const agentName of agentNames) {
      if (agentName === this.name) continue;

      const agent = this.agentManager.getAgent(agentName);
      if (agent) {
        // Exact match
        const tool = agent.getTool(toolSlug);
        if (tool) {
          return { agentName, toolName: tool.slug };
        }

        // Case-insensitive match
        for (const t of agent.getTools()) {
          if (t.slug.toLowerCase() === toolSlug.toLowerCase()) {
            return { agentName, toolName: t.slug };
          }
        }
      }
    }

    return null;
  }
}