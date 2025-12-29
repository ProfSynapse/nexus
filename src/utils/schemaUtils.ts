import type { CommonResult } from '../types';
import { enhanceSchemaDocumentation } from './validationUtils';

/**
 * Utility functions for handling JSON schemas in a DRY way
 */

/**
 * Get schema for workspace context parameters
 * @returns JSON schema for workspace context
 */
export function getWorkspaceContextSchema(): any {
  return enhanceSchemaDocumentation({
    workspaceContext: {
      oneOf: [
        {
          type: 'object',
          properties: {
            workspaceId: { 
              type: 'string',
              description: 'Workspace identifier (optional - uses default workspace if not provided)' 
            },
            workspacePath: { 
              type: 'array', 
              items: { type: 'string' },
              description: 'Path from root workspace to specific phase/task'
            },
            contextDepth: {
              type: 'string',
              enum: ['minimal', 'standard', 'comprehensive'],
              description: 'Level of context to include in results'
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
  });
}

/**
 * Get schema for a single mode call
 * @returns JSON schema for a mode call
 */
export function getModeCallSchema(): any {
  return enhanceSchemaDocumentation({
    type: 'object',
    properties: {
      tool: { 
        type: 'string',
        description: 'Agent name to execute mode on' 
      },
      mode: { 
        type: 'string',
        description: 'Mode to execute' 
      },
      parameters: { 
        type: 'object',
        description: 'Parameters to pass to the mode'
      },
      returnHere: { 
        type: 'boolean',
        description: 'Whether to return results to original agent'
      },
      continueOnFailure: {
        type: 'boolean',
        description: 'Whether to continue execution if this mode fails'
      },
      strategy: {
        type: 'string',
        enum: ['serial', 'parallel'],
        description: 'Execution strategy for this mode call'
      },
      callName: {
        type: 'string',
        description: 'Optional name to identify this mode call in the results'
      }
    },
    required: ['tool', 'mode', 'parameters'],
    description: 'Mode call definition'
  });
}


/**
 * Get schema for session parameters (now part of context - kept for backward compatibility)
 * @returns Empty schema since session fields are now in context
 */
export function getSessionSchema(): any {
  return {};
}

/**
 * Get schema for context parameter - NEW ToolContext format
 * Uses memory → goal → constraints flow (1-3 sentences each)
 *
 * Note: When tools are accessed via toolManager_useTool, context is injected automatically.
 * This schema is used for direct tool access (backward compatibility).
 *
 * @returns JSON schema for context
 */
export function getContextSchema(): any {
  return enhanceSchemaDocumentation({
    context: {
      type: 'object',
      properties: {
        workspaceId: {
          type: 'string',
          description: 'Workspace scope identifier'
        },
        sessionId: {
          type: 'string',
          description: 'Session identifier for tracking'
        },
        memory: {
          type: 'string',
          description: 'Essence of conversation so far (1-3 sentences)'
        },
        goal: {
          type: 'string',
          description: 'Current objective (1-3 sentences)'
        },
        constraints: {
          type: 'string',
          description: 'Rules/limits to follow (1-3 sentences, optional)'
        }
      },
      required: ['workspaceId', 'sessionId', 'memory', 'goal'],
      description: 'Context for this tool call. Use toolManager_useTool for automatic context handling.'
    }
  });
}

export function getCommonParameterSchema(): any {
  return {
    ...getSessionSchema(),
    ...getWorkspaceContextSchema(),
    ...getContextSchema()
  };
}

/**
 * Get schema for common result
 * @returns JSON schema for common result
 */
export function getCommonResultSchema(): any {
  return enhanceSchemaDocumentation({
    type: 'object',
    properties: {
      success: {
        type: 'boolean',
        description: 'Whether the operation was successful'
      },
      error: {
        type: 'string',
        description: 'Error message if operation failed'
      },
      data: {
        type: 'object',
        description: 'Operation-specific result data'
      },
      context: {
        type: 'string',
        description: 'Background information and purpose for running this tool'
      },
      workspaceContext: {
        type: 'object',
        properties: {
          workspaceId: { 
            type: 'string',
            description: 'Workspace identifier'
          },
          workspacePath: { 
            type: 'array', 
            items: { type: 'string' },
            description: 'Path from root workspace to specific phase/task'
          },
          sessionId: {
            type: 'string',
            description: 'Session identifier used for this operation'
          },
          activeWorkspace: { 
            type: 'boolean',
            description: 'Whether this workspace is currently active'
          },
          contextDepth: {
            type: 'string',
            enum: ['minimal', 'standard', 'comprehensive'],
            description: 'Level of context included in results'
          }
        },
        description: 'Workspace context that was used'
      },
      sessionId: {
        type: 'string',
        description: 'Session identifier used for tracking tool calls'
      }
    },
    required: ['success', 'sessionId']
  });
}

/**
 * Merge custom parameter schema with common parameter schema
 * @param customSchema The mode-specific schema
 * @returns Merged schema with common parameters
 */
export function mergeWithCommonSchema(customSchema: any): any {
  const commonSchema = getCommonParameterSchema();
  
  // Merge properties without duplication
  const mergedProperties = {
    ...customSchema.properties,
    ...commonSchema
  };
  
  // Merge required arrays without duplicates
  const customRequired = customSchema.required || [];
  const commonRequired = ['sessionId', 'context'];
  const mergedRequired = Array.from(new Set([...customRequired, ...commonRequired]));
  
  return {
    type: 'object',
    properties: mergedProperties,
    required: mergedRequired
  };
}

/**
 * Create a standardized result object
 * @param success Whether the operation was successful
 * @param data Operation-specific data
 * @param error Error message if operation failed
 * @param workspaceContext Workspace context used
 * @param sessionId Session identifier
 * @param context Contextual information (rich object or string for backward compatibility)
 * @param additionalProps Additional properties to include in the result
 * @returns Standardized result object
 */
export function createResult<T extends CommonResult>(
  success: boolean,
  data?: any,
  error?: string,
  workspaceContext?: CommonResult['workspaceContext'],
  sessionId?: string,
  context?: CommonResult['context'] | string,
  additionalProps?: Record<string, unknown>
): T {
  const result: any = {
    success,
    ...(data !== undefined && { data }),
    ...(error !== undefined && { error }),
    ...(workspaceContext !== undefined && { workspaceContext }),
    ...(sessionId !== undefined && { sessionId }),
    ...(context !== undefined && { context })
  };
  
  // Add any additional properties
  if (additionalProps) {
    Object.assign(result, additionalProps);
  }
  
  return result as T;
}