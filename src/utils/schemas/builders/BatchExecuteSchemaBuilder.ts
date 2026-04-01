/**
 * BatchExecuteSchemaBuilder - Handles complex batch LLM execution schemas
 * Location: /src/utils/schemas/builders/BatchExecuteSchemaBuilder.ts
 *
 * This builder handles schema generation for batch execution of multiple LLM prompts
 * with support for sequences, parallel groups, context passing, and actions.
 *
 * Used by: AgentManager batch execution mode for MCP tool definitions
 */

import { ISchemaBuilder, SchemaContext } from '../SchemaTypes';
import { LLMProviderManager } from '../../../services/llm/providers/ProviderManager';
import { mergeWithCommonSchema } from '../../schemaUtils';
import { SchemaBuilder } from '../SchemaBuilder';
import type { ValidationSchema } from '../../validationUtils';

/**
 * Batch Execute Schema Builder - Handles complex batch LLM execution schemas
 */
export class BatchExecuteSchemaBuilder implements ISchemaBuilder {
  constructor(private providerManager: LLMProviderManager | null) {}

  buildParameterSchema(_context: SchemaContext): ValidationSchema {
    const builder = new SchemaBuilder(this.providerManager);
    const commonProps = builder.buildCommonProperties({
      includeProviders: true,
      includeActions: true
    });
    const providerSchema = commonProps.provider as ValidationSchema;
    const modelSchema = commonProps.model as ValidationSchema;
    const actionSchema = commonProps.action as ValidationSchema;

    const batchSchema = {
      type: 'object',
      title: 'Batch Execute LLM Prompts Parameters',
      description: 'Execute multiple LLM prompts concurrently across different providers with context support.',
      properties: {
        prompts: {
          type: 'array',
          description: 'Array of prompts to execute concurrently',
          items: {
            type: 'object',
            title: 'Individual Prompt Configuration',
            description: 'Configuration for a single LLM prompt execution',
            properties: {
              prompt: {
                type: 'string',
                description: 'The prompt text to send to the LLM',
                examples: [
                  'Summarize this document',
                  'Generate unit tests for this code',
                  'Explain this concept in simple terms'
                ]
              },
              provider: providerSchema,
              model: modelSchema,
              contextFiles: {
                type: 'array',
                description: 'Optional context files to include with this prompt',
                items: { type: 'string' }
              },
              workspace: {
                type: 'string',
                description: 'Optional workspace for context'
              },
              id: {
                type: 'string',
                description: 'Custom identifier for this prompt'
              },
              sequence: {
                type: 'number',
                description: 'Sequence number for ordered execution. Prompts with same sequence run in parallel, sequences execute in numerical order (0, 1, 2, etc.). If not specified, defaults to 0.',
                minimum: 0,
                examples: [0, 1, 2, 3]
              },
              parallelGroup: {
                type: 'string',
                description: 'Parallel group within sequence - prompts with same parallelGroup run together, different groups run sequentially within the sequence',
                examples: ['groupA', 'groupB', 'preprocessing', 'analysis']
              },
              includePreviousResults: {
                type: 'boolean',
                description: 'Whether to include previous sequence results as context for this prompt. Only applies when sequence > 0.',
                default: false
              },
              contextFromSteps: {
                type: 'array',
                description: 'Specific IDs of previous steps to include as context (if not specified, includes all previous results when includePreviousResults is true)',
                items: { type: 'string' }
              },
              action: actionSchema,
              agent: {
                type: 'string',
                description: 'Optional custom agent/prompt to use for this prompt'
              }
            },
            required: ['prompt']
          },
          minItems: 1,
          maxItems: 100
        },
        mergeResponses: {
          type: 'boolean',
          description: 'Whether to merge all responses into a single result (default: false)',
          default: false
        }
      },
      required: ['prompts'],
      additionalProperties: false
    } satisfies ValidationSchema;

    return mergeWithCommonSchema(batchSchema);
  }

  buildResultSchema(_context: SchemaContext): ValidationSchema {
    return {
      type: 'object',
      properties: {
        success: {
          type: 'boolean',
          description: 'Whether the batch execution was successful'
        },
        results: {
          type: 'array',
          description: 'Individual prompt results (if mergeResponses is false)',
          items: this.buildPromptResultSchema()
        },
        merged: {
          type: 'object',
          description: 'Merged response (if mergeResponses is true)',
          properties: {
            totalPrompts: {
              type: 'number',
              description: 'Total number of prompts executed'
            },
            successfulPrompts: {
              type: 'number',
              description: 'Number of prompts that succeeded'
            },
            combinedResponse: {
              type: 'string',
              description: 'All responses combined into a single string'
            },
            providersUsed: {
              type: 'array',
              description: 'List of providers that were used',
              items: { type: 'string' }
            }
          }
        },
        stats: {
          type: 'object',
          description: 'Execution statistics',
          properties: {
            totalExecutionTimeMS: {
              type: 'number',
              description: 'Total execution time in milliseconds'
            },
            promptsExecuted: {
              type: 'number',
              description: 'Number of prompts executed'
            },
            promptsFailed: {
              type: 'number',
              description: 'Number of prompts that failed'
            },
            avgExecutionTimeMS: {
              type: 'number',
              description: 'Average execution time per prompt'
            },
            tokensUsed: {
              type: 'number',
              description: 'Total tokens used (if available)'
            }
          }
        },
        error: {
          type: 'string',
          description: 'Error message if batch execution failed'
        }
      },
      required: ['success'],
      additionalProperties: false
    } satisfies ValidationSchema;
  }

  private buildPromptResultSchema(): ValidationSchema {
    return {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Custom identifier for this prompt' },
        prompt: { type: 'string', description: 'The original prompt text' },
        success: { type: 'boolean', description: 'Whether this individual prompt succeeded' },
        response: { type: 'string', description: 'The LLM response (if successful)' },
        provider: { type: 'string', description: 'The provider that was used' },
        model: { type: 'string', description: 'The model that was used' },
        error: { type: 'string', description: 'Error message (if failed)' },
        executionTime: { type: 'number', description: 'Execution time in milliseconds' },
        sequence: { type: 'number', description: 'Sequence number this prompt was executed in' },
        parallelGroup: { type: 'string', description: 'Parallel group this prompt was executed in' },
        agent: { type: 'string', description: 'The custom agent that was used' },
        actionPerformed: {
          type: 'object',
          description: 'Details about any action performed with the response',
          properties: {
            type: { type: 'string', description: 'Type of action performed' },
            targetPath: { type: 'string', description: 'Target path for the action' },
            success: { type: 'boolean', description: 'Whether the action was successful' },
            error: { type: 'string', description: 'Error message if action failed' }
          }
        }
      }
    } satisfies ValidationSchema;
  }
}
