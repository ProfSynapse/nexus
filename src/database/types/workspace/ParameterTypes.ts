/**
 * Workspace Parameter Types
 * Parameter types that prompt LLMs to provide the correct structured workspace data
 */

import { CommonParameters, CommonResult } from '../../../types/mcp';
import {
  WorkspaceWorkflow
} from './WorkspaceTypes';

export type WorkspaceWorkflowDefinition = WorkspaceWorkflow

/**
 * Create workspace parameters - LLM must provide complete WorkspaceContext structure
 */
export interface CreateWorkspaceParameters extends CommonParameters {
  /**
   * Workspace name (required)
   */
  name: string;

  /**
   * Description of what this workspace is for (required)
   * Example: "Screenplay development project"
   */
  description: string;

  /**
   * Root folder path (required)
   */
  rootFolder: string;

  /**
   * What is this workspace for? (required)
   * Example: "Apply for marketing manager positions"
   */
  purpose: string;

  /**
   * Workflows for different situations (optional)
   * Provide an array of workflows with name, when to use, and steps as a single string
   * Example: [{"name": "New Application", "when": "When applying to new position", "steps": "Research company\nCustomize cover letter\nApply\nTrack"}]
   */
  workflows?: WorkspaceWorkflowDefinition[];

  /**
   * Simple key files list for quick reference (optional)
   * Provide array of file paths for key files in this workspace
   * Example: ["path/to/resume.md", "path/to/portfolio.md"]
   */
  keyFiles?: string[];

  /**
   * User preferences as actionable guidelines (optional)
   * Provide specific preferences about how to work
   * Example: "Use professional tone. Focus on tech companies. Keep cover letters under 300 words."
   */
  preferences?: string;

  /**
   * ID of dedicated agent for this workspace (optional)
   * This agent's systemPrompt will be included when loading the workspace
   * Example: "agent_12345"
   */
  dedicatedAgentId?: string;


  // Optional legacy fields for backward compatibility
  relatedFolders?: string[];
  relatedFiles?: string[];
  keyFileInstructions?: string;
}

/**
 * Create workspace result
 */
export interface CreateWorkspaceResult extends CommonResult {
  data?: never;
}

/**
 * Load workspace result - returns actionable briefing instead of raw data
 */
export interface LoadWorkspaceResult extends CommonResult {
  data: {
    context: {
      name: string;
      description?: string;
      purpose?: string;
      rootFolder: string;
      recentActivity: string[];
    };
    workflows: string[];
    workflowDefinitions?: WorkspaceWorkflowDefinition[];
    workspaceStructure: string[];
    recentFiles: Array<{
      path: string;
      modified: number;
    }>;
    keyFiles: Record<string, string>;
    preferences: string;
    sessions: Array<{
      id: string;
      name: string;
      description?: string;
      created: number;
    }>;
    states: Array<{
      name: string;
      tags?: string[];
    }>;
    prompt?: {
      id: string;
      name: string;
      systemPrompt: string;
    };
    taskSummary?: import('../../../agents/taskManager/types').WorkspaceTaskSummary;
  };
  pagination?: {
    sessions: {
      page: number;
      pageSize: number;
      totalItems: number;
      totalPages: number;
      hasNextPage: boolean;
      hasPreviousPage: boolean;
    };
    states: {
      page: number;
      pageSize: number;
      totalItems: number;
      totalPages: number;
      hasNextPage: boolean;
      hasPreviousPage: boolean;
    };
  };
  /**
   * Present only when the requested identifier did not match a workspace
   * exactly. Either reports the near-miss that was resolved and loaded, or
   * carries the shortlist to pick from so the caller never has to guess again.
   */
  resolution?: WorkspaceResolutionReport;
}

/**
 * Miss-recovery report attached to loadWorkspace when the requested workspace
 * name or ID was not an exact match.
 */
export interface WorkspaceResolutionReport {
  /** The identifier the caller asked for. */
  requested: string;
  /** Whether a near-miss was confidently resolved and loaded anyway. */
  autoResolved: boolean;
  /** The workspace actually loaded, when autoResolved is true. */
  resolvedTo?: {
    id: string;
    name: string;
  };
  /** Ranked alternatives when nothing was auto-resolved. */
  candidates?: Array<{
    id: string;
    name: string;
    description?: string;
    rootFolder: string;
    score: number;
  }>;
  /** Every workspace available, listed when nothing matched at all. */
  availableWorkspaces?: string[];
  /** Human/agent-readable explanation plus the exact next command to run. */
  note: string;
}

/**
 * Create state parameters - LLM must provide complete StateContext structure
 */
export interface CreateStateParameters extends CommonParameters {
  /**
   * State name (required)
   */
  name: string;
  
  /**
   * What was happening when you decided to save this state? (required)
   * Provide a summary of the conversation and what you were working on
   * Example: "We were customizing the cover letter for Google's Marketing Manager position. We researched their team and identified key requirements."
   */
  conversationContext: string;
  
  /**
   * What task were you actively working on? (required)
   * Be specific about the current task
   * Example: "Finishing the cover letter paragraph about data-driven campaign optimization results"
   */
  activeTask: string;
  
  /**
   * Which files were you working with? (required)
   * List the files that were being edited or referenced
   * Example: ["cover-letter-google.md", "application-tracker.md"]
   */
  activeFiles: string[];
  
  /**
   * What are the immediate next steps when you resume? (required)
   * Provide specific actionable next steps
   * Example: ["Complete cover letter customization", "Review resume for Google-specific keywords", "Submit application"]
   */
  nextSteps: string[];
  
  /**
   * Why are you saving this state right now? (required)
   * Explain the reason for saving at this point
   * Example: "Saving before context limit, about to submit application"
   */
  reasoning: string;
  
  // Optional legacy fields
  description?: string;
  workspaceContext?: CommonParameters['workspaceContext'];
  targetSessionId?: string;
  includeSummary?: boolean;
  includeFileContents?: boolean;
  maxFiles?: number;
  maxTraces?: number;
  tags?: string[];
  reason?: string;
}

/**
 * Load state result - returns actionable restoration context
 */
export interface LoadStateResult extends CommonResult {
  data: {
    resumingFrom: string;
    workspaceContext: string;
    whereYouLeftOff: string;
    currentTask: string;
    activeFiles: string[];
    nextSteps: string[];
    workflow: string;
  };
}

// Legacy parameter types for backward compatibility
export interface LoadWorkspaceParameters extends CommonParameters {
  workspace: string;
  limit?: number; // Optional limit for sessions, states, and recentActivity (default: 3)
  recursive?: boolean; // Show full recursive structure (true) or top-level folders only (false, default)
}

export interface LoadStateParams extends CommonParameters {
  stateId: string;
  sessionName?: string;
  sessionDescription?: string;
  restorationGoal?: string;
  createContinuationSession?: boolean;
  tags?: string[];
}

export interface ListWorkspacesParameters extends CommonParameters {
  includeArchived?: boolean;
  sortBy?: 'name' | 'created' | 'lastAccessed';
  order?: 'asc' | 'desc';
  limit?: number;
}

export interface SearchWorkspacesParameters extends CommonParameters {
  query: string;
  limit?: number;
  includeArchived?: boolean;
  /**
   * When true, auto-load the match if the search returns exactly one.
   * Strict by design: 0 or 2+ matches never auto-load.
   */
  load?: boolean;
}

export interface EditWorkspaceParameters extends CommonParameters {
  id: string;
  name?: string;
  description?: string;
  rootFolder?: string;
  relatedFolders?: string[];
  relatedFiles?: string[];
  preferences?: Record<string, unknown>;
  keyFileInstructions?: string;
}

export interface DeleteWorkspaceParameters extends CommonParameters {
  id: string;
  deleteChildren?: boolean;
  preserveSettings?: boolean;
}

export interface AddFilesToWorkspaceParameters extends CommonParameters {
  workspaceId: string;
  files?: string[];
  folders?: string[];
  addAsRelated?: boolean;
  markAsKeyFiles?: boolean;
}

// Legacy result types
export interface StateResult extends CommonResult {
  data?: {
    stateId: string;
    name: string;
    workspaceId: string;
    sessionId: string;
    timestamp: number;
    capturedContext?: unknown;
  };
}

export interface ListWorkspacesResult extends CommonResult {
  data: {
    workspaces: Array<{
      id: string;
      name: string;
      description?: string;
      rootFolder: string;
      lastAccessed: number;
      childCount: number;
    }>;
  };
}

export interface SearchWorkspacesMatch {
  id: string;
  name: string;
  description?: string;
  rootFolder: string;
  lastAccessed: number;
  /** Relevance score from WorkspaceMatcher (higher is better). */
  score: number;
  /** Fields that contributed to the score. */
  matchedOn: string[];
}

export interface SearchWorkspacesResult extends CommonResult {
  data: {
    query: string;
    matches: SearchWorkspacesMatch[];
    /** Match count before `limit` truncation — this drives the auto-load decision. */
    totalMatches: number;
    autoLoaded: boolean;
    /** Full loadWorkspace payload, present only when autoLoaded is true. */
    workspace?: unknown;
    /** Next-step steer for the caller when nothing was auto-loaded. */
    nudge?: string;
  };
}

export interface AddFilesToWorkspaceResult extends CommonResult {
  data: {
    filesAdded: number;
    foldersAdded: number;
    addedFiles: string[];
    failedFiles: Array<{
      path: string;
      reason: string;
    }>;
    workspace: {
      id: string;
      name: string;
      totalFiles: number;
      totalRelatedFiles: number;
    };
  };
}

// Legacy exports for backward compatibility
export type WorkspaceParameters = LoadWorkspaceParameters
export type WorkspaceResult = LoadWorkspaceResult
export type QuickCreateWorkspaceParameters = CreateWorkspaceParameters
