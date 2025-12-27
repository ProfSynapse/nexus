/**
 * Session Types
 * Simple session and state types focused on LLM restoration
 */

import { WorkspaceContext } from '../workspace/WorkspaceTypes';

/**
 * Session tracking for workspace activities
 * Simplified to only essential fields for clean auto-session creation
 */
export interface WorkspaceSession {
  /**
   * Unique session identifier
   */
  id: string;
  
  /**
   * Associated workspace ID
   */
  workspaceId: string;
  
  /**
   * Optional session name
   */
  name?: string;
  
  /**
   * Optional session description
   */
  description?: string;
}

/**
 * State context data - everything needed to resume work
 */
export interface StateContext {
  /**
   * Workspace context at save time
   */
  workspaceContext: WorkspaceContext;

  /**
   * What was happening when you decided to save this state?
   */
  conversationContext: string;

  /**
   * What task were you actively working on?
   */
  activeTask: string;

  /**
   * Which files were you working with?
   */
  activeFiles: string[];

  /**
   * What are the immediate next steps when you resume?
   */
  nextSteps: string[];
}

/**
 * Simple state interface - our agreed-upon clean schema
 */
export interface State {
  id: string;
  name: string;
  workspaceId: string;
  created: number;
  context: StateContext;
}

/**
 * WorkspaceState interface - full state with optional legacy fields
 * Extends the simple State with additional metadata
 */
export interface WorkspaceState extends State {
  // Legacy fields for backward compatibility
  sessionId?: string;
  timestamp?: number;
  description?: string;
  state?: {
    workspace: any;
    recentTraces: string[];
    contextFiles: string[];
    metadata: Record<string, any>;
  };
}

/**
 * @deprecated Use StateContext instead
 */
export type StateSnapshot = StateContext;

/**
 * @deprecated Use WorkspaceState instead
 */
export type WorkspaceStateSnapshot = WorkspaceState;