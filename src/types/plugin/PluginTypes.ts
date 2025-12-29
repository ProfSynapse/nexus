/**
 * Plugin Configuration Types
 * Extracted from types.ts for better organization
 */

import { CustomPromptsSettings } from '../mcp/CustomPromptTypes';
import { LLMProviderSettings } from '../llm/ProviderTypes';

// Forward declarations for service types to avoid circular imports
// Actual types are imported where needed
type MemoryServiceType = import('../../agents/memoryManager/services/MemoryService').MemoryService;
type WorkspaceServiceType = import('../../services/WorkspaceService').WorkspaceService;
type SessionServiceType = import('../../services/session/SessionService').SessionService;
type ConversationServiceType = import('../../services/ConversationService').ConversationService;
type CustomPromptStorageServiceType = import('../../agents/promptManager/services/CustomPromptStorageService').CustomPromptStorageService;

/**
 * Plugin services registry type
 * Provides typed access to plugin services
 */
export interface PluginServices {
  memoryService?: MemoryServiceType;
  workspaceService?: WorkspaceServiceType;
  sessionService?: SessionServiceType;
  conversationService?: ConversationServiceType;
  customPromptStorageService?: CustomPromptStorageServiceType;
  /** Allow additional services via index signature */
  [key: string]: unknown;
}

// Memory management settings
interface MemorySettings {
  // Workspace management interface
}

interface ProcessedFileState {
  filePath: string;
  lastModified: number;
  contentHash: string;
  processed: boolean;
}

/**
 * Processed files data structure for file state management
 * Stores file processing state to prevent re-processing on startup
 */
export interface ProcessedFilesData {
  version: string;
  lastUpdated: number;
  files: Record<string, ProcessedFileState>;
}

/**
 * Plugin settings interface
 * Includes vault access toggle and version tracking
 */
export interface MCPSettings {
  enabledVault: boolean;
  configFilePath?: string;
  memory?: MemorySettings;
  customPrompts?: CustomPromptsSettings;
  llmProviders?: LLMProviderSettings;
  // Default selections for chat
  defaultWorkspaceId?: string;
  defaultPromptId?: string;
  defaultContextNotes?: string[];
  // Update tracking
  lastUpdateVersion?: string;
  lastUpdateDate?: string;
  availableUpdateVersion?: string;
  lastUpdateCheckDate?: string;
  processedFiles?: ProcessedFilesData;
}