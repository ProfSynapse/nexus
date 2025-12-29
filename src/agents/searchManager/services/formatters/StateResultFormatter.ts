/**
 * StateResultFormatter - Specialized formatter for state results
 * Location: /src/agents/searchManager/services/formatters/StateResultFormatter.ts
 *
 * Handles formatting of state memory results with state identification
 * and context information.
 *
 * Used by: ResultFormatter for STATE type results
 */

import { MemorySearchResult } from '../../../../types/memory/MemorySearchTypes';
import { BaseResultFormatter } from './BaseResultFormatter';

/**
 * Formatter for state results
 */
export class StateResultFormatter extends BaseResultFormatter {
  protected generateTitle(result: MemorySearchResult): string {
    return `State: ${result.id}`;
  }

  protected addTypeSpecificMetadata(formatted: Record<string, string>, metadata: any): void {
    // Support both legacy and new property names
    if (metadata.stateId || metadata.snapshotId) {
      formatted['State ID'] = metadata.stateId || metadata.snapshotId;
    }
    if (metadata.version) {
      formatted['Version'] = metadata.version.toString();
    }
  }
}
