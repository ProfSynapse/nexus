/**
 * StateResultFormatter - Specialized formatter for state results
 * Location: /src/agents/searchManager/services/formatters/StateResultFormatter.ts
 *
 * Handles formatting of state memory results with state identification
 * and context information.
 *
 * Used by: ResultFormatter for STATE type results
 */

import { MemoryResultMetadata, MemorySearchResult } from '../../../../types/memory/MemorySearchTypes';
import { BaseResultFormatter } from './BaseResultFormatter';

type StateResultMetadata = MemoryResultMetadata & {
  stateId?: string;
  snapshotId?: string;
  version?: string | number;
};

/**
 * Formatter for state results
 */
export class StateResultFormatter extends BaseResultFormatter {
  protected generateTitle(result: MemorySearchResult): string {
    return `State: ${result.id}`;
  }

  protected addTypeSpecificMetadata(formatted: Record<string, string>, metadata: MemoryResultMetadata): void {
    const stateMetadata = metadata as StateResultMetadata;
    const stateId = stateMetadata.stateId ?? stateMetadata.snapshotId;

    // Support both legacy and new property names
    if (stateId) {
      formatted['State ID'] = stateId;
    }
    if (stateMetadata.version) {
      formatted['Version'] = stateMetadata.version.toString();
    }
  }
}
