/**
 * WorkspaceResultFormatter - Specialized formatter for workspace results
 * Location: /src/agents/searchManager/services/formatters/WorkspaceResultFormatter.ts
 *
 * Handles formatting of workspace memory results with workspace identification
 * and path information.
 *
 * Used by: ResultFormatter for WORKSPACE type results
 */

import { MemoryResultMetadata, MemorySearchResult } from '../../../../types/memory/MemorySearchTypes';
import { BaseResultFormatter } from './BaseResultFormatter';

type WorkspaceResultMetadata = MemoryResultMetadata & {
  workspacePath?: string[];
  activeWorkspace?: boolean;
};

/**
 * Formatter for workspace results
 */
export class WorkspaceResultFormatter extends BaseResultFormatter {
  protected generateTitle(result: MemorySearchResult): string {
    return `Workspace: ${result.metadata.workspaceId || 'Unknown'}`;
  }

  protected addTypeSpecificMetadata(formatted: Record<string, string>, metadata: WorkspaceResultMetadata): void {
    if (metadata.workspacePath && Array.isArray(metadata.workspacePath)) {
      formatted['Path'] = metadata.workspacePath.join(' > ');
    }
    if (metadata.activeWorkspace !== undefined) {
      formatted['Active'] = metadata.activeWorkspace ? 'Yes' : 'No';
    }
  }
}
