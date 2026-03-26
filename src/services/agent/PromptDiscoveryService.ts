/**
 * PromptDiscoveryService - Shared service for custom prompt discovery and querying
 *
 * Responsibilities:
 * - Load custom prompts from CustomPromptStorageService
 * - Filter prompts by enabled status
 * - Provide prompt lookup by ID
 * - Shared by ModelAgentManager (chat UI) and ListPromptsMode (MCP)
 *
 * Follows Single Responsibility Principle - only handles prompt discovery.
 */

import type { CustomPrompt } from '../../types/mcp/CustomPromptTypes';

export interface PromptInfo {
  id: string;
  name: string;
  description: string;
  prompt: string;
  isEnabled: boolean;
  createdAt?: number;
  updatedAt?: number;
}

interface StoredPrompt extends CustomPrompt {
  createdAt?: number;
  updatedAt?: number;
}

interface PromptStorageService {
  getAllPrompts(): StoredPrompt[];
}

export class PromptDiscoveryService {
  constructor(
    private customPromptStorageService: PromptStorageService
  ) {}

  /**
   * Get all available prompts
   * @param enabledOnly - If true, only return enabled prompts
   */
  async getAvailablePrompts(enabledOnly: boolean = false): Promise<PromptInfo[]> {
    try {
      // Get all prompts from storage
      const allPrompts = this.customPromptStorageService.getAllPrompts();

      // Filter by enabled status if requested
      const prompts = enabledOnly
        ? allPrompts.filter((prompt: StoredPrompt) => prompt.isEnabled)
        : allPrompts;

      // Map to PromptInfo format
      return prompts.map((prompt: StoredPrompt) => this.mapToPromptInfo(prompt));
    } catch (error) {
      console.error('[PromptDiscoveryService] Failed to get prompts:', error);
      return [];
    }
  }

  /**
   * Find a specific prompt by ID
   */
  async findPrompt(promptId: string): Promise<PromptInfo | null> {
    try {
      const allPrompts = await this.getAvailablePrompts(false);
      return allPrompts.find(prompt => prompt.id === promptId) || null;
    } catch (error) {
      console.error('[PromptDiscoveryService] Failed to find prompt:', error);
      return null;
    }
  }

  /**
   * Get enabled prompts only
   */
  async getEnabledPrompts(): Promise<PromptInfo[]> {
    return this.getAvailablePrompts(true);
  }

  /**
   * Map custom prompt to PromptInfo format
   */
  private mapToPromptInfo(promptData: StoredPrompt): PromptInfo {
    return {
      id: promptData.id,
      name: promptData.name,
      description: promptData.description || '',
      prompt: promptData.prompt || '',
      isEnabled: promptData.isEnabled !== false, // Default to true if not specified
      createdAt: promptData.createdAt,
      updatedAt: promptData.updatedAt
    };
  }
}
