/**
 * Tool Visibility Configuration
 *
 * Controls which agents and tools are exposed as MCP tools.
 * Set `hidden: true` to temporarily disable tools without deleting code.
 *
 * This configuration affects:
 * - Claude Desktop MCP tool list
 * - Internal chat bounded context tool discovery
 * - Agent tool registration at initialization
 */

export interface ModeVisibilityConfig {
    hidden: boolean;
    reason?: string;
}

export interface AgentVisibilityConfig {
    hidden?: boolean;  // If true, hides entire agent
    reason?: string;
    modes?: {
        [modeName: string]: ModeVisibilityConfig;
    };
}

export const TOOL_VISIBILITY: {
    [agentName: string]: AgentVisibilityConfig;
} = {
    // commandManager was removed from codebase (2026-01-24)
    // Add agent visibility configs here as needed
};

/**
 * Check if an agent should be hidden
 */
export function isAgentHidden(agentName: string): boolean {
    const config = TOOL_VISIBILITY[agentName];
    return config?.hidden === true;
}

/**
 * Check if a specific tool should be hidden
 */
export function isModeHidden(agentName: string, modeName: string): boolean {
    const config = TOOL_VISIBILITY[agentName];

    // If entire agent is hidden, all tools are hidden
    if (config?.hidden === true) {
        return true;
    }

    // Check specific tool visibility
    return config?.modes?.[modeName]?.hidden === true;
}

/**
 * Get the reason why a tool is hidden (for logging/debugging)
 */
export function getHiddenReason(agentName: string, modeName?: string): string | undefined {
    const config = TOOL_VISIBILITY[agentName];

    if (modeName && config?.modes?.[modeName]) {
        return config.modes[modeName].reason;
    }

    return config?.reason;
}
