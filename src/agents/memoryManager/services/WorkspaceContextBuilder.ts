/**
 * Location: /src/agents/memoryManager/services/WorkspaceContextBuilder.ts
 * Purpose: Builds context information for workspaces
 *
 * This service handles building various context components for workspaces
 * including contextual briefings, workflows, key files, and preferences.
 *
 * Used by: LoadWorkspaceMode for building workspace context
 * Integrates with: MemoryService for recent activity data
 *
 * Responsibilities:
 * - Build contextual briefings with recent activity
 * - Extract and format workflow information
 * - Extract key files from workspace context
 * - Build preferences summary
 */

import { ProjectWorkspace } from '../../../database/types/workspace/WorkspaceTypes';

/**
 * Interface for memory service methods used by this builder
 */
interface IMemoryServiceForContext {
  getMemoryTraces(workspaceId: string): Promise<Array<{
    timestamp?: number;
    content?: string;
    metadata?: {
      request?: {
        normalizedParams?: { context?: { sessionMemory?: string } };
        originalParams?: { context?: { sessionMemory?: string } };
      };
    };
  }>>;
}

/**
 * Context briefing structure
 */
export interface ContextBriefing {
  name: string;
  description?: string;
  purpose?: string;
  rootFolder: string;
  recentActivity: string[];
}

/**
 * Service for building workspace context information
 * Implements Single Responsibility Principle - only handles context building
 */
export class WorkspaceContextBuilder {
  /**
   * Build a contextual briefing for the workspace
   * @param workspace The workspace
   * @param memoryService The memory service instance
   * @param limit Maximum number of recent activity items
   * @returns Context briefing object
   */
  async buildContextBriefing(
    workspace: ProjectWorkspace,
    memoryService: IMemoryServiceForContext | null,
    limit: number
  ): Promise<ContextBriefing> {
    let recentActivity: string[] = [];

    if (memoryService) {
      try {
        recentActivity = await this.getRecentActivity(workspace.id, memoryService, limit);
      } catch (error) {
        console.error('[WorkspaceContextBuilder] getRecentActivity failed:', error);
        recentActivity = [`Recent activity error: ${error instanceof Error ? error.message : String(error)}`];
      }
    } else {
      recentActivity = ['No recent activity'];
    }

    const finalActivity = recentActivity.length > 0 ? recentActivity : ['No recent activity'];

    return {
      name: workspace.name,
      description: workspace.description || undefined,
      purpose: workspace.context?.purpose || undefined,
      rootFolder: workspace.rootFolder,
      recentActivity: finalActivity
    };
  }

  /**
   * Build workflows array - one string per workflow
   * @param workspace The workspace
   * @returns Array of formatted workflow strings
   */
  buildWorkflows(workspace: ProjectWorkspace): string[] {
    if (!workspace.context?.workflows || workspace.context.workflows.length === 0) {
      return [];
    }

    return workspace.context.workflows.map(workflow => {
      return `**${workflow.name}** (${workflow.when}):\n${workflow.steps}`;
    });
  }

  /**
   * Extract key files into a flat structure
   * @param workspace The workspace
   * @returns Record of file names to file paths
   */
  extractKeyFiles(workspace: ProjectWorkspace): Record<string, string> {
    const keyFiles: Record<string, string> = {};

    if (workspace.context?.keyFiles) {
      // New format: simple array of file paths
      if (Array.isArray(workspace.context.keyFiles)) {
        workspace.context.keyFiles.forEach((filePath, index) => {
          // Extract filename without extension as key
          const fileName = filePath.split('/').pop()?.replace(/\.[^/.]+$/, '') || `file_${index}`;
          keyFiles[fileName] = filePath;
        });
      }
      // Legacy format: array of categorized files (for backward compatibility)
      else if (typeof workspace.context.keyFiles === 'object' && 'length' in workspace.context.keyFiles) {
        const legacyKeyFiles = workspace.context.keyFiles as Array<{ files?: Record<string, string> }>;
        legacyKeyFiles.forEach((category) => {
          if (category.files) {
            Object.entries(category.files).forEach(([name, path]) => {
              keyFiles[name] = path;
            });
          }
        });
      }
    }

    return keyFiles;
  }

  /**
   * Build preferences summary
   * @param workspace The workspace
   * @returns Preferences summary string
   */
  buildPreferences(workspace: ProjectWorkspace): string {
    // Preferences is now a string, not an array
    if (workspace.context?.preferences && workspace.context.preferences.trim()) {
      return workspace.context.preferences;
    }

    // Legacy support for userPreferences (if still exists)
    if (workspace.preferences?.userPreferences && Array.isArray(workspace.preferences.userPreferences)) {
      return workspace.preferences.userPreferences.join('. ') + '.';
    }

    return 'No preferences set';
  }

  /**
   * Get recent activity from memory traces
   * Extracts sessionMemory from trace metadata to show what the LLM was doing
   * @param workspaceId The workspace ID
   * @param memoryService The memory service instance
   * @param limit Maximum number of activity items
   * @returns Array of recent activity strings
   */
  private async getRecentActivity(
    workspaceId: string,
    memoryService: IMemoryServiceForContext,
    limit: number
  ): Promise<string[]> {
    try {
      // Get all traces from workspace (across all sessions)
      const traces = await memoryService.getMemoryTraces(workspaceId);

      if (!traces || traces.length === 0) {
        return ['No recent activity'];
      }

      // Sort by timestamp descending (newest first)
      traces.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

      // Extract sessionMemory from trace metadata
      const activities: string[] = [];
      for (let i = 0; i < Math.min(limit, traces.length); i++) {
        const trace = traces[i];

        // Try to get sessionMemory from metadata (where it actually is stored)
        const sessionMemory =
          trace.metadata?.request?.normalizedParams?.context?.sessionMemory ||
          trace.metadata?.request?.originalParams?.context?.sessionMemory;

        if (sessionMemory && sessionMemory.trim()) {
          activities.push(sessionMemory);
        } else {
          // Fallback to trace content if no sessionMemory
          activities.push(trace.content || 'Unknown activity');
        }
      }

      return activities.length > 0 ? activities : ['No recent activity'];
    } catch (error) {
      return ['Recent activity unavailable'];
    }
  }
}
