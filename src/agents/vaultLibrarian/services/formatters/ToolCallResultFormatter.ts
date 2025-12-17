/**
 * ToolCallResultFormatter - Specialized formatter for tool call results
 * Location: /src/agents/vaultLibrarian/services/formatters/ToolCallResultFormatter.ts
 *
 * Handles formatting of tool call memory results with execution details,
 * success/failure status, and timing information.
 *
 * Used by: ResultFormatter for TOOL_CALL type results
 */

import {
  MemorySearchResult,
  FormatOptions,
  MemoryType
} from '../../../../types/memory/MemorySearchTypes';
import { BaseResultFormatter } from './BaseResultFormatter';

/**
 * Formatter for tool call results
 */
export class ToolCallResultFormatter extends BaseResultFormatter {
  protected generateTitle(result: MemorySearchResult): string {
    return `${result.metadata.agent || 'Unknown'}.${result.metadata.mode || 'Unknown'}`;
  }

  protected generateSubtitle(result: MemorySearchResult): string | undefined {
    const metadata = result.metadata;
    const parts: string[] = [];

    if (metadata.type) {
      parts.push(metadata.type);
    }

    if (metadata.success !== undefined) {
      parts.push(metadata.success ? 'SUCCESS' : 'FAILED');
    }

    if (metadata.executionTime) {
      parts.push(`${metadata.executionTime}ms`);
    }

    if (metadata.filesReferenced && metadata.filesReferenced.length > 0) {
      parts.push(`${metadata.filesReferenced.length} files`);
    }

    return parts.length > 0 ? parts.join(' • ') : undefined;
  }

  protected enhanceContent(content: string, result: MemorySearchResult, options: FormatOptions): string {
    if (!this.configuration.enableToolCallEnhancement || options.enhanceToolCallContext === false) {
      return content;
    }

    const metadata = result.metadata;
    const prefix = `[${metadata.agent || 'Unknown'}.${metadata.mode || 'Unknown'}]`;
    const status = metadata.success ? 'SUCCESS' : 'FAILED';
    const timing = metadata.executionTime ? ` (${metadata.executionTime}ms)` : '';

    return `${prefix} ${content} [${status}${timing}]`;
  }

  protected addTypeSpecificMetadata(formatted: Record<string, string>, metadata: any): void {
    if (metadata.agent && metadata.mode) {
      formatted['Tool'] = `${metadata.agent}_${metadata.mode}`;
    }
    if (metadata.executionTime) {
      formatted['Execution Time'] = `${metadata.executionTime}ms`;
    }
    if (metadata.success !== undefined) {
      formatted['Status'] = metadata.success ? 'Success' : 'Failed';
    }
    if (metadata.filesReferenced && metadata.filesReferenced.length > 0) {
      formatted['Files'] = metadata.filesReferenced.join(', ');
    }
  }
}
