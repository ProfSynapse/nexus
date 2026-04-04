/**
 * SessionSchemaBuilder - Handles session creation schemas
 * Location: /src/utils/schemas/builders/SessionSchemaBuilder.ts
 *
 * This builder handles schema generation for session creation with support for
 * context tracing, workspace context, tags, and memory continuity.
 *
 * Used by: MemoryManager session creation mode for MCP tool definitions
 */

import { ISchemaBuilder, SchemaContext } from '../SchemaTypes';
import type { ValidationSchema } from '../../validationUtils';

/**
 * Session Schema Builder - Handles session creation schemas
 */
export class SessionSchemaBuilder implements ISchemaBuilder {
  buildParameterSchema(_context: SchemaContext): ValidationSchema {
    return {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Name for the session' },
        description: { type: 'string', description: 'Description of the session purpose' },
        context: {
          type: 'string',
          description: 'Purpose or goal of this session - IMPORTANT: This will be stored with the session and used in memory operations',
          minLength: 1
        },
        generateContextTrace: {
          type: 'boolean',
          description: 'Whether to generate an initial memory trace with session context',
          default: true
        },
        sessionGoal: { type: 'string', description: 'The goal or purpose of this session (for memory context)' },
        previousSessionId: { type: 'string', description: 'Reference to previous session ID to establish continuity' },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Tags to associate with this session'
        },
        contextDepth: {
          type: 'string',
          enum: ['minimal', 'standard', 'comprehensive'],
          description: 'How much context to include in the initial memory trace',
          default: 'standard'
        },
        workspaceContext: {
          oneOf: [
            {
              type: 'object',
              properties: {
                workspaceId: { type: 'string', description: 'Workspace identifier (optional - uses default workspace if not provided)' },
                workspacePath: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Path from root workspace to specific phase/task'
                }
              },
              description: 'Optional workspace context object - if not provided, uses a default workspace'
            },
            {
              type: 'string',
              description: 'Optional workspace context as JSON string - must contain workspaceId field'
            }
          ],
          description: 'Optional workspace context - if not provided, uses a default workspace'
        }
      }
    } satisfies ValidationSchema;
  }

  buildResultSchema(_context: SchemaContext): ValidationSchema {
    return {
      type: 'object',
      properties: {
        success: { type: 'boolean', description: 'Whether the operation was successful' },
        data: {
          type: 'object',
          properties: {
            sessionId: { type: 'string', description: 'ID of the created session' },
            name: { type: 'string', description: 'Name of the created session' },
            workspaceId: { type: 'string', description: 'ID of the workspace' },
            startTime: { type: 'number', description: 'Session start timestamp' },
            previousSessionId: { type: 'string', description: 'ID of the previous session (if continuing)' },
            purpose: { type: 'string', description: 'The purpose of this session extracted from context parameter' },
            context: { type: 'string', description: 'Contextual information about the operation (from CommonResult)' },
            memoryContext: {
              type: 'object',
              description: 'Detailed contextual information about the session',
              properties: {
                summary: { type: 'string', description: 'Summary of the workspace state at session start' },
                purpose: { type: 'string', description: 'The purpose or goal of this session derived from context parameter' },
                relevantFiles: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Key files relevant to this session'
                },
                recentActivities: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      timestamp: { type: 'number', description: 'When the activity occurred' },
                      description: { type: 'string', description: 'Description of the activity' },
                      type: { type: 'string', description: 'Type of activity' }
                    }
                  },
                  description: 'Recent activities in the workspace'
                },
                tags: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Tags describing this session'
                }
              },
              required: ['summary', 'tags']
            }
          },
          required: ['sessionId', 'workspaceId', 'startTime']
        },
        error: { type: 'string', description: 'Error message if operation failed' },
        context: { type: 'string', description: 'The purpose and context of this session creation' }
      },
      required: ['success']
    } satisfies ValidationSchema;
  }
}
