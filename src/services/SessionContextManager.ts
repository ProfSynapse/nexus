import { CommonResult } from '../types';
import type { SessionData } from './session/SessionService';
import type {
  PersistedSessionBindings,
  PersistedSessionHandle,
  SessionBindingsStore
} from './session/SessionBindingsStore';
import { logger } from '../utils/logger';
import { parseWorkspaceContext } from '../utils/contextUtils';
import { generateSessionId, isStandardSessionId } from '../utils/sessionUtils';

/**
 * Interface for workspace context
 */
export interface WorkspaceContext {
  workspaceId: string;
  workspacePath?: string[];
  activeWorkspace?: boolean;
  // For type-completeness only — the per-session active-skill set is NOT stored
  // here. The frequent `setWorkspaceContext({workspaceId})` call at
  // ToolCallTraceService:88 would clobber it. Storage lives in the dedicated
  // `sessionActiveSkillsMap` instead (see getActiveSkills/addActiveSkill below).
  activeSkills?: string[];
}

interface SessionServiceLike {
  getSession(sessionId: string): Promise<SessionData | null> | SessionData | null;
  getAllSessions?(workspaceId?: string): Promise<SessionData[]> | SessionData[];
  createSession(sessionData: {
    name: string;
    description: string;
    workspaceId: string;
    id: string;
  }): Promise<unknown> | void;
  updateSession(sessionData: SessionData): Promise<unknown> | void;
  registerOnSessionDeleted?(listener: SessionDeletedListener): () => void;
}

export type SessionDeletedListener = (sessionId: string, workspaceId: string) => void;

/**
 * The slice of WorkspaceService the manager needs to turn a caller-supplied
 * workspace name into its canonical id. Structural so tests can stub it and
 * so this file does not import the (heavy) WorkspaceService module.
 */
export interface WorkspaceResolverLike {
  getWorkspaceByNameOrId(identifier: string): Promise<{ id: string; name?: string } | null>;
}

export interface SessionValidationResult {
  id: string;
  created: boolean;
  displaySessionId: string;
  displaySessionIdChanged: boolean;
}

/**
 * Outcome of resolving which workspace a tool call runs in (#214).
 * `explicit` is true only when the caller named the workspace on THIS call;
 * a value inherited from an earlier bind is not a new decision and must not
 * re-bind (see ToolExecutionStrategy bind point 1).
 */
export interface SessionWorkspaceResolution {
  workspaceId?: string;
  explicit: boolean;
}

/** The global workspace id is not a name to look up — it passes through. */
const GLOBAL_WORKSPACE_ID = 'default';

/**
 * SessionContextManager
 * 
 * Provides a centralized service for managing and persisting workspace context
 * across tool calls within sessions. This helps maintain context continuity
 * without requiring explicit context passing between every operation.
 */
export class SessionContextManager {
  // Reference to session service for database validation
  private sessionService: SessionServiceLike | null = null;
  
  // Map of sessionId -> workspace context
  private sessionContextMap: Map<string, WorkspaceContext> = new Map();

  // Map of sessionId -> active skill ids (e.g. "claude/essay-editor").
  // Dedicated map (NOT folded into WorkspaceContext) so the frequent
  // setWorkspaceContext({workspaceId}) call at ToolCallTraceService:88 cannot
  // clobber it. Used for trace attribution only (§9) — it does NOT scope or
  // route tools, unlike workspaceId.
  private sessionActiveSkillsMap: Map<string, string[]> = new Map();

  // Map of model-facing session handles to internal unique session IDs.
  // Keyed by `${workspaceId}::${handle}` so the same friendly handle ("research")
  // in different workspaces resolves to distinct internal sessions instead of
  // aliasing — workspaces are UX scoping, and reusing names across them is
  // expected. The map stores the originating workspaceId so eviction on session
  // delete (registerOnSessionDeleted) can purge both the input handle entry and
  // the display-name entry without scanning the whole map.
  private sessionHandleMap: Map<string, { id: string; displaySessionId: string; workspaceId: string }> = new Map();

  // Handle entries restored from session-bindings.json that have not yet been
  // checked against storage. On the handle's first use
  // `sessionService.getAllSessions(entry.workspaceId)` is consulted once; the
  // entry is KEPT either way — a miss re-creates the session record with the
  // same id (best-effort) rather than minting a new one. The check is lazy
  // rather than at service init because storage is cold during startup
  // hydration, and it cannot be allowed to drop anything for the same reason:
  // a call a few seconds after reload saw an empty list and renumbered a live
  // session (see verifyRestoredHandle). What the check still buys is the
  // display-name uniqueness pass in createUniqueSessionDisplayName, which
  // skips unverified entries so a stale name never forces a `-2`.
  private unverifiedHandleKeys: Set<string> = new Set();

  // Handle → workspace id of the LAST DELIBERATE bind (#214). Distinct from
  // `sessionContextMap`, which ToolCallTraceService.captureToolCall overwrites
  // on every call — including unbound discovery calls that ran under
  // 'default' — so that map records where traces went, not what the caller
  // chose. Only bindHandleWorkspace / bindSessionWorkspaceById write here.
  private handleWorkspace: Map<string, string> = new Map();

  // The session handle the CLI last chose with an explicit `--session` on a
  // successful call — "where the CLI left off" in this vault. A CLI call with
  // no `--session` continues it (ToolExecutionStrategy bind point 3). Null
  // until the CLI has chosen once; the `'nexus-cli'` fallback the strategy
  // applies in that case is a default, not a choice, and never lands here.
  // MCP clients and native chat never read or write this.
  private cliCurrentSession: string | null = null;

  // Canonicalises workspace names to ids before a bind or partition, the same
  // way ToolCallTraceService.resolveWorkspaceId does for traces, so a session's
  // sessions, states and traces land in one store whether the caller passed
  // the name or the id.
  private workspaceResolver: WorkspaceResolverLike | null = null;

  // Persistence for handles + handleWorkspace. Null in tests and before wiring;
  // every store operation is best-effort and degrades to "pass it once again".
  private bindingsStore: SessionBindingsStore | null = null;
  private bindingsRestore: Promise<void> | null = null;

  // Write-through with in-flight coalescing, deliberately NOT a timer. A
  // debounced `window.setTimeout` sat pending for minutes while Obsidian was
  // in the background — Electron throttles background renderer timers, and the
  // CLI is used precisely when Obsidian is not focused — so the file lagged
  // the in-memory state and a quit in that window lost the bind. Instead: a
  // change with no write in flight starts one now; a change during a write
  // sets `bindingsDirty`, and the writer runs once more when it settles. Each
  // write snapshots the state as it is when that write starts, so a burst
  // collapses to at most two writes and the file always ends current.
  private bindingsWrite: Promise<void> | null = null;
  private bindingsDirty = false;

  // Disposer for the session-deleted subscription so re-wiring or teardown can
  // unregister cleanly.
  private sessionDeletedUnsubscribe: (() => void) | null = null;
  
  // Default workspace context for new sessions (global)
  private defaultWorkspaceContext: WorkspaceContext | null = null;
  
  // Set of session IDs that have already received instructions
  private instructedSessions: Set<string> = new Set();
  
  /**
   * Set the session service for database validation
   * This is called during plugin initialization
   */
  setSessionService(sessionService: SessionServiceLike): void {
    if (this.sessionDeletedUnsubscribe) {
      this.sessionDeletedUnsubscribe();
      this.sessionDeletedUnsubscribe = null;
    }
    this.sessionService = sessionService;
    if (sessionService.registerOnSessionDeleted) {
      this.sessionDeletedUnsubscribe = sessionService.registerOnSessionDeleted(
        (sessionId, workspaceId) => this.evictSessionHandles(sessionId, workspaceId)
      );
    }
  }

  /**
   * Wire the workspace lookup used to canonicalise names to ids. Optional: with
   * no resolver, values bind and partition as given (the batch service still
   * rejects unknown ones with its existing steer).
   */
  setWorkspaceResolver(resolver: WorkspaceResolverLike | null): void {
    this.workspaceResolver = resolver;
  }

  /**
   * Wire the persistence store and start restoring what it holds. Restoration
   * is awaited by the first `validateSessionId` / `resolveWorkspaceForSession`
   * call, so callers never race the read; a failed read logs and leaves the
   * manager empty.
   */
  setBindingsStore(store: SessionBindingsStore | null): void {
    this.bindingsStore = store;
    this.bindingsRestore = store ? this.restorePersistedBindings(store) : null;
  }

  /** Resolves once the persisted bindings (if any) are loaded into memory. */
  async ensureBindingsRestored(): Promise<void> {
    if (this.bindingsRestore) {
      await this.bindingsRestore;
    }
  }

  private async restorePersistedBindings(store: SessionBindingsStore): Promise<void> {
    let doc: PersistedSessionBindings | null = null;
    try {
      doc = await store.load();
    } catch (error) {
      logger.systemWarn(`Session bindings restore failed: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    if (!doc) {
      return;
    }

    for (const [key, entry] of Object.entries(doc.handles)) {
      // Never let a stale file clobber a handle the live process already
      // created — the in-memory entry is newer by definition.
      if (!this.sessionHandleMap.has(key)) {
        this.sessionHandleMap.set(key, { ...entry });
        this.unverifiedHandleKeys.add(key);
      }
    }
    for (const [handle, workspaceId] of Object.entries(doc.handleWorkspace)) {
      if (!this.handleWorkspace.has(handle)) {
        this.handleWorkspace.set(handle, workspaceId);
      }
    }
    if (this.cliCurrentSession === null && doc.cliCurrentSession) {
      this.cliCurrentSession = doc.cliCurrentSession;
    }
  }

  private snapshotBindings(): PersistedSessionBindings {
    const handles: Record<string, PersistedSessionHandle> = {};
    for (const [key, entry] of this.sessionHandleMap.entries()) {
      handles[key] = { id: entry.id, displaySessionId: entry.displaySessionId, workspaceId: entry.workspaceId };
    }
    return {
      handles,
      handleWorkspace: Object.fromEntries(this.handleWorkspace.entries()),
      cliCurrentSession: this.cliCurrentSession
    };
  }

  /** The handle the CLI last chose with `--session`, or null if it never has. */
  getCliCurrentSession(): string | null {
    return this.cliCurrentSession;
  }

  /**
   * Bind point 3 (#214): remember the handle an explicit `--session` named
   * once the call succeeded. Switching is the same gesture as choosing — pass
   * a different value once. Idempotent so the every-call case costs no write.
   */
  setCliCurrentSession(handle: string): void {
    const trimmed = handle.trim();
    if (!trimmed) {
      logger.systemWarn('Attempted to set the CLI current session to an empty handle');
      return;
    }
    if (this.cliCurrentSession === trimmed) {
      return;
    }
    this.cliCurrentSession = trimmed;
    logger.systemLog(`CLI current session is now "${trimmed}"`);
    this.scheduleBindingsSave();
  }

  /**
   * The internal session a friendly handle maps to in a workspace, if this
   * manager has seen it (live or restored). Read-only; used by the
   * `nexus://context` resource to show the display name a renamed handle got.
   */
  describeHandle(handle: string, workspaceId = 'default'): { id: string; displaySessionId: string } | undefined {
    const entry = this.sessionHandleMap.get(this.handleKey(workspaceId, handle));
    return entry ? { id: entry.id, displaySessionId: entry.displaySessionId } : undefined;
  }

  /**
   * Persist a binding change. Write-through: starts a write immediately when
   * none is in flight, otherwise marks the state dirty so the in-flight
   * writer runs once more when it settles (see `bindingsWrite`). Fire-and-
   * forget: a failed write is logged and the next change retries.
   */
  private scheduleBindingsSave(): void {
    if (!this.bindingsStore) {
      return;
    }
    if (this.bindingsWrite) {
      this.bindingsDirty = true;
      return;
    }
    this.startBindingsWrite(this.snapshotBindings());
  }

  /**
   * Begin the writer with `doc` as its first payload. Must only be called
   * with no write in flight. The writer keeps going while changes arrive
   * mid-write, each pass snapshotting the state as it stands at that moment,
   * and stops as soon as the store is unwired (cleanup) so it can never write
   * the emptied maps over the file.
   */
  private startBindingsWrite(doc: PersistedSessionBindings): void {
    const store = this.bindingsStore;
    if (!store) {
      return;
    }
    this.bindingsDirty = false;
    this.bindingsWrite = (async () => {
      try {
        await this.saveBindings(store, doc);
        while (this.bindingsDirty && this.bindingsStore === store) {
          this.bindingsDirty = false;
          await this.saveBindings(store, this.snapshotBindings());
        }
      } finally {
        this.bindingsWrite = null;
      }
    })();
  }

  private async saveBindings(store: SessionBindingsStore, doc: PersistedSessionBindings): Promise<void> {
    try {
      await store.save(doc);
    } catch (error) {
      logger.systemWarn(`Session bindings save failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Resolve once the current bindings are on disk: waits for any in-flight
   * write (and the follow-up it owes for changes made meanwhile), or starts a
   * write now when nothing is in flight.
   */
  async flushBindings(): Promise<void> {
    if (!this.bindingsStore) {
      return;
    }
    if (!this.bindingsWrite) {
      this.startBindingsWrite(this.snapshotBindings());
    }
    const inFlight = this.bindingsWrite;
    if (inFlight) {
      await inFlight;
    }
  }

  /**
   * Canonicalise a caller-supplied workspace handle to its id. 'default'
   * passes through; a name or id that resolves becomes the id; anything else
   * is returned untouched so ToolBatchExecutionService.validateWorkspaceId can
   * reject it with its did-you-mean steer instead of this method guessing.
   */
  async canonicalizeWorkspaceId(value: string): Promise<string> {
    const trimmed = value.trim();
    if (trimmed.length === 0 || trimmed === GLOBAL_WORKSPACE_ID || !this.workspaceResolver) {
      return trimmed;
    }
    try {
      const workspace = await this.workspaceResolver.getWorkspaceByNameOrId(trimmed);
      return workspace?.id ?? trimmed;
    } catch (error) {
      logger.systemWarn(`Workspace lookup failed for "${trimmed}": ${error instanceof Error ? error.message : String(error)}`);
      return trimmed;
    }
  }

  /**
   * Best-effort display name for a canonical workspace id ('default' has
   * none). Read-only; a failed or absent lookup yields undefined.
   */
  async describeWorkspace(workspaceId: string): Promise<{ id: string; name?: string }> {
    const trimmed = workspaceId.trim();
    if (trimmed.length === 0 || trimmed === GLOBAL_WORKSPACE_ID || !this.workspaceResolver) {
      return { id: trimmed };
    }
    try {
      const workspace = await this.workspaceResolver.getWorkspaceByNameOrId(trimmed);
      return workspace?.name ? { id: trimmed, name: workspace.name } : { id: trimmed };
    } catch {
      return { id: trimmed };
    }
  }

  /**
   * Resolution order for the workspace a call runs in (#214):
   *   explicit on this call  →  the handle's last deliberate bind  →  unbound.
   * An empty or blank explicit value counts as absent — `workspaceId: ""` used
   * to be read as 'default', which is exactly the silent misfiling #214
   * reports. Callers decide what UNBOUND means for their tool (useTools
   * fails with the steer; getTools partitions under 'default' without binding).
   */
  async resolveWorkspaceForSession(
    explicitRaw: unknown,
    sessionHandle?: string
  ): Promise<SessionWorkspaceResolution> {
    await this.ensureBindingsRestored();

    const explicit = typeof explicitRaw === 'string' ? explicitRaw.trim() : '';
    if (explicit.length > 0) {
      return { workspaceId: await this.canonicalizeWorkspaceId(explicit), explicit: true };
    }

    const bound = sessionHandle ? this.resolveHandleWorkspace(sessionHandle) : undefined;
    return { workspaceId: bound, explicit: false };
  }

  /** The workspace a handle was last deliberately bound to, if any. */
  resolveHandleWorkspace(handle: string): string | undefined {
    return this.handleWorkspace.get(handle);
  }

  /**
   * Record a deliberate workspace choice for a handle. `workspaceId` should
   * already be canonical (see canonicalizeWorkspaceId); this method does not
   * look it up so it can stay synchronous for the batch service's hot path.
   */
  bindHandleWorkspace(handle: string, workspaceId: string): void {
    const trimmedHandle = handle.trim();
    const trimmedWorkspace = workspaceId.trim();
    if (!trimmedHandle || !trimmedWorkspace) {
      logger.systemWarn('Attempted to bind a session handle with an empty handle or workspaceId');
      return;
    }
    if (this.handleWorkspace.get(trimmedHandle) === trimmedWorkspace) {
      return;
    }
    this.handleWorkspace.set(trimmedHandle, trimmedWorkspace);
    logger.systemLog(`Bound session handle "${trimmedHandle}" to workspace ${trimmedWorkspace}`);
    this.scheduleBindingsSave();
  }

  /**
   * Bind by INTERNAL session id — for callers that only hold the id the
   * strategy rewrote onto `params.sessionId` (ToolBatchExecutionService's
   * `load-workspace` bind point). Every friendly handle that maps to this id
   * is bound, and so is the id itself, so a caller that passes the standard
   * `s-…` id straight through inherits too.
   */
  bindSessionWorkspaceById(internalSessionId: string, workspaceId: string): void {
    if (!internalSessionId) {
      return;
    }
    this.bindHandleWorkspace(internalSessionId, workspaceId);
    for (const [key, entry] of this.sessionHandleMap.entries()) {
      if (entry.id !== internalSessionId) {
        continue;
      }
      const prefix = `${entry.workspaceId}::`;
      const handle = key.startsWith(prefix) ? key.slice(prefix.length) : key;
      this.bindHandleWorkspace(handle, workspaceId);
    }
  }

  /**
   * Build the partition key used for sessionHandleMap lookups.
   * Friendly handles are unique only within a workspace; the same string in two
   * workspaces must map to two distinct sessions.
   */
  private handleKey(workspaceId: string, handle: string): string {
    return `${workspaceId}::${handle}`;
  }

  /**
   * Check a restored handle's session against storage once, and ALWAYS keep
   * the entry. The handle's continuity is what the caller wants: when
   * storage lists the session, trust the entry; when it does not, re-create
   * the record with the same id (best-effort) and trust the entry anyway.
   *
   * Never drop on a miss. `SessionService.getAllSessions` returns `[]` while
   * storage is still hydrating after a reload (it swallows the error), and a
   * call a few seconds in saw exactly that: the restored `default::live-check`
   * was dropped and a new id minted — the regression this handle map exists
   * to prevent. A session that was genuinely deleted while unloaded is
   * therefore resurrected with its old id, which is the lesser evil versus
   * silently renumbering a live session because storage was cold.
   *
   * A lookup that THROWS keeps the entry unverified (re-checked next call)
   * and returns it, as before.
   */
  private async verifyRestoredHandle(
    key: string,
    entry: { id: string; displaySessionId: string; workspaceId: string },
    sessionDescription?: string
  ): Promise<{ id: string; displaySessionId: string; workspaceId: string }> {
    if (!this.unverifiedHandleKeys.has(key)) {
      return entry;
    }
    if (!this.sessionService?.getAllSessions) {
      return entry;
    }

    let sessions: SessionData[];
    try {
      sessions = await this.sessionService.getAllSessions(entry.workspaceId);
    } catch {
      return entry;
    }

    // Trust every key that points at this session, not just the one looked up.
    for (const [otherKey, other] of this.sessionHandleMap.entries()) {
      if (other.id === entry.id) {
        this.unverifiedHandleKeys.delete(otherKey);
      }
    }

    if (!sessions.some(session => session.id === entry.id)) {
      logger.systemLog(
        `Restored session handle "${key}" points at session ${entry.id}, which storage does not list; keeping the handle and re-creating the record`
      );
      try {
        // createAutoSession already logs and swallows a failed createSession
        // (e.g. "Workspace X not found" while storage is cold); the guard here
        // is belt-and-braces so nothing on this path can throw or drop.
        await this.createAutoSession(entry.id, entry.displaySessionId, sessionDescription, entry.workspaceId);
      } catch (error) {
        logger.systemWarn(
          `Could not re-create session ${entry.id} for restored handle "${key}": ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    return entry;
  }

  /**
   * Remove sessionHandleMap entries for a deleted session in a given workspace.
   * Called from the session-deleted listener registered on SessionService.
   */
  evictSessionHandles(sessionId: string, workspaceId = 'default'): void {
    let removed = false;
    for (const [key, entry] of this.sessionHandleMap.entries()) {
      if (entry.id === sessionId && entry.workspaceId === workspaceId) {
        this.sessionHandleMap.delete(key);
        this.unverifiedHandleKeys.delete(key);
        removed = true;
      }
    }
    this.sessionContextMap.delete(sessionId);
    this.sessionActiveSkillsMap.delete(sessionId);
    this.instructedSessions.delete(sessionId);
    // handleWorkspace is left alone on purpose: the workspace choice belongs
    // to the handle, not the deleted session. The handle's next call creates a
    // fresh session in the workspace the caller last chose.
    if (removed) {
      this.scheduleBindingsSave();
    }
  }
  
  /**
   * Get workspace context for a specific session
   * 
   * @param sessionId The session ID to retrieve context for
   * @returns The workspace context for the session, or null if not found
   */
  getWorkspaceContext(sessionId: string): WorkspaceContext | null {
    return this.sessionContextMap.get(sessionId) || this.defaultWorkspaceContext;
  }
  
  /**
   * Set workspace context for a specific session
   * 
   * @param sessionId The session ID to set context for
   * @param context The workspace context to associate with the session
   */
  setWorkspaceContext(sessionId: string, context: WorkspaceContext): void {
    if (!sessionId) {
      logger.systemWarn('Attempted to set workspace context with empty sessionId');
      return;
    }
    
    if (!context.workspaceId) {
      logger.systemWarn('Attempted to set workspace context with empty workspaceId');
      return;
    }
    
    this.sessionContextMap.set(sessionId, context);
    logger.systemLog(`Set workspace context for session ${sessionId}: ${context.workspaceId}`);
  }
  
  /**
   * Set the default workspace context used for new sessions
   * 
   * @param context The default workspace context or null to clear
   */
  setDefaultWorkspaceContext(context: WorkspaceContext | null): void {
    this.defaultWorkspaceContext = context;
    if (context) {
      logger.systemLog(`Set default workspace context: ${context.workspaceId}`);
    } else {
      logger.systemLog('Cleared default workspace context');
    }
  }
  
  /**
   * Clear workspace context for a specific session
   * 
   * @param sessionId The session ID to clear context for
   */
  clearWorkspaceContext(sessionId: string): void {
    this.sessionContextMap.delete(sessionId);
    this.sessionActiveSkillsMap.delete(sessionId);
  }

  /**
   * Get the active skill ids for a session (for trace attribution, §9).
   *
   * @param sessionId The session ID
   * @returns The active skill ids, or an empty array if none
   */
  getActiveSkills(sessionId: string): string[] {
    return this.sessionActiveSkillsMap.get(sessionId) ?? [];
  }

  /**
   * Mark a skill as active for a session (deduped). Called by loadSkill so
   * subsequent tool-call traces are attributed to the skill.
   *
   * @param sessionId The session ID
   * @param skillId The skill id (e.g. "claude/essay-editor")
   */
  addActiveSkill(sessionId: string, skillId: string): void {
    const existing = this.sessionActiveSkillsMap.get(sessionId) ?? [];
    if (existing.includes(skillId)) {
      return;
    }
    this.sessionActiveSkillsMap.set(sessionId, [...existing, skillId]);
  }

  /**
   * Replace the active skill set for a session.
   *
   * @param sessionId The session ID
   * @param skillIds The skill ids to set as active
   */
  setActiveSkills(sessionId: string, skillIds: string[]): void {
    this.sessionActiveSkillsMap.set(sessionId, [...skillIds]);
  }
  
  /**
   * Update workspace context from a result
   * Extracts and saves workspace context from mode execution results
   * 
   * @param sessionId The session ID to update context for
   * @param result The result containing workspace context
   */
  updateFromResult(sessionId: string, result: CommonResult): void {
    if (!result.workspaceContext || !result.workspaceContext.workspaceId) {
      return;
    }
    
    this.setWorkspaceContext(sessionId, result.workspaceContext);
  }
  
  /**
   * Apply workspace context to parameters if not already specified
   * 
   * @param sessionId The session ID to get context for
   * @param params The parameters to apply context to
   * @returns The parameters with workspace context applied
   */
  applyWorkspaceContext<T extends { workspaceContext?: WorkspaceContext }>(
    sessionId: string, 
    params: T
  ): T {
    // Don't override existing context if specified
    const parsedContext = parseWorkspaceContext(params.workspaceContext);
    if (parsedContext?.workspaceId) {
      return params;
    }
    
    const context = this.getWorkspaceContext(sessionId);
    if (!context) {
      return params;
    }
    
    // Create new params object to avoid mutation
    return {
      ...params,
      workspaceContext: context
    };
  }
  
  /**
   * Check if workspace context exists for a session
   * 
   * @param sessionId The session ID to check
   * @returns True if context exists for the session
   */
  hasWorkspaceContext(sessionId: string): boolean {
    return this.sessionContextMap.has(sessionId);
  }
  
  /**
   * Get all active sessions with their workspace contexts
   * 
   * @returns Map of all session IDs to their workspace contexts
   */
  getAllSessionContexts(): Map<string, WorkspaceContext> {
    return new Map(this.sessionContextMap);
  }
  
  /**
   * Clear all session contexts
   */
  clearAll(): void {
    this.sessionContextMap.clear();
    this.sessionActiveSkillsMap.clear();
    this.sessionHandleMap.clear();
    this.unverifiedHandleKeys.clear();
    this.handleWorkspace.clear();
    this.cliCurrentSession = null;
    this.instructedSessions.clear();
    this.defaultWorkspaceContext = null;
  }

  /**
   * ServiceContainer-detected cleanup hook. Runs on plugin teardown
   * (ServiceContainer.clear) so the in-memory handle map and session-deleted
   * subscription do not survive a plugin reload. The persisted bindings DO
   * survive — that is what lets a returning handle resume its session — so
   * anything the writer still owes is written before memory is cleared.
   */
  cleanup(): void {
    if (this.sessionDeletedUnsubscribe) {
      this.sessionDeletedUnsubscribe();
      this.sessionDeletedUnsubscribe = null;
    }
    const store = this.bindingsStore;
    const inFlight = this.bindingsWrite;
    if (store && inFlight) {
      // Every change already started its own write; the only state not yet on
      // disk is what arrived while that write was in flight. Snapshot it NOW,
      // synchronously, before clearAll() empties the maps, and write it after
      // the in-flight write settles so the two cannot land out of order. The
      // writer's own follow-up stops once the store is unwired below, so this
      // is the last write. Fire-and-forget: Obsidian does not await unload.
      const finalDoc = this.snapshotBindings();
      this.bindingsDirty = false;
      void inFlight.then(() => this.saveBindings(store, finalDoc));
    }
    this.bindingsStore = null;
    this.bindingsRestore = null;
    this.clearAll();
  }
  
  /**
   * Set the memory service for session validation
   * 
   * @param memoryService The memory service instance
   */
  setMemoryService(_memoryService: unknown): void {
    // Placeholder for future implementation
    // Memory service will be used for session validation in future releases
  }
  
  /**
   * Validate a session ID and auto-create session if needed
   * 
   * @param sessionId The session ID to validate (can be friendly name or standard ID)
   * @param sessionDescription Optional session description for auto-creation
   * @returns Object with validated session ID and creation status
   */
  async validateSessionId(
    sessionId: string,
    sessionDescription?: string,
    workspaceId = 'default'
  ): Promise<SessionValidationResult> {
    // Handles persisted before the last reload must be in memory before a
    // lookup, or a returning handle is created anew and renamed `<handle>-2`.
    await this.ensureBindingsRestored();

    // If no session ID is provided, generate a new one in our standard format
    if (!sessionId) {
      logger.systemWarn('Empty sessionId provided for validation, generating a new one');
      const newId = generateSessionId();
      await this.createAutoSession(newId, 'Default Session', sessionDescription);
      return {
        id: newId,
        created: true,
        displaySessionId: 'Default Session',
        displaySessionIdChanged: true
      };
    }
    
    // If the session ID doesn't match our standard format, it's a friendly name - create session
    if (!isStandardSessionId(sessionId)) {
      const key = this.handleKey(workspaceId, sessionId);
      const knownHandle = this.sessionHandleMap.get(key);
      const existingHandle = knownHandle
        ? await this.verifyRestoredHandle(key, knownHandle, sessionDescription)
        : null;
      if (existingHandle) {
        return {
          id: existingHandle.id,
          created: false,
          displaySessionId: existingHandle.displaySessionId,
          displaySessionIdChanged: existingHandle.displaySessionId !== sessionId
        };
      }

      const newId = generateSessionId();
      const displaySessionId = await this.createUniqueSessionDisplayName(sessionId, workspaceId);
      const handleEntry = { id: newId, displaySessionId, workspaceId };
      this.sessionHandleMap.set(key, handleEntry);
      this.sessionHandleMap.set(this.handleKey(workspaceId, displaySessionId), handleEntry);
      this.scheduleBindingsSave();
      await this.createAutoSession(newId, displaySessionId, sessionDescription, workspaceId);
      return {
        id: newId,
        created: true,
        displaySessionId,
        displaySessionIdChanged: displaySessionId !== sessionId
      };
    }
    
    // Session ID is in standard format - check if it exists in our context map first
    // ✅ CRITICAL FIX: If we already have workspace context for this session,
    // it means the session was already bound - no need to check database
    if (this.sessionContextMap.has(sessionId)) {
      logger.systemLog(`Session ${sessionId} found in context map - already bound to workspace`);
      return {id: sessionId, created: false, displaySessionId: sessionId, displaySessionIdChanged: false};
    }

    // Check database if not in context map
    if (!this.sessionService) {
      console.error('[SessionContextManager] SessionService is NULL during validation!');
      throw new Error('SessionService not initialized - cannot validate session');
    }

    try {
      const existingSession = await this.sessionService.getSession(sessionId);
      if (existingSession) {
        return {id: sessionId, created: false, displaySessionId: sessionId, displaySessionIdChanged: false};
      } else {
        await this.createAutoSession(sessionId, `Session ${sessionId}`, sessionDescription);
        return {id: sessionId, created: true, displaySessionId: sessionId, displaySessionIdChanged: false};
      }
    } catch (error) {
      logger.systemWarn(`Error checking session existence: ${error instanceof Error ? error.message : String(error)}`);
      // Fallback to returning the session ID without verification
      return {id: sessionId, created: false, displaySessionId: sessionId, displaySessionIdChanged: false};
    }
  }

  /**
   * Auto-create a session with given parameters
   *
   * @param sessionId Generated standard session ID
   * @param sessionName Friendly name provided by LLM
   * @param sessionDescription Optional session description
   */
  private async createAutoSession(
    sessionId: string,
    sessionName: string,
    sessionDescription?: string,
    explicitWorkspaceId?: string
  ): Promise<void> {
    // ✅ CRITICAL FIX: Use workspace from sessionContextMap if available
    const context = this.sessionContextMap.get(sessionId);
    const workspaceId = explicitWorkspaceId || context?.workspaceId || 'default';

    logger.systemLog(`Auto-created session: ${sessionId} with name "${sessionName}", workspace "${workspaceId}", and description "${sessionDescription || 'No description'}"`);

    // Create session using the injected session service
    if (this.sessionService) {
      try {
        const sessionData = {
          name: sessionName,
          description: sessionDescription || '',
          workspaceId: workspaceId, // ✅ Use correct workspace from context
          id: sessionId
        };

        await this.sessionService.createSession(sessionData);
        logger.systemLog(`Session ${sessionId} successfully created in database with workspace ${workspaceId}`);
      } catch (error) {
        logger.systemError(error as Error, `Failed to create session ${sessionId}`);
      }
    } else {
      logger.systemWarn(`SessionService not available - session ${sessionId} not saved to database`);
    }
  }

  private async createUniqueSessionDisplayName(baseName: string, workspaceId: string): Promise<string> {
    const usedNames = new Set<string>();
    for (const [key, entry] of this.sessionHandleMap.entries()) {
      // Only collide names within the same workspace — same handle in two
      // workspaces is allowed (workspaces are UX scoping). Restored-but-
      // unverified entries are skipped: if their session still exists the
      // storage lookup below lists its name anyway, and if it was deleted its
      // stale display name must not force a `-2` on a fresh handle.
      if (entry.workspaceId === workspaceId && !this.unverifiedHandleKeys.has(key)) {
        usedNames.add(entry.displaySessionId.toLowerCase());
      }
    }

    if (this.sessionService?.getAllSessions) {
      try {
        const sessions = await this.sessionService.getAllSessions(workspaceId);
        for (const session of sessions) {
          if (session.name) {
            usedNames.add(session.name.toLowerCase());
          }
        }
      } catch {
        // Best effort only; storage-level uniqueness is not required for the
        // internal ID, but unique display handles prevent ambiguous future use.
      }
    }

    const normalizedBaseName = baseName.trim() || 'Session';
    let candidate = normalizedBaseName;
    let suffix = 2;
    while (usedNames.has(candidate.toLowerCase())) {
      candidate = `${normalizedBaseName}-${suffix}`;
      suffix += 1;
    }

    return candidate;
  }
  
  /**
   * Update session description if it has changed
   * 
   * @param sessionId Standard session ID
   * @param sessionDescription New session description
   */
  async updateSessionDescription(sessionId: string, sessionDescription: string): Promise<void> {
    logger.systemLog(`Updating session description for ${sessionId}: "${sessionDescription}"`);
    
    // Update session using the injected session service
    if (this.sessionService) {
      try {
        // Get the workspace context for this session to determine workspaceId
        const workspaceContext = this.getWorkspaceContext(sessionId);
        const workspaceId = workspaceContext?.workspaceId || 'default';
        
        // Fetch existing session to get current data
        const existingSession = await this.sessionService.getSession(sessionId);
        
        // Update session with correct SessionData structure
        if (existingSession) {
          await this.sessionService.updateSession({
            id: sessionId,
            workspaceId: existingSession.workspaceId || workspaceId,
            name: existingSession.name,
            description: sessionDescription,
            metadata: existingSession.metadata
          });
          logger.systemLog(`Session ${sessionId} description updated in database`);
        } else {
          logger.systemWarn(`Session ${sessionId} not found - cannot update description`);
        }
      } catch (error) {
        logger.systemError(error as Error, `Failed to update session ${sessionId} description`);
      }
    } else {
      logger.systemWarn(`SessionService not available - session ${sessionId} description update not saved`);
    }
  }

  /**
   * Check if a session ID appears to be generated by Claude or not in our standard format
   * 
   * @param sessionId The session ID to check
   * @returns Boolean indicating if this appears to be a non-standard ID
   */
  isNonStandardSessionId(sessionId: string): boolean {
    return !isStandardSessionId(sessionId);
  }
  
  /**
   * Check if a session has already received instructions
   * 
   * @param sessionId The session ID to check
   * @returns Whether instructions have been sent for this session
   */
  hasReceivedInstructions(sessionId: string): boolean {
    return this.instructedSessions.has(sessionId);
  }
  
  /**
   * Mark a session as having received instructions
   * 
   * @param sessionId The session ID to mark
   */
  markInstructionsReceived(sessionId: string): void {
    this.instructedSessions.add(sessionId);
    logger.systemLog(`Marked session ${sessionId} as having received instructions`);
  }
}
