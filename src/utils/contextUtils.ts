import { CommonParameters, CommonResult } from '../types';

/**
 * Interface for workspace context
 */
export interface WorkspaceContext {
  workspaceId: string;
  workspacePath?: string[];
  activeWorkspace?: boolean;
}

/**
 * Parse workspace context from parameters
 * @param workspaceContext String or object representation of workspace context  
 * @param fallbackId Optional fallback workspace ID if parsing fails
 * @param contextParam Optional context parameter containing workspaceId
 * @returns Parsed workspace context or null if not provided
 */
export function parseWorkspaceContext(
  workspaceContext: CommonParameters['workspaceContext'] | null | undefined,
  fallbackId = 'default-workspace',
  contextParam?: any
): WorkspaceContext | null {
  // First, try to get workspaceId from context parameter if available
  let workspaceId: string | undefined;

  if (contextParam?.workspaceId) {
    workspaceId = contextParam.workspaceId;
  }

  if (!workspaceContext) {
    // If no workspaceContext but we have workspaceId from context, create a minimal context
    if (workspaceId) {
      return {
        workspaceId: workspaceId,
        workspacePath: [],
        activeWorkspace: true
      };
    }
    return null;
  }

  let parsedContext: Partial<WorkspaceContext> = {};

  // Handle string vs object format
  if (typeof workspaceContext === 'string') {
    try {
      parsedContext = JSON.parse(workspaceContext);
    } catch (e) {
      return {
        workspaceId: workspaceId || fallbackId,
        workspacePath: [],
        activeWorkspace: true
      };
    }
  } else if (typeof workspaceContext === 'object' && workspaceContext !== null) {
    parsedContext = workspaceContext;
  }

  // Use workspaceId from context if available, otherwise from workspaceContext
  const finalWorkspaceId = workspaceId || parsedContext.workspaceId;

  if (!finalWorkspaceId) {
    return {
      workspaceId: fallbackId,
      workspacePath: [],
      activeWorkspace: true
    };
  }

  return {
    workspaceId: finalWorkspaceId,
    workspacePath: parsedContext.workspacePath || [],
    activeWorkspace: parsedContext.activeWorkspace !== undefined ? parsedContext.activeWorkspace : true
  };
}

/**
 * Serialize workspace context to a string (for storage or parameters)
 * @param context Workspace context object
 * @returns Serialized JSON string
 */
export function serializeWorkspaceContext(context: WorkspaceContext): string {
  return JSON.stringify(context);
}

/**
 * Merge workspace contexts from two different sources
 * Handles conflicts by prioritizing the context from the priority source
 * 
 * @param context1 First workspace context
 * @param context2 Second workspace context
 * @param priorityContext Which context to prioritize if both have the same workspace ID ('first' or 'second')
 * @returns Merged workspace context or null if contexts are from different workspaces
 */
export function mergeWorkspaceContexts(
  context1: WorkspaceContext | null | undefined,
  context2: WorkspaceContext | null | undefined,
  priorityContext: 'first' | 'second' = 'first'
): WorkspaceContext | null {
  // Handle null/undefined cases
  if (!context1 && !context2) {
    return null;
  }
  
  if (!context1) {
    return context2 || null;
  }
  
  if (!context2) {
    return context1;
  }
  
  // If the contexts are from different workspaces, return the priority one
  if (context1.workspaceId !== context2.workspaceId) {
    return priorityContext === 'first' ? context1 : context2;
  }
  
  // Same workspace, so merge them with priority
  const priority = priorityContext === 'first' ? context1 : context2;
  const secondary = priorityContext === 'first' ? context2 : context1;
  
  return {
    workspaceId: priority.workspaceId,
    // Combine paths if both have workspace paths (using priority's if only one has a path)
    workspacePath: priority.workspacePath || secondary.workspacePath || [],
    // Use priority's activeWorkspace flag if present
    activeWorkspace: priority.activeWorkspace !== undefined ? 
      priority.activeWorkspace : 
      secondary.activeWorkspace !== undefined ? 
        secondary.activeWorkspace : 
        true
  };
}

/**
 * Extract context information from parameters for use in prepareResult calls
 * This function handles both legacy string context and enhanced object context
 * @param params Parameters object that may contain context information
 * @returns Context suitable for prepareResult calls
 */
export function extractContextFromParams(params: any): CommonResult['context'] {
  if (params.context !== undefined) {
    return normalizeContextForResult(params.context);
  }
  return undefined;
}

/**
 * Normalize context for result output - handles both string and object formats
 * @param context Context in either string or enhanced object format
 * @returns Normalized context for result
 */
export function normalizeContextForResult(context: any): CommonResult['context'] {
  if (typeof context === 'string') {
    return context;
  } else if (typeof context === 'object' && context !== null) {
    // Return the enhanced context object as-is
    return context;
  }
  return undefined;
}