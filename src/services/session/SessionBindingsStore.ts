import type { DataAdapter } from 'obsidian';
import { logger } from '../../utils/logger';

/**
 * A friendly session handle's mapping to its internal session. Mirrors the
 * `sessionHandleMap` entry shape in SessionContextManager.
 */
export interface PersistedSessionHandle {
  id: string;
  displaySessionId: string;
  workspaceId: string;
}

/**
 * The on-disk shape of `session-bindings.json` (see
 * docs/plans/session-sticky-context-plan.md, "Where the state lives").
 *
 * - `handles` is keyed `"<workspaceId>::<handle>"`, exactly like the in-memory
 *   partition map, so a returning handle resumes its session across a plugin
 *   reload instead of being renamed `<handle>-2`.
 * - `handleWorkspace` records the LAST DELIBERATE workspace bind per handle
 *   (#214). It is written only by an explicit `workspaceId` on a successful
 *   call or a successful `memory load-workspace` — never by trace capture.
 *
 * PR 2 of the plan adds a `cliCurrentSession` slot beside these two. The
 * parser ignores keys it does not know, so adding one is a shape extension,
 * not a migration.
 */
export interface PersistedSessionBindings {
  handles: Record<string, PersistedSessionHandle>;
  handleWorkspace: Record<string, string>;
}

/**
 * Where SessionContextManager keeps its bindings between reloads. Kept as an
 * interface so unit tests can hand the manager an in-memory store and the
 * manager never learns about paths or adapters.
 */
export interface SessionBindingsStore {
  load(): Promise<PersistedSessionBindings | null>;
  save(doc: PersistedSessionBindings): Promise<void>;
}

export const SESSION_BINDINGS_FILE_NAME = 'session-bindings.json';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Shape-check a parsed document field by field. A corrupt or foreign file
 * must degrade to "pass it once again", never to a throw at service init —
 * this store is bookkeeping, and losing it costs one extra `workspaceId`
 * per session, not data.
 */
export function parsePersistedSessionBindings(raw: unknown): PersistedSessionBindings | null {
  if (!isRecord(raw)) {
    return null;
  }

  const handles: Record<string, PersistedSessionHandle> = {};
  if (isRecord(raw.handles)) {
    for (const [key, value] of Object.entries(raw.handles)) {
      if (
        isRecord(value)
        && typeof value.id === 'string' && value.id.length > 0
        && typeof value.displaySessionId === 'string' && value.displaySessionId.length > 0
        && typeof value.workspaceId === 'string' && value.workspaceId.length > 0
      ) {
        handles[key] = {
          id: value.id,
          displaySessionId: value.displaySessionId,
          workspaceId: value.workspaceId
        };
      }
    }
  }

  const handleWorkspace: Record<string, string> = {};
  if (isRecord(raw.handleWorkspace)) {
    for (const [handle, workspaceId] of Object.entries(raw.handleWorkspace)) {
      if (typeof workspaceId === 'string' && workspaceId.trim().length > 0) {
        handleWorkspace[handle] = workspaceId;
      }
    }
  }

  return { handles, handleWorkspace };
}

/**
 * File-backed store on the vault adapter. The path is resolved by the caller
 * (`resolvePluginStorageRoot(app, plugin).dataRoot`); this class never
 * composes a storage root itself. Uses `app.vault.adapter` rather than Node
 * `fs` because the plugin runs on mobile.
 */
export class VaultSessionBindingsStore implements SessionBindingsStore {
  constructor(
    private readonly adapter: DataAdapter,
    private readonly path: string
  ) {}

  async load(): Promise<PersistedSessionBindings | null> {
    try {
      if (!(await this.adapter.exists(this.path))) {
        return null;
      }
      const text = await this.adapter.read(this.path);
      const parsed = parsePersistedSessionBindings(JSON.parse(text));
      if (!parsed) {
        logger.systemWarn(`[SessionBindingsStore] ${this.path} is not a bindings document; starting empty`);
      }
      return parsed;
    } catch (error) {
      // JSON.parse on a half-written file lands here too. Starting empty is
      // the correct recovery: the next deliberate bind rewrites the file.
      logger.systemWarn(
        `[SessionBindingsStore] Could not read ${this.path}: ${error instanceof Error ? error.message : String(error)}`
      );
      return null;
    }
  }

  async save(doc: PersistedSessionBindings): Promise<void> {
    try {
      const parent = this.path.substring(0, this.path.lastIndexOf('/'));
      if (parent && !(await this.adapter.exists(parent))) {
        await this.adapter.mkdir(parent);
      }
      await this.adapter.write(this.path, JSON.stringify(doc, null, 2));
    } catch (error) {
      logger.systemWarn(
        `[SessionBindingsStore] Could not write ${this.path}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}
