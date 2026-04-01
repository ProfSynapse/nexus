/**
 * ContentBatchSchemaBuilder - Handles batch content operations schemas
 * Location: /src/utils/schemas/builders/ContentBatchSchemaBuilder.ts
 *
 * This builder handles schema generation for batch content operations including
 * read, create, append, prepend, replace, delete, and findReplace operations.
 *
 * Used by: ContentManager batch mode for MCP tool definitions
 */

import { ISchemaBuilder, SchemaContext } from '../SchemaTypes';
import type { ValidationSchema } from '../../validationUtils';

/**
 * Content Batch Schema Builder - Handles batch content operations
 */
export class ContentBatchSchemaBuilder implements ISchemaBuilder {
  buildParameterSchema(_context: SchemaContext): ValidationSchema {
    return {
      type: 'object',
      properties: {
        operations: {
          type: 'array',
          description: 'Array of operations to perform',
          items: {
            type: 'object',
            properties: {
              type: {
                type: 'string',
                enum: ['read', 'create', 'append', 'prepend', 'replace', 'replaceByLine', 'delete', 'findReplace'],
                description: 'Type of operation'
              },
              params: {
                type: 'object',
                description: 'Operation-specific parameters. IMPORTANT: All operations require a "filePath" parameter.'
              }
            },
            required: ['type', 'params']
          }
        },
        workspaceContext: {
          type: 'object',
          description: 'Workspace context for the operation'
        },
        sessionId: {
          type: 'string',
          description: 'Session identifier for tracking'
        },
      },
      required: ['operations']
    } satisfies ValidationSchema;
  }

  buildResultSchema(_context: SchemaContext): ValidationSchema {
    return {
      type: 'object',
      properties: {
        success: { type: 'boolean', description: 'Whether the operation succeeded' },
        error: { type: 'string', description: 'Error message if success is false' },
        data: {
          type: 'object',
          properties: {
            results: {
              type: 'array',
              description: 'Array of operation results',
              items: {
                type: 'object',
                properties: {
                  success: { type: 'boolean', description: 'Whether the operation succeeded' },
                  error: { type: 'string', description: 'Error message if success is false' },
                  data: { type: 'object', description: 'Operation-specific result data' },
                  type: { type: 'string', description: 'Type of operation' },
                  filePath: { type: 'string', description: 'File path for the operation' }
                },
                required: ['success', 'type', 'filePath']
              }
            }
          },
          required: ['results']
        },
        workspaceContext: {
          type: 'object',
          properties: {
            workspaceId: { type: 'string', description: 'ID of the workspace' },
            workspacePath: {
              type: 'array',
              items: { type: 'string' },
              description: 'Path of the workspace'
            },
            activeWorkspace: { type: 'boolean', description: 'Whether this is the active workspace' }
          }
        },
      },
      required: ['success']
    } satisfies ValidationSchema;
  }
}
