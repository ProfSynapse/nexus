/**
 * Location: /src/config/agents.ts
 *
 * Unified configuration registry for all MCP agents. This file consolidates individual
 * agent configs into a single source of truth with type safety and centralized management.
 *
 * Used by: All agent implementations, MCP connector, agent registration, and agent discovery
 */

/**
 * Agent categories for logical grouping
 */
export const AGENT_CATEGORIES = {
  CONTENT_OPERATIONS: 'content-operations',
  FILE_SYSTEM: 'file-system',
  SEARCH_RETRIEVAL: 'search-retrieval',
  MEMORY_MANAGEMENT: 'memory-management',
  LLM_INTEGRATION: 'llm-integration',
  SYSTEM_COMMANDS: 'system-commands',
  TOOL_MANAGEMENT: 'tool-management'
} as const;

/**
 * Comprehensive agent registry with metadata, tools, and categorization
 */
export const AGENT_REGISTRY = {
  /**
   * Content Manager - CRUD operations on note content
   */
  contentManager: {
    name: 'contentManager',
    displayName: 'Content Manager',
    description: 'Content operations for Obsidian notes',
    version: '1.0.0',
    category: AGENT_CATEGORIES.CONTENT_OPERATIONS,
    tools: [
      'readContent',
      'createContent',
      'appendContent',
      'prependContent',
      'replaceContent',
      'replaceByLine',
      'deleteContent',
      'findReplaceContent',
      'batchContent'
    ] as const,
    capabilities: ['create', 'read', 'update', 'delete', 'batch'] as string[],
    requiresVault: true,
  },

  /**
   * Vault Manager - File system operations for Obsidian vault
   */
  vaultManager: {
    name: 'vaultManager',
    displayName: 'Vault Manager',
    description: 'File system operations for Obsidian vault',
    version: '1.0.0',
    category: AGENT_CATEGORIES.FILE_SYSTEM,
    tools: [
      'listDirectory',
      'createFolder',
      'editFolder',
      'deleteFolder',
      'deleteNote',
      'moveNote',
      'moveFolder',
      'duplicateNote',
      'openNote'
    ] as const,
    capabilities: ['create', 'read', 'update', 'delete', 'move', 'duplicate'] as string[],
    requiresVault: true,
  },

  /**
   * Vault Librarian - Search operations for Obsidian vault
   */
  vaultLibrarian: {
    name: 'vaultLibrarian',
    displayName: 'Vault Librarian',
    description: 'Search operations for Obsidian vault',
    version: '1.0.0',
    category: AGENT_CATEGORIES.SEARCH_RETRIEVAL,
    tools: [
      'search',
      'searchDirectory',
      'searchWorkspace',
      'searchMemory',
      'batch'
    ] as const,
    capabilities: ['search', 'text-search', 'batch'] as string[],
    requiresVault: true,
  },

  /**
   * Memory Manager - Manages workspaces, memory sessions, and states
   */
  memoryManager: {
    name: 'memoryManager',
    displayName: 'Memory Manager',
    description: 'Manages workspaces, memory sessions, and states for contextual recall',
    version: '1.2.0',
    category: AGENT_CATEGORIES.MEMORY_MANAGEMENT,
    tools: [
      // Session tools
      'createSession',
      'listSessions',
      'editSession',
      'deleteSession',
      'loadSession',
      // State tools
      'createState',
      'listStates',
      'loadState',
      'editState',
      'deleteState',
      // Workspace tools
      'addFilesToWorkspace',
      'createWorkspace',
      'deleteWorkspace',
      'editWorkspace',
      'listWorkspaces',
      'loadWorkspace',
      'manageAssociatedNotes'
    ] as const,
    capabilities: ['session-management', 'state-management', 'workspace-management', 'contextual-recall'] as string[],
    requiresVault: true,
  },

  /**
   * Agent Manager - LLM integration and custom AI agent execution
   */
  agentManager: {
    name: 'agentManager',
    displayName: 'Agent Manager',
    description: 'Manage custom prompt agents for personalized AI interactions',
    version: '1.0.0',
    category: AGENT_CATEGORIES.LLM_INTEGRATION,
    tools: [
      // Prompt management
      'listPrompts',
      'getPrompt',
      'createPrompt',
      'updatePrompt',
      'deletePrompt',
      'togglePrompt',
      // LLM execution
      'listModels',
      'executePrompt',
      'batchExecutePrompt'
    ] as const,
    capabilities: ['prompt-management', 'llm-execution', 'model-selection', 'batch-execution'] as string[],
    requiresVault: false,
  },

  /**
   * Command Manager - Command palette operations for Obsidian
   */
  commandManager: {
    name: 'commandManager',
    displayName: 'Command Manager',
    description: 'Command palette operations for Obsidian',
    version: '1.0.0',
    category: AGENT_CATEGORIES.SYSTEM_COMMANDS,
    tools: [
      'listCommands',
      'executeCommand'
    ] as const,
    capabilities: ['command-execution', 'system-integration'] as string[],
    requiresVault: true,
  },

  /**
   * Tool Manager - Unified tool discovery and execution
   * Provides the two-tool architecture: getTools + useTool
   */
  toolManager: {
    name: 'toolManager',
    displayName: 'Tool Manager',
    description: 'Discover and execute tools across all agents with unified context',
    version: '1.0.0',
    category: AGENT_CATEGORIES.TOOL_MANAGEMENT,
    tools: [
      'getTools',
      'useTool'
    ] as const,
    capabilities: ['tool-discovery', 'tool-execution', 'context-management'] as string[],
    requiresVault: false,
  }
} as const;

/**
 * Type definitions for type-safe agent references
 */
export type AgentCategory = typeof AGENT_CATEGORIES[keyof typeof AGENT_CATEGORIES];
export type AgentName = keyof typeof AGENT_REGISTRY;
export type AgentConfig = typeof AGENT_REGISTRY[AgentName];

/**
 * Type for agent tool references
 */
export type AgentTools<T extends AgentName> = typeof AGENT_REGISTRY[T]['tools'][number];

/**
 * Utility functions for agent registry operations
 */
export class AgentRegistryUtils {
  /**
   * Get agent configuration by name
   */
  static getAgent(name: AgentName): AgentConfig {
    return AGENT_REGISTRY[name];
  }

  /**
   * Get all agents in a specific category
   */
  static getAgentsByCategory(category: AgentCategory): AgentConfig[] {
    return Object.values(AGENT_REGISTRY).filter(agent => agent.category === category);
  }

  /**
   * Get all agent names
   */
  static getAllAgentNames(): AgentName[] {
    return Object.keys(AGENT_REGISTRY) as AgentName[];
  }

  /**
   * Check if an agent supports a specific tool
   */
  static hasTool(agentName: AgentName, tool: string): boolean {
    return (AGENT_REGISTRY[agentName].tools as readonly string[]).includes(tool);
  }

  /**
   * Get agents that support a specific capability
   */
  static getAgentsByCapability(capability: string): AgentConfig[] {
    return Object.values(AGENT_REGISTRY).filter(agent =>
      agent.capabilities.includes(capability)
    );
  }


  /**
   * Validate agent and tool combination
   */
  static validateAgentTool(agentName: string, tool: string): boolean {
    if (!(agentName in AGENT_REGISTRY)) {
      return false;
    }
    return this.hasTool(agentName as AgentName, tool);
  }

  /**
   * Get formatted agent information for display
   */
  static getAgentInfo(name: AgentName): {
    name: string;
    displayName: string;
    description: string;
    version: string;
    category: string;
    toolCount: number;
    capabilities: string[];
  } {
    const agent = AGENT_REGISTRY[name];
    return {
      name: agent.name,
      displayName: agent.displayName,
      description: agent.description,
      version: agent.version,
      category: agent.category,
      toolCount: agent.tools.length,
      capabilities: agent.capabilities
    };
  }
}

/**
 * Legacy compatibility - export individual configs for backward compatibility
 * during transition period. These should be removed after all consumers are updated.
 * 
 * @deprecated Use AGENT_REGISTRY instead
 */
export const AgentManagerConfig = {
  name: AGENT_REGISTRY.agentManager.name,
  description: AGENT_REGISTRY.agentManager.description,
  version: AGENT_REGISTRY.agentManager.version
};

export const ContentManagerConfig = {
  name: AGENT_REGISTRY.contentManager.name,
  description: AGENT_REGISTRY.contentManager.description,
  version: AGENT_REGISTRY.contentManager.version
};

export const VaultLibrarianConfig = {
  name: AGENT_REGISTRY.vaultLibrarian.name,
  description: AGENT_REGISTRY.vaultLibrarian.description,
  version: AGENT_REGISTRY.vaultLibrarian.version
};

export const VaultManagerConfig = {
  name: AGENT_REGISTRY.vaultManager.name,
  description: AGENT_REGISTRY.vaultManager.description,
  version: AGENT_REGISTRY.vaultManager.version
};

export const MemoryManagerConfig = {
  name: AGENT_REGISTRY.memoryManager.name,
  description: AGENT_REGISTRY.memoryManager.description,
  version: AGENT_REGISTRY.memoryManager.version
};

export const CommandManagerConfig = {
  name: AGENT_REGISTRY.commandManager.name,
  description: AGENT_REGISTRY.commandManager.description,
  version: AGENT_REGISTRY.commandManager.version
};

export const ToolManagerConfig = {
  name: AGENT_REGISTRY.toolManager.name,
  description: AGENT_REGISTRY.toolManager.description,
  version: AGENT_REGISTRY.toolManager.version
};