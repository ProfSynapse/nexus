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

export interface PromptInfo {
  id: string;
  name: string;
  description: string;
  prompt: string;
  isEnabled: boolean;
  createdAt?: number;
  updatedAt?: number;
}

export class PromptDiscoveryService {
  constructor(
    private customPromptStorageService: any
  ) {}

  /**
   * Get all available prompts
   * @param enabledOnly - If true, only return enabled prompts
   */
  async getAvailablePrompts(enabledOnly: boolean = false): Promise<PromptInfo[]> {
    try {
      // Get all prompts from storage
      const allPrompts = await this.customPromptStorageService.getAllPrompts();

      // Filter by enabled status if requested
      const prompts = enabledOnly
        ? allPrompts.filter((prompt: any) => prompt.isEnabled)
        : allPrompts;

      // Map to PromptInfo format
      return prompts.map((prompt: any) => this.mapToPromptInfo(prompt));
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
  private mapToPromptInfo(promptData: any): PromptInfo {
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
