/**
 * Main types export barrel
 * Provides a clean interface for importing types throughout the application
 * Organized by domain for better maintainability
 */

// LLM-related types
export type {
  ModelConfig,
  LLMProviderConfig,
  DefaultModelSettings,
  LLMProviderSettings
} from './llm';

export {
  DEFAULT_LLM_PROVIDER_SETTINGS
} from './llm';

// Simple memory management now uses JSON-based storage
export interface MemorySettings {
  enabled: boolean;
  dataPath?: string;
}

export const DEFAULT_MEMORY_SETTINGS: MemorySettings = {
  enabled: true,
  dataPath: '.data'
};

// MCP protocol types
export {
  type ToolContext,
  type ModeCall,
  type CommonParameters,
  type CommonResult,
  type ModeCallResult,
  type CustomPrompt,
  type CustomPromptsSettings,
  type ServerStatus,
  type IMCPServer,
  type MutualTLSOptions,
  type ServerState
} from './mcp';

export {
  DEFAULT_CUSTOM_PROMPTS_SETTINGS
} from './mcp';

// Search and memory types - simplified for JSON-based storage
export type {
  MemoryQueryParams,
  MemoryQueryResult
} from './search';

// Plugin configuration types
export type {
  MCPSettings
} from './plugin';

// Common/shared types
export type {
  IVaultManager,
  NoteInfo,
  FolderInfo,
  WorkspaceSessionInfo,
  WorkspaceStateInfo
} from './common';

// Chat types
export type {
  ConversationData,
  ConversationMessage,
  ToolCall,
  ConversationDocument,
  ConversationSearchOptions,
  ConversationSearchResult,
  CreateConversationParams,
  AddMessageParams,
  UpdateConversationParams
} from './chat/ChatTypes';

// Pagination types
export type {
  PaginationParams,
  PaginatedResult
} from './pagination/PaginationTypes';

export {
  createEmptyPaginatedResult,
  calculatePaginationMetadata
} from './pagination/PaginationTypes';

// Storage types
export type {
  DeviceInfo,
  SyncState,
  WorkspaceMetadata,
  SessionMetadata,
  StateMetadata,
  StateData,
  ConversationMetadata,
  MessageData,
  MemoryTraceData,
  ExportFilter,
  ExportData,
  WorkspaceExportData,
  ConversationExportData,
  SearchResult,
  SyncResult,
  StorageEvent,
  StorageEventType
} from './storage/HybridStorageTypes';

// Create default settings object
import { DEFAULT_CUSTOM_PROMPTS_SETTINGS } from './mcp';
import { DEFAULT_LLM_PROVIDER_SETTINGS } from './llm';
import { MCPSettings } from './plugin';
// DEFAULT_MEMORY_SETTINGS defined above in this file

/**
 * Default plugin settings
 */
export const DEFAULT_SETTINGS: MCPSettings = {
  enabledVault: true,
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