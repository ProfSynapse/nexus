/**
 * ExecuteSchemaBuilder - Handles single prompt execution schemas
 * Location: /src/utils/schemas/builders/ExecuteSchemaBuilder.ts
 *
 * This builder handles schema generation for single LLM prompt execution
 * with support for custom agents, file context, model parameters, and actions.
 *
 * Used by: AgentManager execute mode for MCP tool definitions
 */

import { ISchemaBuilder, SchemaContext } from '../SchemaTypes';
import { LLMProviderManager } from '../../../services/llm/providers/ProviderManager';
import { mergeWithCommonSchema } from '../../schemaUtils';
import { SchemaBuilder } from '../SchemaBuilder';
import type { JSONSchema } from '../../../types/schema/JSONSchemaTypes';

function toJSONSchema(value: unknown): JSONSchema | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  return value as JSONSchema;
}

/**
 * Execute Schema Builder - Handles single prompt execution schemas
 */
export class ExecuteSchemaBuilder implements ISchemaBuilder {
  constructor(private providerManager: LLMProviderManager | null) {}

  buildParameterSchema(_context: SchemaContext): JSONSchema {
    const builder = new SchemaBuilder(this.providerManager);
    const commonProps = builder.buildCommonProperties({
      includeProviders: true,
      includeActions: true
    });

    const executeSchema = {
      properties: {
        agent: {
          type: 'string',
          description: 'Custom prompt agent name/id to use as system prompt (optional - if not provided, uses raw prompt only)'
        },
        filepaths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional array of file paths to include content as context'
        },
        prompt: {
          type: 'string',
          description: 'User prompt/question to send to the LLM'
        },
        ...(commonProps.provider ? { provider: toJSONSchema(commonProps.provider) } : {}),
        ...(commonProps.model ? { model: toJSONSchema(commonProps.model) } : {}),
        temperature: {
          type: 'number',
          minimum: 0,
          maximum: 1,
          description: 'Temperature setting for response randomness (0.0-1.0)'
        },
        maxTokens: {
          type: 'number',
          description: 'Maximum tokens to generate'
        },
        ...(commonProps.action ? { action: toJSONSchema(commonProps.action) } : {})
      },
      required: ['prompt']
    };

    return mergeWithCommonSchema(executeSchema) as JSONSchema;
  }

  buildResultSchema(_context: SchemaContext): JSONSchema {
    return {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        error: { type: 'string' },
        data: {
          type: 'object',
          properties: {
            response: { type: 'string' },
            model: { type: 'string' },
            provider: { type: 'string' },
            agentUsed: { type: 'string' },
            usage: {
              type: 'object',
              properties: {
                promptTokens: { type: 'number' },
                completionTokens: { type: 'number' },
                totalTokens: { type: 'number' }
              },
              required: ['promptTokens', 'completionTokens', 'totalTokens']
            },
            cost: {
              type: 'object',
              properties: {
                inputCost: { type: 'number' },
                outputCost: { type: 'number' },
                totalCost: { type: 'number' },
                currency: { type: 'string' }
              },
              required: ['inputCost', 'outputCost', 'totalCost', 'currency']
            },
            filesIncluded: {
              type: 'array',
              items: { type: 'string' }
            },
            actionPerformed: {
              type: 'object',
              properties: {
                type: { type: 'string' },
                targetPath: { type: 'string' },
                success: { type: 'boolean' },
                error: { type: 'string' }
              },
              required: ['type', 'targetPath', 'success']
            }
          },
          required: ['response', 'model', 'provider', 'agentUsed']
        },
        sessionId: { type: 'string' },
        context: { type: 'string' }
      },
      required: ['success', 'sessionId']
    };
  }
}
