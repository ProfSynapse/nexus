/**
 * Custom Prompt Types
 * Extracted from types.ts for better organization
 */

/**
 * Custom prompt definition for MCP
 */
export interface CustomPrompt {
  id: string;
  name: string;
  description: string;
  prompt: string;
  isEnabled: boolean;
}

/**
 * Custom prompts settings
 */
export interface CustomPromptsSettings {
  enabled: boolean;
  prompts: CustomPrompt[];
}

/**
 * Default custom prompts settings
 */
export const DEFAULT_CUSTOM_PROMPTS_SETTINGS: CustomPromptsSettings = {
  enabled: true,
  prompts: []
};