/**
 * Legacy Types File - Refactored for Modular Organization
 * 
 * This file now re-exports all types from the organized modular structure.
 * The original types.ts file has been broken down into domain-specific modules:
 * 
 * - src/types/llm/: LLM provider types
 * - src/types/mcp/: MCP protocol and agent types
 * - src/types/search/: Search and memory query types
 * - src/types/plugin/: Plugin configuration types
 * - src/types/common/: Shared/common types
 * 
 * This approach follows SOLID principles:
 * - Single Responsibility: Each module handles one domain
 * - Open/Closed: Easy to extend without modifying existing code
 * - Interface Segregation: Clients depend only on what they use
 * - Dependency Inversion: Modules depend on abstractions
 */

// Re-export all types from the modular structure for backward compatibility
// Import from specific modules to avoid circular dependency

// LLM-related types
export type {
  ModelConfig,
  LLMProviderConfig,
  DefaultModelSettings,
  LLMProviderSettings
} from './types/llm';

export {
  DEFAULT_LLM_PROVIDER_SETTINGS
} from './types/llm';

// Memory management settings
export interface MemorySettings {
  // Workspace management interface
}

export const DEFAULT_MEMORY_SETTINGS: MemorySettings = {
};

// MCP protocol types
export type {
  ModeCall,
  CommonParameters,
  CommonResult,
  ModeCallResult,
  CustomPrompt,
  CustomPromptsSettings,
  ServerStatus,
  IMCPServer,
  MutualTLSOptions,
  ServerState
} from './types/mcp';

export {
  DEFAULT_CUSTOM_PROMPTS_SETTINGS
} from './types/mcp';

// Search and memory types - simplified for JSON-based storage
export type {
  MemoryQueryParams,
  MemoryQueryResult
} from './types/search';

// Plugin configuration types
export type {
  MCPSettings
} from './types/plugin/PluginTypes';

// Common/shared types
export type {
  IVaultManager,
  NoteInfo,
  FolderInfo,
  WorkspaceSessionInfo,
  WorkspaceStateInfo
} from './types/common';

// Create default settings object
import { DEFAULT_CUSTOM_PROMPTS_SETTINGS } from './types/mcp';
import { DEFAULT_LLM_PROVIDER_SETTINGS } from './types/llm';
import { MCPSettings } from './types/plugin';
// DEFAULT_MEMORY_SETTINGS defined above in this file

/**
 * Default plugin settings
 */
export const DEFAULT_SETTINGS: MCPSettings = {
  enabledVault: true,
  enableEmbeddings: true, // Enable local embeddings by default (desktop only)
  configFilePath: undefined,
  memory: DEFAULT_MEMORY_SETTINGS,
  customPrompts: DEFAULT_CUSTOM_PROMPTS_SETTINGS,
  llmProviders: DEFAULT_LLM_PROVIDER_SETTINGS,
  lastUpdateVersion: undefined,
  lastUpdateDate: undefined,
  availableUpdateVersion: undefined,
  lastUpdateCheckDate: undefined
};

// Extend Obsidian App interface (module augmentation)
declare module 'obsidian' {
  interface App {
    commands: {
      listCommands(): Command[];
      executeCommandById(id: string): Promise<void>;
      commands: { [id: string]: Command };
    };
    plugins: {
      getPlugin(id: string): any;
      enablePlugin(id: string): Promise<void>;
      disablePlugin(id: string): Promise<void>;
      plugins: { [id: string]: any };
    };
  }
}