/**
 * Core Workspace Types
 * Simple, clean workspace types focused on LLM usability
 */

export type WorkflowFrequency = 'hourly' | 'daily' | 'weekly' | 'monthly';
export type WorkflowCatchUpPolicy = 'skip' | 'latest' | 'all';

export interface WorkflowSchedule {
  enabled: boolean;
  frequency: WorkflowFrequency;
  intervalHours?: number;
  hour?: number;
  minute?: number;
  dayOfWeek?: number;
  dayOfMonth?: number;
  catchUp: WorkflowCatchUpPolicy;
}

export interface WorkspaceWorkflow {
  id: string;
  name: string;
  when: string;
  steps: string;
  promptId?: string;
  promptName?: string;
  schedule?: WorkflowSchedule;
}

/**
 * Status types for individual items within a workspace
 */
export type ItemStatus = 'notStarted' | 'inProgress' | 'completed';

/**
 * Simple workspace context for LLM understanding
 */
export interface WorkspaceContext {
  /**
   * What is this workspace for?
   * Example: "Apply for marketing manager positions"
   */
  purpose?: string;

  /**
   * Workflows for different situations
   */
  workflows?: WorkspaceWorkflow[];

  /**
   * Simple key files list for quick reference
   */
  keyFiles?: string[];       // ["path/to/resume.md", "path/to/portfolio.md"]

  /**
   * User preferences as actionable guidelines
   */
  preferences?: string;      // "Use professional tone. Focus on tech companies."

  /**
   * Single dedicated agent for this workspace
   */
  dedicatedAgent?: {
    agentId: string;        // Unique identifier for the agent
    agentName: string;      // Display name of the agent
  };

}

/**
 * Simple workspace interface - our agreed-upon clean schema
 */
export interface Workspace {
  id: string;
  name: string;
  context?: WorkspaceContext;  // Optional for backward compatibility
  rootFolder: string;
  created: number;
  lastAccessed: number;
  isArchived?: boolean;  // Soft delete flag
}

/**
 * Legacy ProjectWorkspace interface for backward compatibility
 * Extends the simple Workspace with optional legacy fields
 */
export interface ProjectWorkspace extends Workspace {
  // Core functionality
  isActive?: boolean;

  // Legacy fields for backward compatibility
  description?: string;
  relatedFolders?: string[];
  relatedFiles?: string[];
  associatedNotes?: string[];
  keyFileInstructions?: string;
  activityHistory?: Array<{
    timestamp: number;
    action: 'view' | 'edit' | 'create' | 'tool';
    toolName?: string;
    duration?: number;
    context?: string;
  }>;
  preferences?: Record<string, unknown>;
  projectPlan?: string;
  checkpoints?: Array<{
    id: string;
    date: number;
    description: string;
    completed: boolean;
  }>;
  completionStatus?: Record<string, {
    status: ItemStatus;
    completedDate?: number;
    completionNotes?: string;
  }>;
}
