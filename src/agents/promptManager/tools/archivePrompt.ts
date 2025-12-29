import { JSONSchema } from '../../../types/schema/JSONSchemaTypes';
import { BaseTool } from '../../baseTool';
import { ArchivePromptParams, ArchivePromptResult } from '../types';
import { CustomPromptStorageService } from '../services/CustomPromptStorageService';

/**
 * Tool for archiving a custom prompt
 *
 * Location: src/agents/promptManager/tools/archivePrompt.ts
 *
 * Functionality: Sets isEnabled flag to false on a prompt, making it disappear from
 * active listings while preserving its configuration for potential restoration.
 *
 * Relationships:
 * - Uses CustomPromptStorageService to update prompt enabled status
 * - Prompt can be restored via updatePrompt tool with isEnabled: true
 * - Integrates with listPrompts tool which filters archived prompts by default
 */
export class ArchivePromptTool extends BaseTool<ArchivePromptParams, ArchivePromptResult> {
  private storageService: CustomPromptStorageService;

  /**
   * Create a new ArchivePromptTool
   * @param storageService Custom prompt storage service
   */
  constructor(storageService: CustomPromptStorageService) {
    super(
      'archivePrompt',
      'Archive Prompt',
      'Archive a custom prompt by disabling it (preserves configuration for restoration)',
      '1.0.0'
    );

    this.storageService = storageService;
  }

  /**
   * Execute the tool
   * @param params Tool parameters
   * @returns Promise that resolves with archive result
   */
  async execute(params: ArchivePromptParams): Promise<ArchivePromptResult> {
    try {
      const { name } = params;

      // Validate required name
      if (!name?.trim()) {
        return this.prepareResult(false, undefined, 'Prompt name is required');
      }

      // Check if prompt exists (unified lookup by ID or name)
      const existingPrompt = this.storageService.getPromptByNameOrId(name.trim());
      if (!existingPrompt) {
        return this.prepareResult(false, undefined, `Prompt "${name}" not found. Use listPrompts to see available prompts.`);
      }

      // Archive the prompt by setting isEnabled to false
      await this.storageService.updatePrompt(existingPrompt.id, { isEnabled: false });

      // Success - LLM already knows what it archived
      return this.prepareResult(true);
    } catch (error) {
      return this.prepareResult(false, undefined, `Failed to archive prompt: ${error}`);
    }
  }

  /**
   * Get the JSON schema for the tool's parameters
   * @returns JSON schema object
   */
  getParameterSchema(): JSONSchema {
    const toolSchema = {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Name or ID of the prompt to archive. Prompt will be disabled but configuration preserved for restoration via updatePrompt.',
          minLength: 1
        }
      },
      required: ['name']
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
