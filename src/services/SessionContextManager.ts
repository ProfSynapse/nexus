import { CommonResult } from '../types';
import type { SessionData } from './session/SessionService';
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

export interface SessionValidationResult {
  id: string;
  created: boolean;
  displaySessionId: string;
  displaySessionIdChanged: boolean;
}

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

  // Map of model-facing session handles to internal unique session IDs.
  // Keyed by `${workspaceId}::${handle}` so the same friendly handle ("research")
  // in different workspaces resolves to distinct internal sessions instead of
  // aliasing — workspaces are UX scoping, and reusing names across them is
  // expected. The map stores the originating workspaceId so eviction on session
  // delete (registerOnSessionDeleted) can purge both the input handle entry and
  // the display-name entry without scanning the whole map.
  private sessionHandleMap: Map<string, { id: string; displaySessionId: string; workspaceId: string }> = new Map();

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
   * Build the partition key used for sessionHandleMap lookups.
   * Friendly handles are unique only within a workspace; the same string in two
   * workspaces must map to two distinct sessions.
   */
  private handleKey(workspaceId: string, handle: string): string {
    return `${workspaceId}::${handle}`;
  }

  /**
   * Remove sessionHandleMap entries for a deleted session in a given workspace.
   * Called from the session-deleted listener registered on SessionService.
   */
  evictSessionHandles(sessionId: string, workspaceId = 'default'): void {
    for (const [key, entry] of this.sessionHandleMap.entries()) {
      if (entry.id === sessionId && entry.workspaceId === workspaceId) {
        this.sessionHandleMap.delete(key);
      }
    }
    this.sessionContextMap.delete(sessionId);
    this.instructedSessions.delete(sessionId);
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
    this.sessionHandleMap.clear();
    this.instructedSessions.clear();
    this.defaultWorkspaceContext = null;
  }

  /**
   * ServiceContainer-detected cleanup hook. Runs on plugin teardown
   * (ServiceContainer.clear) so the in-memory handle map and session-deleted
   * subscription do not survive a plugin reload.
   */
  cleanup(): void {
    if (this.sessionDeletedUnsubscribe) {
      this.sessionDeletedUnsubscribe();
      this.sessionDeletedUnsubscribe = null;
    }
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
      const existingHandle = this.sessionHandleMap.get(this.handleKey(workspaceId, sessionId));
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
      this.sessionHandleMap.set(this.handleKey(workspaceId, sessionId), handleEntry);
      this.sessionHandleMap.set(this.handleKey(workspaceId, displaySessionId), handleEntry);
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
    for (const entry of this.sessionHandleMap.values()) {
      // Only collide names within the same workspace — same handle in two
      // workspaces is allowed (workspaces are UX scoping).
      if (entry.workspaceId === workspaceId) {
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
