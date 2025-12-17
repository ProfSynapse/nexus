export interface SessionData {
  id: string;
  workspaceId: string;
  name?: string;
  description?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Interface for the memory service dependency
 */
export interface IMemoryService {
  createSession(data: { workspaceId: string; id: string; name?: string; description?: string }): Promise<void>;
  getSession(workspaceId: string, sessionId: string): Promise<SessionData | null>;
  getSessions(workspaceId: string): Promise<SessionData[]>;
  updateSession(workspaceId: string, sessionId: string, data: { name?: string; description?: string }): Promise<void>;
  deleteSession(workspaceId: string, sessionId: string): Promise<void>;
}

/**
 * Session management service that delegates to MemoryService/WorkspaceService
 * Provides session tracking across workspaces with proper persistence
 */
export class SessionService {
  private sessions = new Map<string, SessionData>();

  constructor(private memoryService: IMemoryService) {
  }

  /**
   * Create a new session
   */
  async createSession(sessionData: Omit<SessionData, 'id'> | SessionData): Promise<SessionData> {
    // Use provided ID if available, otherwise generate one
    const id = ('id' in sessionData && sessionData.id) ? sessionData.id : this.generateSessionId();
    const workspaceId = sessionData.workspaceId || 'default';

    const session: SessionData = {
      ...sessionData,
      id,
      workspaceId
    };

    // Store in memory cache
    this.sessions.set(id, session);

    // Persist to workspace via MemoryService
    try {
      await this.memoryService.createSession({
        workspaceId: session.workspaceId,
        id: session.id,
        name: session.name,
        description: session.description
      });
    } catch (error) {
      console.error(`[SessionService] Failed to persist session ${id}:`, error);
      // Keep in memory even if persistence fails
    }

    return session;
  }

  /**
   * Get session by ID
   * Note: This searches across all workspaces since we don't have workspaceId
   */
  async getSession(sessionId: string): Promise<SessionData | null> {
    // Check memory cache first
    let session = this.sessions.get(sessionId);
    if (session) {
      return session;
    }

    // Try to load from workspaces via MemoryService
    // We need to check the default workspace first, then others
    try {
      const workspaceSession = await this.memoryService.getSession('default', sessionId);
      if (workspaceSession) {
        session = {
          id: workspaceSession.id,
          workspaceId: 'default',
          name: workspaceSession.name,
          description: workspaceSession.description
        };
        this.sessions.set(sessionId, session);
        return session;
      }
    } catch (error) {
      // Session not found in default workspace
    }

    return null;
  }

  /**
   * Get all sessions from a workspace
   */
  async getAllSessions(workspaceId: string = 'default'): Promise<SessionData[]> {
    try {
      const workspaceSessions = await this.memoryService.getSessions(workspaceId);
      // Convert to SessionData format and cache
      const sessions = workspaceSessions.map((ws: SessionData) => ({
        id: ws.id,
        workspaceId,
        name: ws.name,
        description: ws.description
      }));

      for (const session of sessions) {
        this.sessions.set(session.id, session);
      }

      return sessions;
    } catch (error) {
      return [];
    }
  }

  /**
   * Update session data
   */
  async updateSession(session: SessionData): Promise<void> {
    const workspaceId = session.workspaceId || 'default';

    // Update memory cache
    this.sessions.set(session.id, session);

    // Persist to workspace via MemoryService
    try {
      await this.memoryService.updateSession(workspaceId, session.id, {
        name: session.name,
        description: session.description
      });
    } catch (error) {
      console.error(`[SessionService] Failed to update session ${session.id}:`, error);
    }
  }

  /**
   * Delete a session
   */
  async deleteSession(sessionId: string, workspaceId: string = 'default'): Promise<void> {
    // Remove from memory cache
    this.sessions.delete(sessionId);

    // Delete from workspace via MemoryService
    try {
      await this.memoryService.deleteSession(workspaceId, sessionId);
    } catch (error) {
      console.error(`[SessionService] Failed to delete session ${sessionId}:`, error);
    }
  }
  
  /**
   * Generate a unique session ID
   */
  private generateSessionId(): string {
    return `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
  
  /**
   * Get session statistics
   */
  getStats(): { totalSessions: number } {
    const allSessions = Array.from(this.sessions.values());
    return {
      totalSessions: allSessions.length
    };
  }
}