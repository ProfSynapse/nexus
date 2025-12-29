/**
 * SessionResultFormatter - Specialized formatter for session results
 * Location: /src/agents/searchManager/services/formatters/SessionResultFormatter.ts
 *
 * Handles formatting of session memory results with session identification
 * and contextual information.
 *
 * Used by: ResultFormatter for SESSION type results
 */

import { MemorySearchResult } from '../../../../types/memory/MemorySearchTypes';
import { BaseResultFormatter } from './BaseResultFormatter';

/**
 * Formatter for session results
 */
export class SessionResultFormatter extends BaseResultFormatter {
  protected generateTitle(result: MemorySearchResult): string {
    return `Session: ${result.metadata.sessionId || 'Unknown'}`;
  }

  protected addTypeSpecificMetadata(formatted: Record<string, string>, metadata: any): void {
    if (metadata.purpose) {
      formatted['Purpose'] = metadata.purpose;
    }
    if (metadata.tags && metadata.tags.length > 0) {
      formatted['Tags'] = metadata.tags.join(', ');
    }
  }
}
