/**
 * Location: src/services/agent/LazyAgentProvider.ts
 *
 * LazyAgentProvider - Provides agent access without triggering initialization
 *
 * Agents are initialized on first access, not at construction time.
 * This enables fast startup by deferring agent creation until tools are used.
 *
 * Used by: DirectToolExecutor, ServiceDefinitions
 * Dependencies: AgentRegistrationService
 */

import type { IAgent } from '../../agents/interfaces/IAgent';
import type { AgentRegistrationService } from './AgentRegistrationService';

/**
 * Interface for agent providers - abstracts agent access for DirectToolExecutor.
 * Both AgentRegistry and LazyAgentProvider can fulfill this contract.
 */
export interface AgentProvider {
    getAllAgents(): Map<string, IAgent> | IAgent[];
    getAgent?(name: string): IAgent | null;
    hasAgent?(name: string): boolean;
    agentSupportsMode?(agentName: string, modeName: string): boolean;
    getAgentAsync?(name: string): Promise<IAgent | null>;
}

/**
 * LazyAgentProvider wraps AgentRegistrationService to provide agent access
 * without triggering initialization at construction time.
 *
 * Key behaviors:
 * - getAgent() returns cached agents or null (triggers background init)
 * - getAgentAsync() awaits agent initialization if needed
 * - getAllAgents() returns only initialized agents (no blocking)
 */
export class LazyAgentProvider implements AgentProvider {
    private agentRegistrationService: AgentRegistrationService;
    private initializedAgents = new Map<string, IAgent>();

    constructor(agentRegistrationService: AgentRegistrationService) {
        this.agentRegistrationService = agentRegistrationService;
    }

    /**
     * Get all agents - returns agents that have been initialized.
     * If full initialization is complete, returns all agents.
     * Otherwise returns only lazily-loaded agents.
     *
     * NOTE: This method does NOT block or trigger initialization.
     * Use getAllAgentsAsync() if you need all agents guaranteed.
     */
    getAllAgents(): Map<string, IAgent> {
        // If agents are already fully initialized, return them
        if (this.agentRegistrationService.isAgentsInitialized?.()) {
            return this.agentRegistrationService.getAllAgents();
        }

        // Return only agents that have been accessed (lazy-loaded)
        return this.initializedAgents;
    }

    /**
     * Get single agent asynchronously - initializes on first access.
     * This is the preferred method when you need guaranteed agent availability.
     */
    async getAgentAsync(name: string): Promise<IAgent | null> {
        // Check local cache first (fastest path)
        if (this.initializedAgents.has(name)) {
            return this.initializedAgents.get(name) ?? null;
        }

        // Check if already initialized in registration service
        const existingSync = this.agentRegistrationService.getAgent(name);
        if (existingSync) {
            this.initializedAgents.set(name, existingSync);
            return existingSync;
        }

        // Initialize the specific agent via async method (awaits full initialization)
        const agent = await this.agentRegistrationService.getAgentAsync?.(name);
        if (agent) {
            this.initializedAgents.set(name, agent);
        }
        return agent ?? null;
    }

    /**
     * Sync version - returns agent if already initialized, null otherwise.
     * Triggers async initialization in background for future calls.
     *
     * Use this for non-blocking access where you can handle null gracefully.
     * Use getAgentAsync() when you need the agent guaranteed.
     */
    getAgent(name: string): IAgent | null {
        // Check local cache (fastest path)
        if (this.initializedAgents.has(name)) {
            return this.initializedAgents.get(name) ?? null;
        }

        // Check if registration service has it initialized
        const existing = this.agentRegistrationService.getAgent(name);
        if (existing) {
            this.initializedAgents.set(name, existing);
            return existing;
        }

        // Trigger async initialization but return null for now
        // Caller should retry or use getAgentAsync() for guaranteed access
        this.getAgentAsync(name).catch(() => {
            // Silently ignore - initialization will be retried on next access
        });
        return null;
    }

    /**
     * Check if an agent exists (either initialized or known to registration service).
     */
    hasAgent(name: string): boolean {
        return this.initializedAgents.has(name) ||
               this.agentRegistrationService.getAgent(name) !== null;
    }

    /**
     * Check if an agent supports a specific mode/tool.
     * Returns true by default - let execution fail if tool not supported.
     * This avoids needing to enumerate all tools at construction time.
     */
    agentSupportsMode(): boolean {
        return true;
    }
}
