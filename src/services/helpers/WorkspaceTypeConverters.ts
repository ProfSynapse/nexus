// Location: src/services/helpers/WorkspaceTypeConverters.ts
// Type conversion helpers between HybridStorageTypes and StorageTypes for workspaces.
// Extracted from WorkspaceService to reduce file size and isolate conversion logic.
// Used by: WorkspaceService

import { WorkspaceMetadata } from '../../types/storage/StorageTypes';
import * as HybridTypes from '../../types/storage/HybridStorageTypes';

/**
 * Convert HybridStorageTypes.WorkspaceMetadata to StorageTypes.WorkspaceMetadata
 */
export function convertWorkspaceMetadata(hybrid: HybridTypes.WorkspaceMetadata): WorkspaceMetadata {
  return {
    id: hybrid.id,
    name: hybrid.name,
    description: hybrid.description,
    rootFolder: hybrid.rootFolder,
    created: hybrid.created,
    lastAccessed: hybrid.lastAccessed,
    isActive: hybrid.isActive,
    isArchived: hybrid.isArchived,
    sessionCount: 0, // Will be calculated if needed
    traceCount: 0    // Will be calculated if needed
  };
}
