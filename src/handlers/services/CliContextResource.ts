import type { SessionContextManager } from '../../services/SessionContextManager';
import { CLI_DEFAULT_SESSION_HANDLE } from '../strategies/ToolExecutionStrategy';

/**
 * `nexus context` (#214, docs/plans/session-sticky-context-plan.md PR 2):
 * what this vault currently remembers for the CLI — the current session
 * handle and the workspace that handle is bound to.
 *
 * Served as an MCP RESOURCE at a fixed, unlisted URI rather than as a third
 * tool or a custom JSON-RPC method: `resources/read` already exists on every
 * connection, the two-tool contract (`getTools`/`useTools`) stays fixed, and
 * a read has no side effects to gate. It is not returned by `resources/list`
 * — the URI is for the CLI, not a document for MCP clients to browse.
 */
export const NEXUS_CONTEXT_RESOURCE_URI = 'nexus://context';

export interface CliContextSnapshot {
  /** Sanitized vault name — the value `--vault` accepts. */
  vault: string | null;
  /** What a CLI call with no `--session` runs as when nothing is remembered. */
  defaultSessionHandle: string;
  /** Null until the CLI has chosen a session with `--session` once. */
  cliSession: {
    /** The handle the CLI typed and will present again. */
    handle: string;
    /** The display name it resolved to (differs when renamed to `<handle>-2`), if the manager has seen it. */
    displaySessionId: string | null;
    /** The handle's last deliberate workspace bind; null means UNBOUND. */
    workspace: { id: string; name?: string } | null;
  } | null;
}

/**
 * Read-only. Never creates a session, never binds anything, never touches
 * the store beyond waiting for the restore that `setBindingsStore` started.
 */
export async function buildCliContextSnapshot(
  manager: SessionContextManager | undefined,
  vaultName: string | undefined
): Promise<CliContextSnapshot> {
  const snapshot: CliContextSnapshot = {
    vault: vaultName ?? null,
    defaultSessionHandle: CLI_DEFAULT_SESSION_HANDLE,
    cliSession: null
  };
  if (!manager) {
    return snapshot;
  }

  await manager.ensureBindingsRestored();
  const handle = manager.getCliCurrentSession();
  if (!handle) {
    return snapshot;
  }

  const boundWorkspaceId = manager.resolveHandleWorkspace(handle);
  const workspace = boundWorkspaceId ? await manager.describeWorkspace(boundWorkspaceId) : null;
  // The handle is partitioned under its bound workspace, or 'default' while
  // unbound — the same key processSession uses, so this finds the same entry.
  const described = manager.describeHandle(handle, boundWorkspaceId ?? 'default');

  snapshot.cliSession = {
    handle,
    displaySessionId: described?.displaySessionId ?? null,
    workspace
  };
  return snapshot;
}
