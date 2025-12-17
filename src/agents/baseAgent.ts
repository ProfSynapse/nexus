import { IAgent } from './interfaces/IAgent';
import { IMode } from './interfaces/IMode';
import { CommonParameters, CommonResult } from '../types';
import { parseWorkspaceContext } from '../utils/contextUtils';
import { createErrorMessage } from '../utils/errorUtils';

/**
 * Extended mode interface that includes optional BaseMode methods
 * Used for type-safe access to workspace context propagation methods
 */
interface IModeWithContext extends IMode {
  sessionId?: string;
  setParentContext?(context: CommonResult['workspaceContext']): void;
  getInheritedWorkspaceContext?(params: CommonParameters): CommonResult['workspaceContext'] | null;
}

/**
 * Base class for all agents in the MCP plugin
 * Provides common functionality for agent implementation
 */
export abstract class BaseAgent implements IAgent {
  name: string;
  protected _description: string;
  version: string;
  protected modes: Map<string, IMode> = new Map();
  
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
   * Get all modes provided by this agent
   * @returns Array of modes
   */
  getModes(): IMode[] {
    return Array.from(this.modes.values());
  }
  
  /**
   * Get a specific mode by slug
   * @param modeSlug Slug of the mode to get
   * @returns Mode with the specified slug or undefined if not found
   */
  getMode(modeSlug: string): IMode | undefined {
    return this.modes.get(modeSlug);
  }
  
  /**
   * Register a mode with this agent
   * @param mode Mode to register
   */
  registerMode(mode: IMode): void {
    this.modes.set(mode.slug, mode);
  }

  /**
   * Unregister a mode from this agent
   * @param modeSlug Slug of the mode to unregister
   * @returns true if mode was removed, false if it didn't exist
   */
  unregisterMode(modeSlug: string): boolean {
    return this.modes.delete(modeSlug);
  }

  /**
   * Check if a mode is registered
   * @param modeSlug Slug of the mode to check
   */
  hasMode(modeSlug: string): boolean {
    return this.modes.has(modeSlug);
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
   * Execute a mode by slug
   * @param modeSlug Slug of the mode to execute
   * @param params Parameters to pass to the mode
   * @returns Promise that resolves with the mode's result
   * @throws Error if mode not found
   */
  async executeMode(modeSlug: string, params: CommonParameters): Promise<CommonResult> {
    const mode = this.modes.get(modeSlug);
    if (!mode) {
      // Build helpful error with suggestions
      const errorInfo = this.buildModeNotFoundError(modeSlug);
      throw new Error(errorInfo);
    }

    // Session ID and description are now required for all tool calls (in context)
    if (!params.context?.sessionId) {
      // Return error if sessionId is missing - provide helpful message about providing session name
      return {
        success: false,
        error: createErrorMessage('Session ID required: ',
          `Mode ${modeSlug} requires context.sessionId. Provide a 2-4 word session name or existing session ID in the context block.`),
        data: null
      };
    }

    // sessionDescription is optional but recommended for better session management
    if (!params.context?.sessionDescription) {
      console.warn(`[${this.name}] context.sessionDescription not provided for ${modeSlug}. Consider providing a brief description for better session tracking.`);
    }

    // Cast to extended interface for type-safe access to optional methods
    const modeWithContext = mode as IModeWithContext;

    // Store the sessionId on the mode instance for use in prepareResult
    if ('sessionId' in modeWithContext) {
      modeWithContext.sessionId = params.context.sessionId;
    }

    // If the mode has setParentContext method, use it to propagate workspace context
    // Pass the workspace context even if undefined, as the mode's setParentContext
    // method can handle the default context inheritance logic
    if (typeof modeWithContext.setParentContext === 'function') {
      // Parse workspace context if it's a string, to ensure it's a proper WorkspaceContext object
      const parsedContext = typeof params.workspaceContext === 'string'
        ? parseWorkspaceContext(params.workspaceContext) ?? undefined
        : params.workspaceContext;
      modeWithContext.setParentContext(parsedContext);
    }

    // If the mode supports getInheritedWorkspaceContext and there's no explicit workspace context,
    // try to retrieve the inherited context and apply it to the params
    if (typeof modeWithContext.getInheritedWorkspaceContext === 'function' &&
        (!params.workspaceContext || !parseWorkspaceContext(params.workspaceContext)?.workspaceId)) {
      const inheritedContext = modeWithContext.getInheritedWorkspaceContext(params);
      if (inheritedContext) {
        params = {
          ...params,
          workspaceContext: inheritedContext
        };
      }
    }

    // Execute the requested mode
    const result = await mode.execute(params);

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
   * Build a helpful error message when a mode is not found
   * Checks if the mode exists on other agents and suggests the correct one
   */
  private buildModeNotFoundError(modeSlug: string): string {
    const lines: string[] = [];

    // Check if this mode exists on another agent
    if (this.agentManager) {
      const correctAgent = this.findModeInOtherAgents(modeSlug);
      if (correctAgent) {
        lines.push(`Mode "${modeSlug}" not found in "${this.name}".`);
        lines.push(`💡 Did you mean: ${correctAgent.agentName} with mode: ${correctAgent.modeName}?`);
        lines.push('');
        lines.push('Correct usage:');
        lines.push(`  Tool: ${correctAgent.agentName}`);
        lines.push(`  Arguments: { "mode": "${correctAgent.modeName}", ... }`);
        return lines.join('\n');
      }
    }

    // List available modes on this agent
    const availableModes = Array.from(this.modes.keys());
    lines.push(`Mode "${modeSlug}" not found in agent "${this.name}".`);
    lines.push('');
    lines.push(`Available modes for ${this.name}:`);
    availableModes.forEach(m => lines.push(`  - ${m}`));

    return lines.join('\n');
  }

  /**
   * Search other agents for a mode by slug
   * Returns the agent name and mode slug if found
   */
  private findModeInOtherAgents(modeSlug: string): { agentName: string; modeName: string } | null {
    if (!this.agentManager) return null;

    // Common LLM mistakes - maps FAKE mode names to correct agent/mode
    // Only include modes that DON'T exist anywhere
    const modeAliases: Record<string, { agent: string; mode: string }> = {
      // LLMs often use "Note" instead of "Content" for content ops
      // Note: deleteNote EXISTS on vaultManager, so not included here
      'createNote': { agent: 'contentManager', mode: 'createContent' },
      'readNote': { agent: 'contentManager', mode: 'readContent' },
      'appendNote': { agent: 'contentManager', mode: 'appendContent' },
      'writeNote': { agent: 'contentManager', mode: 'createContent' },
      'editNote': { agent: 'contentManager', mode: 'replaceContent' },

      // LLMs might call generic "search" on wrong agent
      'search': { agent: 'vaultLibrarian', mode: 'searchContent' },
    };

    // Check aliases first
    const alias = modeAliases[modeSlug];
    if (alias && alias.agent !== this.name) {
      return { agentName: alias.agent, modeName: alias.mode };
    }

    // Search known agent names for exact mode match
    const agentNames = ['vaultManager', 'contentManager', 'vaultLibrarian', 'memoryManager', 'commandManager', 'agentManager'];

    for (const agentName of agentNames) {
      if (agentName === this.name) continue;

      const agent = this.agentManager.getAgent(agentName);
      if (agent) {
        // Exact match
        const mode = agent.getMode(modeSlug);
        if (mode) {
          return { agentName, modeName: mode.slug };
        }

        // Case-insensitive match
        for (const m of agent.getModes()) {
          if (m.slug.toLowerCase() === modeSlug.toLowerCase()) {
            return { agentName, modeName: m.slug };
          }
        }
      }
    }

    return null;
  }
}