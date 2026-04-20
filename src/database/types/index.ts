/**
 * Database Types Export Barrel
 * Provides centralized access to all database-related types
 * Organized by domain for better maintainability
 */

// Workspace types
export type {
  ItemStatus,
  ProjectWorkspace
} from './workspace/WorkspaceTypes';

export type {
  WorkspaceParameters,
  WorkspaceResult,
  ListWorkspacesParameters,
  ListWorkspacesResult,
  CreateWorkspaceParameters,
  CreateWorkspaceResult,
  EditWorkspaceParameters,
  DeleteWorkspaceParameters,
  LoadWorkspaceParameters,
  LoadWorkspaceResult,
  AddFilesToWorkspaceParameters,
  AddFilesToWorkspaceResult,
  QuickCreateWorkspaceParameters
} from './workspace/ParameterTypes';

// Session types
export type {
  WorkspaceSession,
  StateContext,
  State,
  WorkspaceState
} from './session/SessionTypes';

// Memory types
export type {
  WorkspaceMemoryTrace,
  TraceMetadata,
  TraceToolMetadata,
  TraceContextMetadata,
  TraceInputMetadata,
  TraceOutcomeMetadata,
  TraceLegacyMetadata,
  LegacyWorkspaceTraceMetadata
} from './memory/MemoryTypes';

// Cache types
export type {
  WorkspaceCache
} from './cache/CacheTypes';
