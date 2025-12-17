/**
 * AgentRegistry - Handles agent registration and management
 * Follows Single Responsibility Principle by focusing only on agent operations
 */

import { IAgent } from '../../agents/interfaces/IAgent';
import { NexusError, NexusErrorCode } from '../../utils/errors';
import { logger } from '../../utils/logger';

/**
 * Service responsible for agent registration and management
 * Follows SRP by focusing only on agent operations
 */
export class AgentRegistry {
    private agents: Map<string, IAgent> = new Map();

    /**
     * Register an agent with the registry
     */
    registerAgent(agent: IAgent): void {
        if (this.agents.has(agent.name)) {
            throw new NexusError(
                NexusErrorCode.InvalidParams,
                `Agent ${agent.name} is already registered`
            );
        }

        this.agents.set(agent.name, agent);
        logger.systemLog(`Agent registered: ${agent.name}`);
    }

    /**
     * Get an agent by name
     */
    getAgent(name: string): IAgent {
        const agent = this.agents.get(name);
        
        if (!agent) {
            throw new NexusError(
                NexusErrorCode.InvalidParams,
                `Agent ${name} not found`
            );
        }

        return agent;
    }

    /**
     * Check if an agent is registered
     */
    hasAgent(name: string): boolean {
        return this.agents.has(name);
    }

    /**
     * Get all registered agents
     */
    getAgents(): Map<string, IAgent> {
        return new Map(this.agents);
    }

    /**
     * Get all agent names
     */
    getAgentNames(): string[] {
        return Array.from(this.agents.keys());
    }

    /**
     * Remove an agent from the registry
     */
    unregisterAgent(name: string): boolean {
        const removed = this.agents.delete(name);
        
        if (removed) {
            logger.systemLog(`Agent unregistered: ${name}`);
        }
        
        return removed;
    }

    /**
     * Initialize all registered agents
     */
    async initializeAgents(): Promise<void> {
        const initPromises = Array.from(this.agents.values()).map(async (agent) => {
            try {
                await agent.initialize();
                logger.systemLog(`Agent initialized: ${agent.name}`);
            } catch (error) {
                logger.systemError(error as Error, `Agent Initialization: ${agent.name}`);
                throw error;
            }
        });

        await Promise.all(initPromises);
    }

    /**
     * Get agent count
     */
    getAgentCount(): number {
        return this.agents.size;
    }

    /**
     * Clear all agents
     */
    clearAgents(): void {
        this.agents.clear();
    }

    /**
     * Get agent statistics
     */
    getAgentStatistics(): {
        totalAgents: number;
        agentNames: string[];
        agentInfo: Array<{
            name: string;
            description: string;
            modeCount: number;
        }>;
    } {
        const agentInfo = Array.from(this.agents.values()).map(agent => {
            try {
                const modes = agent.getModes();
                return {
                    name: agent.name,
                    description: agent.description,
                    modeCount: modes.length
                };
            } catch (error) {
                return {
                    name: agent.name,
                    description: agent.description,
                    modeCount: 0
                };
            }
        });

        return {
            totalAgents: this.agents.size,
            agentNames: this.getAgentNames(),
            agentInfo
        };
    }

    /**
     * Validate agent exists and get it
     */
    validateAndGetAgent(name: string): IAgent {
        if (!name || typeof name !== 'string') {
            throw new NexusError(
                NexusErrorCode.InvalidParams,
                'Agent name must be a non-empty string'
            );
        }

        return this.getAgent(name);
    }

    /**
     * Get agent mode help
     */
    getAgentModeHelp(agentName: string, modeName: string): string {
        const agent = this.validateAndGetAgent(agentName);
        const mode = agent.getMode(modeName);

        if (!mode) {
            throw new NexusError(
                NexusErrorCode.InvalidParams,
                `Mode ${modeName} not found in agent ${agentName}`
            );
        }

        const modeWithHelp = mode as { getHelpText?: () => string };
        return modeWithHelp.getHelpText?.() || `Help for ${agentName}.${modeName}`;
    }

    /**
     * Check if agent supports a specific mode
     */
    agentSupportsMode(agentName: string, modeName: string): boolean {
        try {
            const agent = this.getAgent(agentName);
            return agent.getMode(modeName) !== null;
        } catch (error) {
            return false;
        }
    }

    /**
     * Get all available modes across all agents
     */
    getAllAvailableModes(): Array<{
        agentName: string;
        modeName: string;
        description: string;
    }> {
        const allModes: Array<{
            agentName: string;
            modeName: string;
            description: string;
        }> = [];

        for (const [agentName, agent] of this.agents) {
            try {
                const modes = agent.getModes();
                for (const mode of modes) {
                    allModes.push({
                        agentName,
                        modeName: mode.name,
                        description: mode.description
                    });
                }
            } catch (error) {
                logger.systemError(error as Error, `Mode Enumeration: ${agentName}`);
            }
        }

        return allModes;
    }
}