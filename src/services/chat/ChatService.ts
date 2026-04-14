/**
 * ChatService - Native chatbot with direct agent integration
 *
 * Internal chatbot that calls LLM and executes tool calls via MCPConnector.
 *
 * Flow: User message → LLM → Tool calls → MCPConnector → Agents → Results → LLM → Response
 */

import { ConversationData, ChatMessage, ToolCall } from '../../types/chat/ChatTypes';
import { getErrorMessage } from '../../utils/errorUtils';
import { ToolCallService } from './ToolCallService';
import type { ToolEventCallback } from './ToolCallService';
import { CostTrackingService } from './CostTrackingService';
import { ConversationQueryService } from './ConversationQueryService';
import { ConversationManager } from './ConversationManager';
import { StreamingResponseService } from './StreamingResponseService';
import { ChatTraceService } from './ChatTraceService';
import type { DirectToolExecutor } from './DirectToolExecutor';
import type { PaginatedResult } from '../../types/pagination/PaginationTypes';
import type { LLMService } from '../llm/core/LLMService';
import type { JSONSchema } from '../../types/schema/JSONSchemaTypes';
import type { ToolCallMessageHistoryOptions } from '../../database/repositories/interfaces/IMessageRepository';

interface ConversationListItem {
  id: string;
  title: string;
  summary: string;
  relevanceScore: number;
  created: number;
  lastUpdated: number;
}

interface ChatUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

interface ChatStreamingChunk {
  chunk: string;
  complete: boolean;
  messageId: string;
  toolCalls?: ToolCall[];
  metadata?: Record<string, unknown>;
  reasoning?: string;
  reasoningComplete?: boolean;
  usage?: ChatUsage;
  // Final-chunk-only fields for single-save persistence
  provider?: string;
  model?: string;
  cost?: { totalCost: number; currency: string };
}

interface ChatMessageCreateParams {
  conversationId: string;
  role: 'user' | 'assistant';
  content: string;
  toolCalls?: ToolCall[];
  metadata?: Record<string, unknown>;
  id?: string;
}

interface ConversationRepositoryLike {
  updateConversation(id: string, updates: Partial<ConversationData>): Promise<void>;
}

interface MCPConnectorLike {
  getAvailableTools?: () => Array<{
    type: 'function';
    function?: {
      name: string;
      description?: string;
      parameters?: JSONSchema;
    };
    name: string;
    description?: string;
    inputSchema?: JSONSchema;
  }>;
  executeTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
}

interface ConversationServiceDependency {
  getConversation: (id: string, pagination?: { page?: number; pageSize?: number }) => Promise<ConversationData | null>;
  listConversations: (vaultName?: string, limit?: number, page?: number) => Promise<Array<{
    id: string;
    title: string;
    created: number;
    updated: number;
    vault_name?: string;
    message_count?: number;
  }>>;
  searchConversations: (query: string, limit?: number) => Promise<Array<{
    id: string;
    title: string;
    created: number;
    updated: number;
    vault_name?: string;
    message_count?: number;
  }>>;
  addMessage: (params: {
    conversationId: string;
    role: string;
    content: string;
    id?: string;
    toolCalls?: ToolCall[];
    metadata?: Record<string, unknown>;
  }) => Promise<void>;
  updateConversation: (id: string, updates: Partial<ConversationData>) => Promise<void>;
  updateConversationMetadata?: (conversationId: string, metadata: Record<string, unknown>) => Promise<void>;
  createConversation: (data: unknown) => Promise<ConversationData>;
  deleteConversation: (id: string) => Promise<void>;
  getMessages?: (conversationId: string, options?: { page?: number; pageSize?: number }) => Promise<PaginatedResult<ChatMessage>>;
  getToolCallMessagesForConversation?: (
    conversationId: string,
    options?: ToolCallMessageHistoryOptions
  ) => Promise<PaginatedResult<ChatMessage>>;
  getRepository?: () => ConversationRepositoryLike;
  count?: () => Promise<number>;
}

export interface ChatServiceOptions {
  maxToolIterations?: number;
  toolTimeout?: number;
  enableToolChaining?: boolean;
}

export interface ChatServiceDependencies {
  conversationService: ConversationServiceDependency;
  llmService: LLMService;
  vaultName: string;
  mcpConnector: MCPConnectorLike; // Required - MCPConnector for tool execution
  chatTraceService?: ChatTraceService; // Optional - for creating memory traces
}

export class ChatService {
  private toolCallService: ToolCallService;
  private costTrackingService: CostTrackingService;
  private conversationQueryService: ConversationQueryService;
  private conversationManager: ConversationManager;
  private streamingResponseService: StreamingResponseService;
  private chatTraceService?: ChatTraceService;
  private currentProvider?: string; // Track current provider for context building
  private currentSessionId?: string; // Track current session ID for tool execution
  private isInitialized = false;

  constructor(
    private dependencies: ChatServiceDependencies,
    private options: ChatServiceOptions = {}
  ) {
    this.options = {
      maxToolIterations: 10,
      toolTimeout: 30000,
      enableToolChaining: true,
      ...options
    };

    // Initialize services
    this.toolCallService = new ToolCallService(dependencies.mcpConnector);
    this.costTrackingService = new CostTrackingService(dependencies.conversationService);
    this.conversationQueryService = new ConversationQueryService(dependencies.conversationService);
    this.streamingResponseService = new StreamingResponseService({
      llmService: dependencies.llmService,
      conversationService: dependencies.conversationService,
      toolCallService: this.toolCallService,
      costTrackingService: this.costTrackingService
    });
    this.conversationManager = new ConversationManager(
      {
        conversationService: dependencies.conversationService,
        streamingGenerator: this.generateResponseStreaming.bind(this)
      },
      dependencies.vaultName
    );

    // Optional trace service for memory traces
    this.chatTraceService = dependencies.chatTraceService;
  }

  /**
   * Set the chat trace service (can be set after construction)
   */
  setChatTraceService(service: ChatTraceService): void {
    this.chatTraceService = service;
  }

  /** Set tool event callback for live UI updates */
  setToolEventCallback(callback: ToolEventCallback): void {
    this.toolCallService.setEventCallback(callback);
  }

  /**
   * Set the DirectToolExecutor for direct tool execution
   * This enables tools on ALL platforms (desktop + mobile) without MCP
   */
  setDirectToolExecutor(executor: DirectToolExecutor): void {
    this.toolCallService.setDirectToolExecutor(executor);
  }

  /** Initialize the tool service */
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    await this.toolCallService.initialize();
    this.isInitialized = true;
  }

  /**
   * Create a new conversation
   */
  async createConversation(
    title: string,
    initialMessage?: string,
    options?: {
      provider?: string;
      model?: string;
      systemPrompt?: string;
      workspaceId?: string;
      sessionId?: string;
      promptId?: string;
      workflowId?: string;
      workflowName?: string;
      runTrigger?: 'manual' | 'scheduled' | 'catch_up';
      scheduledFor?: number;
      runKey?: string;
    }
  ): Promise<{
    success: boolean;
    conversationId?: string;
    sessionId?: string;
    error?: string;
  }> {
    try {
      const conversation = await this.conversationManager.createConversation({
        title,
        initialMessage,
        provider: options?.provider,
        model: options?.model,
        systemPrompt: options?.systemPrompt,
        workspaceId: options?.workspaceId,
        sessionId: options?.sessionId,
        promptId: options?.promptId,
        workflowId: options?.workflowId,
        workflowName: options?.workflowName,
        runTrigger: options?.runTrigger,
        scheduledFor: options?.scheduledFor,
        runKey: options?.runKey
      });

      const sessionId = conversation.metadata?.chatSettings?.sessionId;
      const workspaceId = options?.workspaceId || 'default';

      // Initialize trace session if we have a workspace
      if (this.chatTraceService && workspaceId) {
        try {
          await this.chatTraceService.initializeSession(conversation.id, workspaceId, sessionId);
          await this.chatTraceService.traceConversationEvent(conversation.id, 'started', title);
        } catch {
          // Trace initialization is best-effort and must not block conversation creation.
        }
      }

      // If there's an initial message, get AI response
      if (initialMessage?.trim()) {
        // Trace user message
        if (this.chatTraceService) {
          await this.chatTraceService.traceUserMessage(conversation.id, 'initial', initialMessage);
        }

        // Generate streaming response
        let completeResponse = '';
        for await (const chunk of this.generateResponseStreaming(conversation.id, initialMessage, options)) {
          completeResponse += chunk.chunk;
        }

        // Trace assistant response
        if (this.chatTraceService && completeResponse) {
          await this.chatTraceService.traceAssistantMessage(conversation.id, 'initial_response', completeResponse);
        }
      }

      return {
        success: true,
        conversationId: conversation.id,
        sessionId
      };
    } catch (error) {
      console.error('[ChatService] Failed to create conversation:', error);
      return {
        success: false,
        error: getErrorMessage(error)
      };
    }
  }

  /**
   * Add a message to a conversation
   */
  async addMessage(params: ChatMessageCreateParams): Promise<{ success: boolean; messageId?: string; error?: string }> {
    try {
      await this.conversationManager.addMessage({
        conversationId: params.conversationId,
        role: params.role,
        content: params.content,
        toolCalls: params.toolCalls,
        metadata: params.metadata,
        id: params.id
      });

      return {
        success: true,
        messageId: params.id // Return the ID that was used
      };
    } catch (error) {
      console.error('Failed to add message:', error);
      return {
        success: false,
        error: getErrorMessage(error)
      };
    }
  }

  /**
   * Send a message and get AI response with iterative tool execution
   */
  async sendMessage(
    conversationId: string,
    message: string,
    options?: {
      provider?: string;
      model?: string;
      systemPrompt?: string;
      workspaceId?: string;
      sessionId?: string;
    }
  ): Promise<{
    success: boolean;
    messageId?: string;
    error?: string;
  }> {
    try {
      let messageId: string | undefined;
      for await (const chunk of this.conversationManager.sendMessage(conversationId, message, options)) {
        messageId = chunk.messageId;
      }

      return {
        success: true,
        messageId
      };
    } catch (error) {
      console.error('Failed to send message:', error);
      return {
        success: false,
        error: getErrorMessage(error)
      };
    }
  }

  /**
   * Generate AI response with streaming support
   * Yields chunks of the response as they're generated
   *
   * Delegates to StreamingResponseService for coordination
   */
  async* generateResponseStreaming(
    conversationId: string,
    userMessage: string,
    options?: {
      provider?: string;
      model?: string;
      systemPrompt?: string;
      workspaceId?: string;
      sessionId?: string;
      messageId?: string;
      abortSignal?: AbortSignal;
      excludeFromMessageId?: string;
      enableThinking?: boolean;
      thinkingEffort?: 'low' | 'medium' | 'high';
    }
  ): AsyncGenerator<ChatStreamingChunk, void, unknown> {
    // Store current provider and session for backward compatibility
    if (options?.provider) {
      this.currentProvider = options.provider;
      this.streamingResponseService.setProvider(options.provider);
    }
    if (options?.sessionId) {
      this.currentSessionId = options.sessionId;
    }

    // Delegate to StreamingResponseService
    yield* this.streamingResponseService.generateResponse(conversationId, userMessage, options);
  }

  /**
   * Update conversation with new data
   */
  async updateConversation(conversation: ConversationData): Promise<{ success: boolean; error?: string }> {
    try {
      await this.conversationManager.updateConversation(conversation.id, {
        title: conversation.title,
        messages: conversation.messages
      });

      return {
        success: true
      };
    } catch (error) {
      console.error('Failed to update conversation:', error);
      return {
        success: false,
        error: getErrorMessage(error)
      };
    }
  }

  /** Get conversation by ID */
  async getConversation(
    id: string,
    paginationOptions?: { page?: number; pageSize?: number }
  ): Promise<ConversationData | null> {
    return this.conversationQueryService.getConversation(id, paginationOptions);
  }

  /** Get messages for a conversation (paginated) */
  async getMessages(
    conversationId: string,
    options?: { page?: number; pageSize?: number }
  ): Promise<PaginatedResult<ChatMessage>> {
    return this.conversationQueryService.getMessages(conversationId, options);
  }

  /** Get conversation-wide tool call history (cursor-paginated by sequence number) */
  async getToolCallMessagesForConversation(
    conversationId: string,
    options?: ToolCallMessageHistoryOptions
  ): Promise<PaginatedResult<ChatMessage>> {
    return this.conversationQueryService.getToolCallMessagesForConversation(conversationId, options);
  }

  /** List conversations with pagination */
  async listConversations(options?: {
    limit?: number;
    page?: number;
    sortBy?: string;
    sortOrder?: 'asc' | 'desc';
  }): Promise<PaginatedResult<ConversationData>> {
    return this.conversationQueryService.listConversations(options);
  }

  /**
   * Delete conversation
   */
  async deleteConversation(id: string): Promise<boolean> {
    return await this.conversationManager.deleteConversation(id);
  }

  /**
   * Update conversation title
   */
  async updateConversationTitle(id: string, newTitle: string): Promise<boolean> {
    try {
      await this.conversationManager.updateTitle(id, newTitle);
      return true;
    } catch (error) {
      console.error('Failed to update conversation title:', error);
      return false;
    }
  }

  /** Search conversations */
  async searchConversations(query: string, limit = 10): Promise<ConversationListItem[]> {
    const results = await this.conversationQueryService.searchConversations(query, { limit });
    return results.map(conv => ({
      id: conv.id,
      title: conv.title,
      summary: conv.messages[0]?.content.substring(0, 100) + '...',
      relevanceScore: 0.8,
      created: conv.created,
      lastUpdated: conv.updated
    }));
  }

  /** Get conversation repository for branch management */
  getConversationRepository(): ConversationRepositoryLike {
    return this.conversationQueryService.getConversationRepository() as ConversationRepositoryLike;
  }

  /** Get conversation service (alias for getConversationRepository) */
  getConversationService(): ConversationServiceDependency {
    return this.dependencies.conversationService;
  }

  /**
   * Check if any LLM providers are configured and available
   */
  hasConfiguredProviders(): boolean {
    const llmService = this.dependencies.llmService;
    if (!llmService || typeof llmService.getAvailableProviders !== 'function') {
      return false;
    }
    const availableProviders = llmService.getAvailableProviders();
    return availableProviders && availableProviders.length > 0;
  }

  /**
   * Get the LLM service for direct streaming access
   * Used by subagent infrastructure for autonomous LLM calls
   */
  getLLMService(): LLMService {
    return this.dependencies.llmService;
  }

  /**
   * Cleanup resources
   */
  async dispose(): Promise<void> {
    // Cleanup if needed
  }
}
