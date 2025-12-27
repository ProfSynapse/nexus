/**
 * Workspace Parameter Types
 * Parameter types that prompt LLMs to provide the correct structured workspace data
 */

import { CommonParameters, CommonResult } from '../../../types/mcp';
import { ProjectWorkspace, WorkspaceContext } from './WorkspaceTypes';
import { StateContext } from '../session/SessionTypes';

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
  workflows?: Array<{
    name: string;
    when: string;
    steps: string;
  }>;

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
  data: {
    workspaceId: string;
    workspace: ProjectWorkspace;
  };
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
      id: string;
      name: string;
      description?: string;
      sessionId: string;
      created: number;
      tags?: string[];
    }>;
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
  workspaceContext?: any;
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
  id: string;
  limit?: number; // Optional limit for sessions, states, and recentActivity (default: 3)
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

export interface EditWorkspaceParameters extends CommonParameters {
  id: string;
  name?: string;
  description?: string;
  rootFolder?: string;
  relatedFolders?: string[];
  relatedFiles?: string[];
  preferences?: Record<string, any>;
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
    capturedContext?: any;
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
export interface WorkspaceParameters extends LoadWorkspaceParameters {}
export interface WorkspaceResult extends LoadWorkspaceResult {}
export interface QuickCreateWorkspaceParameters extends CreateWorkspaceParameters {}