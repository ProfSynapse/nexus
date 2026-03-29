/**
 * TraceResultFormatter - Specialized formatter for trace results
 * Location: /src/agents/searchManager/services/formatters/TraceResultFormatter.ts
 *
 * Handles formatting of trace memory results (default/fallback formatter).
 *
 * Used by: ResultFormatter for TRACE type results and as fallback
 */

import { MemorySearchResult } from '../../../../types/memory/MemorySearchTypes';
import { BaseResultFormatter } from './BaseResultFormatter';

function getTraceType(metadata: Record<string, unknown>): string | undefined {
  return typeof metadata.traceType === 'string' ? metadata.traceType : undefined;
}

/**
 * Formatter for trace results (default formatter)
 */
export class TraceResultFormatter extends BaseResultFormatter {
  protected generateTitle(result: MemorySearchResult): string {
    return `Memory Trace: ${result.id}`;
  }

  protected addTypeSpecificMetadata(formatted: Record<string, string>, metadata: Record<string, unknown>): void {
    const traceType = getTraceType(metadata);
    if (traceType) {
      formatted['Trace Type'] = traceType;
    }
  }
}
