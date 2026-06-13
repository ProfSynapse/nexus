/**
 * Memory Types
 * Extracted from workspace-types.ts for better organization
 * Uses simplified JSON-based storage
 */

/**
 * Minimal set of fields recorded for every tool call trace.
 */
export interface TraceToolMetadata {
  id: string;
  agent: string;
  mode: string;
  callId?: string;
  pluginVersion?: string;
}

/**
 * Legacy context object - kept for backward compatibility with existing traces.
 * New traces should use TraceContextMetadataV2.
 */
export interface LegacyTraceContextMetadata {
  workspaceId: string;
  sessionId: string;
  sessionDescription?: string;
  sessionMemory?: string;
  toolContext?: Record<string, unknown>;
  primaryGoal?: string;
  subgoal?: string;
  tags?: string[];
  additionalContext?: Record<string, unknown>;
}

/**
 * New context schema for two-tool architecture.
 * Uses memory/goal/constraints instead of the verbose legacy fields.
 * This schema is designed for:
 * - Context efficiency (local models with small context windows)
 * - Memory → Goal → Constraints flow (each informs the next)
 * - Queryable through searchMemory for later reference
 */
export interface TraceContextMetadataV2 {
  /** Workspace scope identifier */
  workspaceId: string;

  /** Session identifier for tracking */
  sessionId: string;

  /** Compressed essence of conversation (1-3 sentences) */
  memory: string;

  /** Current objective informed by memory (1-3 sentences) */
  goal: string;

  /** Optional model-facing session display name */
  sessionName?: string;

  /** Optional rules/limits to follow (1-3 sentences) */
  constraints?: string;

  /** Optional tags for categorization */
  tags?: string[];
}

/**
 * Union type that accepts both legacy and new context formats.
 * Use `isNewTraceContextFormat()` to determine which version.
 */
export type TraceContextMetadata = LegacyTraceContextMetadata | TraceContextMetadataV2;

/**
 * Type guard to check if context is the new V2 format.
 * New format has 'memory' and 'goal' fields.
 */
export function isNewTraceContextFormat(context: TraceContextMetadata): context is TraceContextMetadataV2 {
  return 'memory' in context && 'goal' in context;
}

/**
 * Type guard to check if context is the legacy format.
 */
export function isLegacyTraceContextFormat(context: TraceContextMetadata): context is LegacyTraceContextMetadata {
  return !isNewTraceContextFormat(context);
}

/**
 * Tool input parameters that should be preserved for future reference.
 */
export interface TraceInputMetadata {
  arguments?: unknown;
  files?: string[];
  notes?: string;
}

/**
 * A single candidate returned by a retrieval tool (search). `path` is the
 * canonical identifier (note path, state id, conversation pair id, etc.).
 * `score` is captured when the tool exposes one (often absent — e.g. semantic
 * `searchContent` strips its internal distance from the public result).
 */
export interface RetrievalCandidate {
  path: string;
  score?: number;
}

/**
 * Retrieval feedback substrate (Phase 0 of the self-improving retrieval
 * adapter). When a search tool succeeds, we persist the candidate set it
 * returned plus a stable `groupId`. The relevance LABEL is NOT captured here —
 * it is mined later by joining a follow-up "use" of a candidate (a `read` /
 * `loadState` / cite, or an in-session task completion) within the same
 * session. Keeping capture to candidates-only keeps the surface minimal and
 * the join in the (offline, "dreaming") miner.
 */
export interface RetrievalOutcomeMetadata {
  /** Stable id for this retrieval instance; the miner keys feedback on it. */
  groupId: string;
  /** Returned candidate set, capped (see RETRIEVAL_CANDIDATE_CAP). */
  candidates: RetrievalCandidate[];
}

/**
 * Outcome of the tool call. We only persist the durable signal (success/error)
 * instead of large response payloads.
 */
export interface TraceOutcomeMetadata {
  success: boolean;
  error?: {
    type?: string;
    message: string;
    code?: string | number;
  };
  /** Present only for successful retrieval (search) tools — see RetrievalOutcomeMetadata. */
  retrieval?: RetrievalOutcomeMetadata;
}

/**
 * Legacy blobs that we keep during migration for backward compatibility.
 */
export interface TraceLegacyMetadata {
  params?: unknown;
  result?: unknown;
  relatedFiles?: string[];
}

/**
 * Legacy metadata shape retained for compatibility with older callers.
 */
export interface LegacyWorkspaceTraceMetadata {
  tool?: string;
  params?: unknown;
  result?: unknown;
  relatedFiles?: string[];
  request?: Record<string, unknown>;
  response?: Record<string, unknown>;
  execution?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Canonical metadata structure saved with each memory trace.
 */
export interface TraceMetadata {
  schemaVersion: number;
  tool: TraceToolMetadata;
  context: TraceContextMetadata;
  input?: TraceInputMetadata;
  outcome: TraceOutcomeMetadata;
  legacy?: TraceLegacyMetadata;
  /** Index signature for Record<string, unknown> compatibility */
  [key: string]: unknown;
}

/**
 * Memory trace for workspace activity
 * Records tool interactions for JSON-based storage and search
 */
export interface WorkspaceMemoryTrace {
  /**
   * Unique identifier
   */
  id: string;

  /**
   * Associated workspace ID
   */
  workspaceId: string;

  /**
   * When this interaction occurred
   */
  timestamp: number;

  /**
   * Type of memory trace interaction
   */
  type: string;

  /**
   * The actual interaction content
   */
  content: string;

  /**
   * Additional information about the interaction
   */
  metadata?: TraceMetadata | LegacyWorkspaceTraceMetadata;

  /**
   * Associated session ID (if created during a session)
   */
  sessionId?: string;
}
