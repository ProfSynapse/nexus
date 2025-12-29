import { JSONSchema } from '../../../types/schema/JSONSchemaTypes';
import { BaseTool } from '../../baseTool';
import { GetPromptParams, GetPromptResult } from '../types';
import { CustomPromptStorageService } from '../services/CustomPromptStorageService';
import { getCommonResultSchema, createResult } from '../../../utils/schemaUtils';

/**
 * Tool for getting a specific custom prompt for persona adoption
 */
export class GetPromptTool extends BaseTool<GetPromptParams, GetPromptResult> {
  private storageService: CustomPromptStorageService;

  /**
   * Create a new GetPromptTool
   * @param storageService Custom prompt storage service
   */
  constructor(storageService: CustomPromptStorageService) {
    super(
      'getPrompt',
      'Get Prompt',
      'Get a custom prompt for persona adoption - does NOT execute tasks automatically',
      '1.0.0'
    );

    this.storageService = storageService;
  }

  /**
   * Execute the tool
   * @param params Tool parameters
   * @returns Promise that resolves with the prompt data
   */
  async execute(params: GetPromptParams): Promise<GetPromptResult> {
    try {
      const { id, name } = params;

      // Must provide either id or name
      if (!id && !name) {
        return createResult<GetPromptResult>(false, null, 'Either id or name must be provided');
      }

      // Get prompt by id or name
      let prompt = null;
      if (id) {
        // Use unified lookup (tries ID first, then name)
        prompt = this.storageService.getPromptByNameOrId(id);
      } else if (name) {
        prompt = this.storageService.getPromptByNameOrId(name);
      }

      if (!prompt) {
        const identifier = id ? `ID "${id}"` : `name "${name}"`;
        return createResult<GetPromptResult>(false, null, `Prompt with ${identifier} not found. Use listPrompts to see available prompts.`);
      }

      // Create message with persona instruction and warning (prompt content is already in the prompt field)
      const message = `PROMPT PERSONA RETRIEVED: "${prompt.name}"

IMPORTANT EXECUTION BOUNDARY:
- This is PERSONA ADOPTION only - no tasks will be executed
- Do NOT automatically use executePrompts unless explicitly requested
- Do NOT run actions, create files, or modify content
- You may adopt this persona for conversation
- Ask permission before switching to execution mode

To execute tasks: User must explicitly request promptManager_executePrompts`;

      const resultWithMessage = {
        ...prompt,
        message: message
      };

      return createResult<GetPromptResult>(true, resultWithMessage, undefined);
    } catch (error) {
      return createResult<GetPromptResult>(false, null, `Failed to get prompt: ${error}`);
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
        id: {
          type: 'string',
          description: 'Unique ID or name of the prompt to retrieve for persona adoption (will try ID first, then name)'
        },
        name: {
          type: 'string',
          description: 'Name of the prompt to retrieve for persona adoption'
        }
      },
      required: [],
      anyOf: [
        { required: ['id'] },
        { required: ['name'] }
      ]
    };

    return this.getMergedSchema(toolSchema);
  }

  /**
   * Get the JSON schema for the tool's result
   * @returns JSON schema object
   */
  getResultSchema(): JSONSchema {
    const commonSchema = getCommonResultSchema();

    // Override the data property to define the specific structure for this tool
    return {
      ...commonSchema,
      properties: {
        ...commonSchema.properties,
        data: {
          oneOf: [
            { type: 'null' },
            {
              type: 'object',
              properties: {
                id: { type: 'string' },
                name: { type: 'string' },
                description: { type: 'string' },
                prompt: { type: 'string' },
                isEnabled: { type: 'boolean' },
                message: { type: 'string', description: 'Complete persona instructions and warning about execute mode usage' }
              },
              required: ['id', 'name', 'description', 'prompt', 'isEnabled', 'message']
            }
          ]
        }
      }
    };
  }
}
