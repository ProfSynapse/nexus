/**
 * Location: src/database/repositories/base/workspaceStreamPath.ts
 *
 * Repository-boundary guard for workspace-keyed event streams (#214).
 *
 * Four repositories mint a JSONL path directly from a caller-supplied
 * workspaceId — `workspaces/ws_<id>.jsonl` (session/state/trace/workspace) and
 * `tasks/tasks_<id>.jsonl` (task/project, whose `jsonlPath` parameter is a
 * workspaceId despite the file name). Until now nothing between the caller and
 * that mint checked the id, so any string became a directory on disk, silently
 * and permanently: a flag name that leaked in as a value (`ws_--workspaceId`),
 * the empty id (`ws_`), a path fragment.
 *
 * Scope, deliberately: this is a STRUCTURAL guard, not a workspace lookup. It
 * rejects strings that can never be a legitimate workspace id OR a legitimate
 * workspace name, and nothing else. It does NOT ask whether the workspace
 * exists — that check needs the live list, lives at the envelope
 * (`ToolBatchExecutionService.validateWorkspaceId`), and cannot move down here
 * without making every repository depend on the service that owns one of them.
 * So a well-formed id for a workspace that does not exist still passes; a
 * truncated or zero-filled UUID is indistinguishable from a short real id at
 * this layer and is the envelope's job.
 *
 * Names are accepted on purpose. A caller may legitimately hold a workspace
 * NAME (the envelope accepts one), and names contain spaces, accents and
 * punctuation. Rejecting those here would turn a working call into a hard
 * error, so only characters that break the path itself are refused.
 *
 * Related files:
 * - src/database/repositories/base/BaseRepository.ts - writeEvent / jsonlPath
 * - src/agents/toolManager/services/ToolBatchExecutionService.ts - envelope guard
 * - src/agents/toolManager/services/ToolCliNormalizer.ts - envelope requiredness
 */

/** Longest id we will turn into a path segment. Filenames cap near 255 bytes. */
const MAX_WORKSPACE_ID_LENGTH = 200;

/**
 * Why an id can never be part of a path, or null when it is fine.
 *
 * The PATH-SAFETY tier, enforced on every mint including removals: these are the
 * strings that would escape the stream directory or corrupt the filename, as
 * opposed to merely being an implausible workspace.
 */
function describePathUnsafeWorkspaceId(workspaceId: unknown): string | null {
  if (typeof workspaceId !== 'string') {
    return `expected a string, got ${workspaceId === null ? 'null' : Array.isArray(workspaceId) ? 'array' : typeof workspaceId}`;
  }
  // eslint-disable-next-line no-control-regex -- matching control characters is the point: they must never reach a filename
  if (/[\x00-\x1f\x7f]/.test(workspaceId)) {
    return 'it contains control characters';
  }
  if (workspaceId.includes('/') || workspaceId.includes('\\')) {
    return 'it contains a path separator';
  }
  // normalizePath() does not strip "..", so confinement needs an explicit guard.
  if (workspaceId === '.' || workspaceId === '..' || workspaceId.includes('..')) {
    return 'it contains a path traversal segment';
  }
  return null;
}

/**
 * Why an id is not a legitimate workspace, or null when it is fine.
 *
 * The WRITE tier. Every reason here describes a string that IS a usable path
 * segment but can never name a real workspace, so minting a NEW stream from it
 * would create exactly the phantom directories this module exists to prevent.
 * Removal deliberately does not apply this tier — see `assertPathSafeWorkspaceId`.
 */
function describeUnconventionalWorkspaceId(workspaceId: string): string | null {
  if (workspaceId.length === 0) {
    return 'it is empty';
  }
  if (workspaceId.trim().length === 0) {
    return 'it is blank';
  }
  if (workspaceId !== workspaceId.trim()) {
    return 'it has leading or trailing whitespace';
  }
  // A leaked CLI flag name (`--workspaceId`, `--id`) is the census class that
  // proved an argument name can travel all the way to the storage layer as a
  // value. No workspace is named with a leading dash.
  if (workspaceId.startsWith('-')) {
    return 'it looks like a command-line flag, not a workspace';
  }
  if (workspaceId.length > MAX_WORKSPACE_ID_LENGTH) {
    return `it is longer than ${MAX_WORKSPACE_ID_LENGTH} characters`;
  }
  return null;
}

/**
 * Why an id is unusable for a WRITE, or null when it is fine.
 * Both tiers: path safety first, then workspace plausibility.
 * Exported for tests; production callers use assertUsableWorkspaceId.
 */
export function describeUnusableWorkspaceId(workspaceId: unknown): string | null {
  const unsafe = describePathUnsafeWorkspaceId(workspaceId);
  if (unsafe !== null) return unsafe;
  return describeUnconventionalWorkspaceId(workspaceId as string);
}

/** Shared error shape, so a refusal reads the same wherever it is raised. */
function refuse(workspaceId: unknown, entityType: string, reason: string, verb: string): never {
  const shown = typeof workspaceId === 'string' ? `"${workspaceId}"` : String(workspaceId);
  throw new Error(
    `Refusing to ${verb} ${entityType} events under workspace ${shown}: ${reason}. `
    + 'Pass "default" for the global workspace, or an exact workspace name or id.'
  );
}

/**
 * Throw unless `workspaceId` can safely become a path segment AND could plausibly
 * be a real workspace. This is the guard for everything that WRITES.
 * @param workspaceId - Caller-supplied workspace identifier (id or name)
 * @param entityType - Repository entity type, for the error message
 * @returns The same id, narrowed to string
 */
export function assertUsableWorkspaceId(workspaceId: unknown, entityType: string): string {
  const reason = describeUnusableWorkspaceId(workspaceId);
  if (reason !== null) refuse(workspaceId, entityType, reason, 'store');
  return workspaceId as string;
}

/**
 * Throw only if `workspaceId` cannot safely become a path segment.
 *
 * The REMOVAL guard. A permanent delete has to be able to address a stream that
 * is already on disk, and the streams most in need of removal are precisely the
 * malformed ones this module now refuses to create — `ws_--workspaceId`, `ws_`,
 * the padded and the over-long. Applying the write tier to a delete would make
 * every pre-existing phantom permanently undeletable and would stop
 * `WorkspaceRepository.delete` before it ever reached `workspaceOwnedStreamPaths`,
 * so the whole #347 purge would be dead code for exactly the vaults that need it.
 *
 * Path safety is still enforced, and that is a tightening rather than a
 * loosening: a traversal id used to reach `deleteStream` unchecked.
 *
 * @param workspaceId - Workspace identifier of a stream being removed
 * @param entityType - Repository entity type, for the error message
 * @returns The same id, narrowed to string
 */
export function assertPathSafeWorkspaceId(workspaceId: unknown, entityType: string): string {
  const reason = describePathUnsafeWorkspaceId(workspaceId);
  if (reason !== null) refuse(workspaceId, entityType, reason, 'remove');
  return workspaceId as string;
}

/** `workspaces/ws_<id>.jsonl` — session, state, trace and workspace streams. */
export function workspaceStreamPath(workspaceId: unknown, entityType: string): string {
  return `workspaces/ws_${assertUsableWorkspaceId(workspaceId, entityType)}.jsonl`;
}

/** `tasks/tasks_<workspaceId>.jsonl` — task and project streams. */
export function taskStreamPath(workspaceId: unknown, entityType: string): string {
  return `tasks/tasks_${assertUsableWorkspaceId(workspaceId, entityType)}.jsonl`;
}

/**
 * `workspaces/ws_<id>.jsonl` for a stream being REMOVED, not written.
 *
 * Same template as `workspaceStreamPath`, path-safety tier only, so a permanent
 * delete can still address a malformed stream that predates the write guard.
 */
export function workspaceStreamPathForRemoval(workspaceId: unknown, entityType: string): string {
  return `workspaces/ws_${assertPathSafeWorkspaceId(workspaceId, entityType)}.jsonl`;
}
