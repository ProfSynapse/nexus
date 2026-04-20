/**
 * Location: src/services/chat/ChatTraceService.ts
 * Purpose: Bridge between chat conversations and workspace memory traces
 *
 * Responsibilities:
 * - Ensure sessions exist when conversations start with a workspace
 * - Create traces for conversation events (messages, tool calls)
 * - Scope traces to the correct workspace/session
 *
 * Design:
 * - Uses WorkspaceService for session/trace operations
 * - Tracks active sessions per conversation
 * - Emits events that can be consumed by embedding service
 */

import { WorkspaceService } from '../WorkspaceService';
import { EmbeddingService } from '../embeddings/EmbeddingService';
import { TraceMetadata } from '../../database/types/memory/MemoryTypes';

const DEFAULT_WORKSPACE_ID = 'default';
const DEFAULT_WORKSPACE_NAME = 'Default Workspace';
const DEFAULT_WORKSPACE_DESCRIPTION = 'Default workspace for chat conversations';

export interface TraceContext {
  workspaceId: string;
  sessionId: string;
  conversationId: string;
}

export interface ChatTraceServiceDependencies {
  workspaceService: WorkspaceService;
  embeddingService?: EmbeddingService;
}

/**
 * Service for creating memory traces from chat conversations
 */
export class ChatTraceService {
  private workspaceService: WorkspaceService;
  private embeddingService?: EmbeddingService;

  // Track active sessions per conversation
  private conversationSessions: Map<string, TraceContext> = new Map();

  // Track sessions that have been created to avoid duplicate creation
  private createdSessions: Set<string> = new Set();

  constructor(deps: ChatTraceServiceDependencies) {
    this.workspaceService = deps.workspaceService;
    this.embeddingService = deps.embeddingService;
  }

  /**
   * Set the embedding service (can be set after construction)
   */
  setEmbeddingService(embeddingService: EmbeddingService): void {
    this.embeddingService = embeddingService;
  }

  /**
   * Resolve a workspace ID for trace storage.
   * Reuses legacy default workspaces by name to avoid duplicate creation.
   */
  private async resolveWorkspaceId(workspaceId: string): Promise<string> {
    const existingWorkspace = await this.workspaceService.getWorkspace(workspaceId);
    if (existingWorkspace) {
      return existingWorkspace.id;
    }

    if (workspaceId !== DEFAULT_WORKSPACE_ID) {
      throw new Error(`Workspace ${workspaceId} not found`);
    }

    const legacyDefaultWorkspace = await this.workspaceService.getWorkspaceByNameOrId(DEFAULT_WORKSPACE_NAME);
    if (legacyDefaultWorkspace) {
      return legacyDefaultWorkspace.id;
    }

    const createdWorkspace = await this.workspaceService.createWorkspace({
      id: DEFAULT_WORKSPACE_ID,
      name: DEFAULT_WORKSPACE_NAME,
      description: DEFAULT_WORKSPACE_DESCRIPTION,
      rootFolder: '/'
    });

    return createdWorkspace.id;
  }

  /**
   * Initialize a session for a conversation
   * Creates the session in the workspace system if it doesn't exist
   *
   * @param conversationId - The conversation ID
   * @param workspaceId - The workspace ID (defaults to 'default')
   * @param sessionId - Optional session ID (generated if not provided)
   */
  async initializeSession(
    conversationId: string,
    workspaceId: string = DEFAULT_WORKSPACE_ID,
    sessionId?: string
  ): Promise<TraceContext> {
    // Check if we already have a context for this conversation
    const existing = this.conversationSessions.get(conversationId);
    if (existing) {
      return existing;
    }

    // Generate session ID if not provided
    const finalSessionId = sessionId || this.generateSessionId();
    const effectiveWorkspaceId = await this.resolveWorkspaceId(workspaceId);
    const sessionKey = `${effectiveWorkspaceId}:${finalSessionId}`;

    // Create session in workspace if not already created
    if (!this.createdSessions.has(sessionKey)) {
      try {
        // Create session in workspace
        await this.workspaceService.addSession(effectiveWorkspaceId, {
          id: finalSessionId,
          name: `Chat Session ${new Date().toLocaleString()}`,
          description: `Session for conversation ${conversationId}`,
          startTime: Date.now(),
          isActive: true
        });

        this.createdSessions.add(sessionKey);
      } catch (error) {
        console.error(`[ChatTraceService] Failed to create session:`, error);
        // Continue anyway - traces will be created when session exists
      }
    }

    // Store context
    const context: TraceContext = {
      workspaceId: effectiveWorkspaceId,
      sessionId: finalSessionId,
      conversationId
    };
    this.conversationSessions.set(conversationId, context);

    return context;
  }

  /**
   * Record a user message as a trace
   */
  async traceUserMessage(
    conversationId: string,
    messageId: string,
    content: string
  ): Promise<void> {
    const context = this.conversationSessions.get(conversationId);
    if (!context) {
      return;
    }

    await this.addTrace(context, {
      type: 'user_message',
      content: content.slice(0, 500), // Truncate for trace storage
      metadata: {
        messageId,
        conversationId,
        fullLength: content.length
      }
    });
  }

  /**
   * Record an assistant message as a trace
   */
  async traceAssistantMessage(
    conversationId: string,
    messageId: string,
    content: string
  ): Promise<void> {
    const context = this.conversationSessions.get(conversationId);
    if (!context) {
      return;
    }

    await this.addTrace(context, {
      type: 'assistant_message',
      content: content.slice(0, 500),
      metadata: {
        messageId,
        conversationId,
        fullLength: content.length
      }
    });
  }

  /**
   * Record a tool call as a trace
   */
  async traceToolCall(
    conversationId: string,
    toolName: string,
    args: Record<string, unknown>,
    result?: unknown
  ): Promise<void> {
    const context = this.conversationSessions.get(conversationId);
    if (!context) {
      return;
    }

    const content = `Tool: ${toolName}\nArgs: ${JSON.stringify(args).slice(0, 300)}`;

    await this.addTrace(context, {
      type: 'tool_call',
      content,
      metadata: {
        toolName,
        conversationId,
        hasResult: !!result
      }
    });
  }

  /**
   * Record a conversation event (start, end, etc.)
   */
  async traceConversationEvent(
    conversationId: string,
    eventType: 'started' | 'ended' | 'title_changed' | 'workspace_changed',
    details?: string
  ): Promise<void> {
    const context = this.conversationSessions.get(conversationId);
    if (!context) {
      return;
    }

    await this.addTrace(context, {
      type: 'conversation_event',
      content: `${eventType}: ${details || conversationId}`,
      metadata: {
        eventType,
        conversationId
      }
    });
  }

  /**
   * End a session (mark as inactive)
   */
  async endSession(conversationId: string): Promise<void> {
    const context = this.conversationSessions.get(conversationId);
    if (!context) {
      return;
    }

    try {
      await this.workspaceService.updateSession(context.workspaceId, context.sessionId, {
        endTime: Date.now(),
        isActive: false
      });
    } catch (error) {
      console.error(`[ChatTraceService] Failed to end session:`, error);
    }

    this.conversationSessions.delete(conversationId);
  }

  /**
   * Get the trace context for a conversation
   */
  getContext(conversationId: string): TraceContext | undefined {
    return this.conversationSessions.get(conversationId);
  }

  /**
   * Internal: Add a trace and optionally embed it
   */
  private async addTrace(
    context: TraceContext,
    traceData: {
      type: string;
      content: string;
      metadata?: Record<string, unknown>;
    }
  ): Promise<void> {
    try {
      // Chat traces use simplified metadata that doesn't match the full TraceMetadata schema.
      // Cast through unknown since this is an intentional structural mismatch.
      const trace = await this.workspaceService.addMemoryTrace(
        context.workspaceId,
        context.sessionId,
        {
          type: traceData.type,
          content: traceData.content,
          metadata: traceData.metadata as unknown as TraceMetadata,
          timestamp: Date.now()
        }
      );

      // Embed the trace if embedding service is available
      if (this.embeddingService && this.embeddingService.isServiceEnabled()) {
        try {
          await this.embeddingService.embedTrace(
            trace.id,
            context.workspaceId,
            context.sessionId,
            traceData.content
          );
        } catch (error) {
          console.error(`[ChatTraceService] Failed to embed trace:`, error);
        }
      }
    } catch (error) {
      console.error(`[ChatTraceService] Failed to add trace:`, error);
    }
  }

  /**
   * Generate a session ID
   */
  private generateSessionId(): string {
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');
    const timeStr = now.toTimeString().slice(0, 8).replace(/:/g, '');
    return `s-${dateStr}${timeStr}`;
  }
}
