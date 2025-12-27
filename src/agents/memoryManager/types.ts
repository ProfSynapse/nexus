import { CommonResult, CommonParameters } from '../../types';
import { WorkspaceContext } from '../../utils/contextUtils';

/**
 * Base parameters for memory management operations
 */
export interface MemoryParams extends CommonParameters {
  /**
   * Optional context depth for memory operations
   * - minimal: Just basic information
   * - standard: Regular level of detail (default)
   * - comprehensive: Maximum detail and context
   */
  contextDepth?: 'minimal' | 'standard' | 'comprehensive';
}

/**
 * Base result for memory management operations
 */
export interface MemoryResult extends CommonResult {
  /**
   * Optional contextual information about the memory operation
   */
  memoryContext?: {
    /**
     * When the operation occurred
     */
    timestamp: number;
    
    /**
     * Tags associated with this memory operation
     */
    tags?: string[];
  };
}

/**
 * State-related parameter and result types
 *
 * Note: Sessions are now implicit (sessionId comes from context).
 * Session tools (createSession, listSessions, loadSession, updateSession) have been removed.
 */

// Params for creating a state
export interface CreateStateParams extends MemoryParams {
  /**
   * State name (unique per workspace)
   */
  name: string;

  /**
   * Conversation context for this state (REQUIRED)
   */
  conversationContext: string;

  /**
   * Currently active task (REQUIRED)
   */
  activeTask: string;

  /**
   * List of active files (REQUIRED)
   */
  activeFiles: string[];

  /**
   * Next steps for the workflow (REQUIRED)
   */
  nextSteps: string[];

  /**
   * State description (optional)
   */
  description?: string;

  /**
   * Tags to associate with this state (optional)
   */
  tags?: string[];
}

// Params for listing states
export interface ListStatesParams extends MemoryParams {
  /**
   * Whether to include state context information
   */
  includeContext?: boolean;

  /**
   * Maximum number of states to return (deprecated, use pageSize instead)
   */
  limit?: number;

  /**
   * Filter states by target session ID
   */
  targetSessionId?: string;

  /**
   * Sort order for states (default: desc - newest first)
   */
  order?: 'asc' | 'desc';

  /**
   * Filter states by tags
   */
  tags?: string[];

  /**
   * Page number for pagination (0-indexed)
   */
  page?: number;

  /**
   * Number of items per page for pagination
   */
  pageSize?: number;

  /**
   * Whether to include archived states in the results (default: false)
   */
  includeArchived?: boolean;
}

// Params for loading a state
export interface LoadStateParams extends MemoryParams {
  /**
   * Name of the state to load (required)
   */
  name: string;

  /**
   * @deprecated Use `name` instead. Kept for backward compatibility.
   */
  stateId?: string;
}

// Params for archiving a state
export interface ArchiveStateParams extends MemoryParams {
  /**
   * Name of the state to archive or restore
   */
  name: string;

  /**
   * If true, restores the state from archive. If false/omitted, archives the state.
   */
  restore?: boolean;
}

// Result for state operations
export interface StateResult extends MemoryResult {
  data?: {
    /**
     * State ID
     */
    stateId?: string;
    
    /**
     * State name
     */
    name?: string;
    
    /**
     * State description
     */
    description?: string;
    
    /**
     * Workspace ID
     */
    workspaceId?: string;
    
    /**
     * Session ID
     */
    sessionId?: string;
    
    /**
     * Creation timestamp
     */
    created?: number;
    
    /**
     * New session ID when loading a state
     */
    newSessionId?: string;
    
    /**
     * List of states (for listing operations)
     */
    states?: Array<{
      id: string;
      name: string;
      workspaceId: string;
      sessionId: string;
      timestamp: number;
      description?: string;
      context?: {
        files: string[];
        traceCount: number;
        tags: string[];
        summary?: string;
      };
    }>;
    
    /**
     * Total number of states matching criteria before limit applied
     */
    total?: number;
    
    /**
     * Context information for the restored state
     */
    restoredContext?: {
      summary: string;
      associatedNotes: string[];
      stateCreatedAt: string;
      originalSessionId: string;
      continuationHistory?: Array<{
        timestamp: number;
        description: string;
      }>;
    };
  };
}