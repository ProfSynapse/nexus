/**
 * Plugin Configuration Types
 * Extracted from types.ts for better organization
 */

import { CustomPromptsSettings } from '../mcp/CustomPromptTypes';
import { LLMProviderSettings } from '../llm/ProviderTypes';

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
  defaultAgentId?: string;
  defaultContextNotes?: string[];
  // Update tracking
  lastUpdateVersion?: string;
  lastUpdateDate?: string;
  availableUpdateVersion?: string;
  lastUpdateCheckDate?: string;
  processedFiles?: ProcessedFilesData;
}