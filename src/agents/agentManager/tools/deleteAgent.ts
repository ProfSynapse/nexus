import { BaseTool } from '../../baseTool';
import { DeleteAgentParams, DeleteAgentResult } from '../types';
import { CustomPromptStorageService } from '../services/CustomPromptStorageService';

/**
 * Tool for deleting a custom prompt
 */
export class DeleteAgentTool extends BaseTool<DeleteAgentParams, DeleteAgentResult> {
  private storageService: CustomPromptStorageService;

  /**
   * Create a new DeleteAgentTool
   * @param storageService Custom prompt storage service
   */
  constructor(storageService: CustomPromptStorageService) {
    super(
      'deleteAgent',
      'Delete Agent',
      'Delete a custom agent',
      '1.0.0'
    );
    
    this.storageService = storageService;
  }
  
  /**
   * Execute the tool
   * @param params Tool parameters
   * @returns Promise that resolves with deletion result
   */
  async execute(params: DeleteAgentParams): Promise<DeleteAgentResult> {
    try {
      const { id } = params;

      // Validate required ID
      if (!id?.trim()) {
        return this.prepareResult(false, undefined, 'ID is required');
      }

      // Check if prompt exists before deletion (unified lookup by ID or name)
      const existingPrompt = this.storageService.getPromptByNameOrId(id.trim());
      if (!existingPrompt) {
        return this.prepareResult(false, undefined, `Agent "${id}" not found. Use listAgents to see available agents.`);
      }

      // Delete the prompt using actual ID
      await this.storageService.deletePrompt(existingPrompt.id);

      // Success - LLM already knows what it deleted
      return this.prepareResult(true);
    } catch (error) {
      return this.prepareResult(false, undefined, `Failed to delete agent: ${error}`);
    }
  }
  
  /**
   * Get the JSON schema for the tool's parameters
   * @returns JSON schema object
   */
  getParameterSchema(): any {
    const toolSchema = {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'ID or name of the agent to delete. Accepts either the unique agent ID or the agent name.',
          minLength: 1
        }
      },
      required: ['id']
    };

    return this.getMergedSchema(toolSchema);
  }

  getResultSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        success: { type: 'boolean', description: 'Whether the operation succeeded' },
        error: { type: 'string', description: 'Error message if failed (includes recovery guidance)' }
      },
      required: ['success']
    };
  }
}