import { IAgent } from '../agents/interfaces/IAgent';
import { App, Events } from 'obsidian';

/**
 * Agent management service
 * Manages agent registration, initialization, and execution
 */
export class AgentManager {
  private agents: Map<string, IAgent> = new Map();

  /**
   * Create a new agent manager
   * @param app Obsidian app instance
   * @param plugin Plugin instance
   * @param events Obsidian Events instance
   */
  constructor(
    _app: App,
    _plugin: any,
    _events: Events
  ) {
    // We're not currently using these parameters but they might be needed in the future
    // No need to store them as class properties for now
    // Using underscore prefix to indicate intentionally unused parameters
  }
  
  /**
   * Register an agent
   * @param agent Agent to register
   * @throws Error if agent with same name is already registered
   */
  registerAgent(agent: IAgent): void {
    if (this.agents.has(agent.name)) {
      throw new Error(`Agent ${agent.name} is already registered`);
    }
    
    this.agents.set(agent.name, agent);
    
    // Set the agent manager reference for inter-agent communication
    agent.setAgentManager(this);
  }
  
  /**
   * Get an agent by name
   * @param name Name of the agent
   * @returns Agent instance
   * @throws Error if agent not found
   */
  getAgent(name: string): IAgent {
    const agent = this.agents.get(name);
    if (!agent) {
      throw new Error(`Agent ${name} not found`);
    }
    
    return agent;
  }
  
  /**
   * Get all registered agents
   * @returns Array of agent instances
   */
  getAgents(): IAgent[] {
    return Array.from(this.agents.values());
  }
  
  /**
   * Execute a tool on an agent
   * @param agentName Name of the agent
   * @param tool Tool to execute
   * @param params Parameters to pass to the tool
   * @returns Promise that resolves with the tool's result
   */
  async executeAgentTool(agentName: string, tool: string, params: Record<string, unknown>): Promise<unknown> {
    const agent = this.getAgent(agentName);
    return await agent.executeTool(tool, params);
  }

  /**
   * Initialize all registered agents
   * @returns Promise that resolves when all agents are initialized
   */
  async initializeAgents(): Promise<void> {
    for (const agent of this.agents.values()) {
      await agent.initialize();
    }
  }
}