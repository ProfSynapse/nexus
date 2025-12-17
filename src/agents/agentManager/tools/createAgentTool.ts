import { BaseTool } from '../../baseTool';
import { CreateAgentParams, CreateAgentResult } from '../types';
import { CustomPromptStorageService } from '../services/CustomPromptStorageService';
import { getCommonResultSchema, createResult } from '../../../utils/schemaUtils';
import { addRecommendations } from '../../../utils/recommendationUtils';
import { NudgeHelpers } from '../../../utils/nudgeHelpers';

/**
 * Tool for creating a new custom agent
 */
export class CreateAgentTool extends BaseTool<CreateAgentParams, CreateAgentResult> {
  private storageService: CustomPromptStorageService;

  /**
   * Create a new CreateAgentTool
   * @param storageService Custom prompt storage service
   */
  constructor(storageService: CustomPromptStorageService) {
    super(
      'createAgent',
      'Create Agent',
      'Create a new custom agent',
      '1.0.0'
    );
    
    this.storageService = storageService;
  }
  
  /**
   * Execute the tool
   * @param params Tool parameters
   * @returns Promise that resolves with the created prompt
   */
  async execute(params: CreateAgentParams): Promise<CreateAgentResult> {
    try {
      const { name, description, prompt, isEnabled = true } = params;
      
      // Validate required fields
      if (!name?.trim()) {
        return createResult<CreateAgentResult>(false, null, 'Name is required');
      }
      
      if (!description?.trim()) {
        return createResult<CreateAgentResult>(false, null, 'Description is required');
      }
      
      if (!prompt?.trim()) {
        return createResult<CreateAgentResult>(false, null, 'Agent prompt text is required');
      }
      
      // Create the prompt
      const newPrompt = await this.storageService.createPrompt({
        name: name.trim(),
        description: description.trim(),
        prompt: prompt.trim(),
        isEnabled
      });
      
      const result = createResult<CreateAgentResult>(true, newPrompt, undefined);
      const nudges = [
        NudgeHelpers.suggestWorkspaceIntegration(),
        NudgeHelpers.suggestAgentTesting()
      ];
      return addRecommendations(result, nudges);
    } catch (error) {
      return createResult<CreateAgentResult>(false, null, `Failed to create agent: ${error}`);
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
        name: {
          type: 'string',
          description: 'Name of the agent (must be unique)',
          minLength: 1,
          maxLength: 100
        },
        description: {
          type: 'string',
          description: 'Description of what this agent does',
          minLength: 1,
          maxLength: 500
        },
        prompt: {
          type: 'string',
          description: 'The actual agent prompt text/persona',
          minLength: 1
        },
        isEnabled: {
          type: 'boolean',
          description: 'Whether the agent is enabled',
          default: true
        }
      },
      required: ['name', 'description', 'prompt']
    };

    return this.getMergedSchema(toolSchema);
  }

  /**
   * Get the JSON schema for the tool's result
   * @returns JSON schema object
   */
  getResultSchema(): any {
    const commonSchema = getCommonResultSchema();

    // Override the data property to define the specific structure for this tool
    return {
      ...commonSchema,
      properties: {
        ...commonSchema.properties,
        data: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            description: { type: 'string' },
            prompt: { type: 'string' },
            isEnabled: { type: 'boolean' }
          },
          required: ['id', 'name', 'description', 'prompt', 'isEnabled']
        },
        recommendations: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string' },
              message: { type: 'string' }
            },
            required: ['type', 'message']
          },
          description: 'Workspace-agent optimization recommendations'
        }
      }
    };
  }
}