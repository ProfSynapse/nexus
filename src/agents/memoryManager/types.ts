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
 * Session-related parameter and result types
 */

// Params for creating a session
export interface CreateSessionParams extends MemoryParams {
  /**
   * Session name (optional, generates default if not provided)
   */
  name?: string;
  
  /**
   * Session description (optional)
   */
  description?: string;
  
  /**
   * Whether to generate an initial memory trace with session context (default: true)
   */
  generateContextTrace?: boolean;
  
  /**
   * The goal or purpose of this session (for memory context)
   */
  sessionGoal?: string;
  
  /**
   * Reference to previous session ID to establish continuity
   */
  previousSessionId?: string;
  
  /**
   * Override for the session ID from MemoryParams.
   * This allows creating a session with a specific session ID rather than using the tracking ID.
   * Note: This is distinct from the required sessionId in MemoryParams which tracks the tool call itself.
   */
  newSessionId?: string;
  
  /**
   * Workspace context (optional)
   * If provided, should contain a workspaceId; if not provided, defaults to the first workspace or creates a default workspace
   * This can also be a JSON string with the same structure
   */
  workspaceContext?: WorkspaceContext | string;
}

// Params for listing sessions
export interface ListSessionsParams extends MemoryParams {
  /**
   * Maximum number of sessions to return
   */
  limit?: number;
  
  /**
   * Sort order for sessions (default: desc - newest first)
   */
  order?: 'asc' | 'desc';
}

// Params for editing a session  
export interface EditSessionParams extends Omit<MemoryParams, 'sessionId'> {
  /**
   * Session ID for tracking this tool call
   */
  sessionId: string;
  
  /**
   * ID of the session to edit (same as sessionId for backward compatibility)
   */
  targetSessionId?: string;
  
  /**
   * New session name (optional)
   */
  name?: string;
  
  /**
   * New session description (optional)
   */
  description?: string;
  
  /**
   * New session goal (optional)
   */
  sessionGoal?: string;
}

// Result for session operations
export interface SessionResult extends MemoryResult {
  data?: {
    /**
     * Session ID
     */
    sessionId?: string;
    
    /**
     * Session name
     */
    name?: string;
    
    /**
     * Session description
     */
    description?: string;
    
    /**
     * Workspace ID
     */
    workspaceId?: string;
    
    /**
     * ID of the new continuation session (when loading a session)
     */
    newSessionId?: string;
    
    /**
     * List of sessions (for listing operations)
     */
    sessions?: Array<{
      id: string;
      name?: string;
      workspaceId: string;
      description?: string;
    }>;
    
    /**
     * Context information for the loaded session
     */
    sessionContext?: {
      summary: string;
      associatedNotes: string[];
      sessionCreatedAt: string;
      traces?: Array<{
        timestamp: number;
        content: string;
        type: string;
        importance: number;
      }>;
    };
  };
}

/**
 * Params for loading a session
 */
export interface LoadSessionParams extends Omit<MemoryParams, 'sessionId'> {
  /**
   * Session ID for tracking this tool call
   */
  sessionId: string;
  
  /**
   * ID of the session to load (same as sessionId for backward compatibility)
   */
  targetSessionId?: string;
  
  /**
   * Custom name for the new continuation session (optional)
   */
  sessionName?: string;
  
  /**
   * Custom description for the new continuation session (optional)
   */
  sessionDescription?: string;
  
  /**
   * Whether to automatically start a new session if the original is inactive (default: true)
   */
  createContinuationSession?: boolean;
}

/**
 * State-related parameter and result types
 */

// Params for creating a state
export interface CreateStateParams extends MemoryParams {
  /**
   * State name
   */
  name: string;
  
  /**
   * State description (optional)
   */
  description?: string;
  
  /**
   * Target session ID (optional, uses active session if not provided)
   * This is different from the top-level sessionId which is for tracking tool calls
   */
  targetSessionId?: string;
  
  /**
   * Whether to include state summary
   */
  includeSummary?: boolean;
  
  /**
   * Whether to include files content in the state
   */
  includeFileContents?: boolean;
  
  /**
   * Maximum number of files to include
   */
  maxFiles?: number;
  
  /**
   * Maximum number of memory traces to include
   */
  maxTraces?: number;
  
  /**
   * Tags to associate with this state
   */
  tags?: string[];
  
  /**
   * Reason for creating this state
   */
  reason?: string;
  
  /**
   * Conversation context for this state
   */
  conversationContext?: string;
  
  /**
   * Currently active task
   */
  activeTask?: string;
  
  /**
   * List of active files
   */
  activeFiles?: string[];
  
  /**
   * Next steps for the workflow
   */
  nextSteps?: string[];
  
  /**
   * Reasoning behind the state creation
   */
  reasoning?: string;
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
}

// Params for loading a state
export interface LoadStateParams extends MemoryParams {
  /**
   * ID of the state to load
   */
  stateId: string;
  
  /**
   * Custom name for the new continuation session (optional)
   */
  sessionName?: string;
  
  /**
   * Custom description for the new continuation session (optional)
   */
  sessionDescription?: string;
  
  /**
   * Restoration goal - what the user intends to do after restoring
   */
  restorationGoal?: string;
  
  /**
   * Whether to continue with the original session ID (default: true). Set to false to create a new continuation session.
   */
  continueExistingSession?: boolean;
}

// Params for editing a state
export interface EditStateParams extends MemoryParams {
  /**
   * ID of the state to edit
   */
  stateId: string;
  
  /**
   * New state name (optional)
   */
  name?: string;
  
  /**
   * New state description (optional)
   */
  description?: string;
  
  /**
   * Add additional tags to state
   */
  addTags?: string[];
  
  /**
   * Remove specific tags from state
   */
  removeTags?: string[];
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