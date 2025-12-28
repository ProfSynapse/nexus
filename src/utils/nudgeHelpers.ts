/**
 * Helper functions for dynamic tool nudges
 * Provides common logic for nudge triggers based on the dynamic tool nudges specification
 */

import { Recommendation } from './recommendationUtils';

/**
 * Helper functions for analyzing tool results and creating nudges
 */
export class NudgeHelpers {
  
  /**
   * Check if multiple files were found (>3 files) to suggest batch operations
   */
  static checkMultipleFiles(fileCount: number): Recommendation | null {
    if (fileCount > 3) {
      return {
        type: "efficiency",
        message: "Multiple files found. Consider using ContentManager batchContent to read several files efficiently in one operation."
      };
    }
    return null;
  }

  /**
   * Check if files are from different folders to suggest organization
   */
  static checkDifferentFolders(filePaths: string[]): Recommendation | null {
    if (filePaths.length === 0) return null;
    
    // Extract unique folder paths
    const folders = new Set(filePaths.map(path => {
      const lastSlash = path.lastIndexOf('/');
      return lastSlash === -1 ? '' : path.substring(0, lastSlash);
    }));
    
    if (folders.size > 1) {
      return {
        type: "organization", 
        message: "Found related files across multiple folders. You might want to consider organizing them with VaultManager."
      };
    }
    return null;
  }

  /**
   * Check if content is large (>7,000 characters) to suggest state saving
   */
  static checkLargeContent(contentLength: number): Recommendation | null {
    if (contentLength > 7000) {
      return {
        type: "save",
        message: "Large document read. Consider using MemoryManager createState to capture key insights before continuing."
      };
    }
    return null;
  }

  /**
   * Always suggest frontmatter and wikilinks for new files
   */
  static suggestObsidianFeatures(): Recommendation {
    return {
      type: "obsidian_features",
      message: "New file created. Consider adding frontmatter for metadata and wikilinks [[like this]] to connect with other notes."
    };
  }

  /**
   * Check session for multiple file creations to suggest state saving
   */
  static checkMultipleFilesInSession(sessionContext: any): Recommendation | null {
    // This would need session tracking - for now return null and implement later with full session context
    // In the future, this could check session memory for previous file creation operations
    return null;
  }

  /**
   * Check for many files read in batch (>3) to suggest state saving
   */
  static checkBatchReadOperations(readCount: number): Recommendation | null {
    if (readCount > 3) {
      return {
        type: "save",
        message: "Multiple files reviewed. Consider using MemoryManager createState to capture your findings."
      };
    }
    return null;
  }

  /**
   * Check for many files created in batch (>2) to suggest agent creation
   */
  static checkBatchCreateOperations(createCount: number): Recommendation | null {
    if (createCount > 2) {
      return {
        type: "agent_suggestion",
        message: "Creating multiple similar files? Consider using AgentManager to create a custom agent for this type of content generation."
      };
    }
    return null;
  }

  /**
   * Always suggest link checking after moving files
   */
  static suggestLinkChecking(): Recommendation {
    return {
      type: "link_check",
      message: "Files moved. Consider checking if any internal links need updating with ContentManager."
    };
  }

  /**
   * Always suggest customization after duplicating files
   */
  static suggestCustomization(): Recommendation {
    return {
      type: "customization",
      message: "File duplicated. Consider using ContentManager to customize the copy for its new purpose."
    };
  }

  /**
   * Always suggest impact awareness after command execution
   */
  static suggestImpactAwareness(): Recommendation {
    return {
      type: "awareness",
      message: "Obsidian command executed. If this changed settings or enabled features, consider how it might affect your current workflow."
    };
  }

  /**
   * Always suggest state saving after prompt execution
   */
  static suggestCaptureProgress(): Recommendation {
    return {
      type: "capture",
      message: "Agent analysis complete. Consider using MemoryManager createState to save this progress."
    };
  }

  /**
   * Always suggest workspace integration for new agents
   */
  static suggestWorkspaceIntegration(): Recommendation {
    return {
      type: "workspace_integration",
      message: "New agent created. Consider associating it with your current workspace using MemoryManager updateWorkspace for automatic availability."
    };
  }

  /**
   * Check for large workspace (>20 files) to suggest exploration tools
   */
  static checkLargeWorkspace(fileCount: number): Recommendation | null {
    if (fileCount > 20) {
      return {
        type: "exploration",
        message: "Large workspace loaded. Consider using VaultManager listDirectory to explore the structure, or VaultLibrarian search to find specific content."
      };
    }
    return null;
  }

  /**
   * Always suggest next steps after state creation
   */
  static suggestNextSteps(): Recommendation {
    return {
      type: "next_steps",
      message: "Progress saved. Consider what you'd like to work on next, or use AgentManager if you want to automate similar future workflows."
    };
  }

  /**
   * Check memory search results for previous states
   */
  static checkPreviousStates(results: any[]): Recommendation | null {
    // Look for states in memory search results
    const hasStates = results.some(result => 
      result.category === 'states' || 
      (result.metadata && result.metadata.type === 'state')
    );
    
    if (hasStates) {
      return {
        type: "context_restoration",
        message: "Relevant previous work found. Consider using MemoryManager loadState to restore that context."
      };
    }
    return null;
  }

  /**
   * Check memory search results for workspace sessions
   */
  static checkWorkspaceSessions(results: any[]): Recommendation | null {
    // Look for sessions in memory search results
    const hasSessions = results.some(result => 
      result.category === 'sessions' || 
      (result.metadata && result.metadata.type === 'session')
    );
    
    if (hasSessions) {
      return {
        type: "session_continuation",
        message: "Related workspace data found. Consider memoryManager loadState to continue previous work."
      };
    }
    return null;
  }

  /**
   * Helper to extract file paths from search results
   */
  static extractFilePathsFromResults(results: any[]): string[] {
    if (!Array.isArray(results)) return [];
    
    return results
      .map(result => result.filePath || result.path || result.file)
      .filter(path => typeof path === 'string')
      .filter(Boolean);
  }

  /**
   * Helper to count file operations in batch results
   */
  static countOperationsByType(operations: any[]): { read: number; create: number; total: number } {
    if (!Array.isArray(operations)) return { read: 0, create: 0, total: 0 };

    const read = operations.filter(op => op.operation === 'read' || op.type === 'read').length;
    const create = operations.filter(op => op.operation === 'create' || op.type === 'create').length;

    return { read, create, total: operations.length };
  }

  // ===================
  // AgentManager Nudges
  // ===================

  /**
   * Check if prompt execution suggests creating a reusable agent
   * @param hasWorkspace Whether user is in a workspace context
   */
  static checkAgentCreationOpportunity(hasWorkspace: boolean): Recommendation | null {
    if (hasWorkspace) {
      return {
        type: "agent_suggestion",
        message: "Running prompts in a workspace? Consider creating a custom agent for repeated tasks."
      };
    }
    return null;
  }

  /**
   * Check batch operations for agent automation opportunity
   * @param operationCount Number of operations in batch
   */
  static checkBatchAgentOpportunity(operationCount: number): Recommendation | null {
    if (operationCount > 2) {
      return {
        type: "automation",
        message: "Batch operations suggest routine workflows. A custom agent could automate this pattern."
      };
    }
    return null;
  }

  /**
   * Check if prompt list shows opportunity for workspace binding
   * @param promptCount Number of prompts available
   * @param hasWorkspace Whether user is in a workspace context
   */
  static checkPromptBindingOpportunity(promptCount: number, hasWorkspace: boolean): Recommendation | null {
    if (promptCount > 0 && hasWorkspace) {
      return {
        type: "workspace_binding",
        message: "Bind frequently used prompts to your workspace for automatic availability."
      };
    }
    return null;
  }

  /**
   * Suggest testing after prompt creation/update
   */
  static suggestPromptTesting(): Recommendation {
    return {
      type: "testing",
      message: "Test your prompt with executePrompts to verify it works as expected."
    };
  }
}