/**
 * SubagentController - Manages subagent infrastructure and lifecycle
 * Location: /src/ui/chat/controllers/SubagentController.ts
 *
 * Extracted from ChatView to follow Single Responsibility Principle.
 * Owns SubagentExecutor, BranchService, MessageQueueService and coordinates
 * their initialization and event handling.
 *
 * ARCHITECTURE NOTE (Dec 2025):
 * A branch IS a conversation with parent metadata. SubagentController creates
 * branch conversations for subagents and coordinates their execution.
 */

import { App, Component } from 'obsidian';
import { BranchService } from '../../../services/chat/BranchService';
import { MessageQueueService } from '../../../services/chat/MessageQueueService';
import { SubagentExecutor } from '../../../services/chat/SubagentExecutor';
import { AgentStatusMenu, createSubagentEventHandlers, getSubagentEventBus } from '../components/AgentStatusMenu';
import { AgentStatusModal } from '../components/AgentStatusModal';
import type { ChatService } from '../../../services/chat/ChatService';
import type { DirectToolExecutor } from '../../../services/chat/DirectToolExecutor';
import type { AgentManagerAgent } from '../../../agents/agentManager/agentManager';
import type { HybridStorageAdapter } from '../../../database/adapters/HybridStorageAdapter';
import type { LLMService } from '../../../services/llm/core/LLMService';
import type { ToolSchemaInfo, AgentStatusItem, BranchViewContext } from '../../../types/branch/BranchTypes';
import type { ConversationData } from '../../../types/chat/ChatTypes';
import type { StreamingController } from './StreamingController';
import type { ToolEventCoordinator } from '../coordinators/ToolEventCoordinator';
import { isSubagentMetadata } from '../../../types/branch/BranchTypes';

/**
 * Dependencies for SubagentController initialization
 */
export interface SubagentControllerDependencies {
  app: App;
  chatService: ChatService;
  directToolExecutor: DirectToolExecutor;
  agentManagerAgent: AgentManagerAgent;
  storageAdapter: HybridStorageAdapter;
  llmService: LLMService;
}

/**
 * Context provider for subagent execution
 * Returns current conversation and model settings
 */
export interface SubagentContextProvider {
  getCurrentConversation: () => ConversationData | null;
  getSelectedModel: () => { providerId?: string; modelId?: string } | null;
  getSelectedAgent: () => { name?: string; systemPrompt?: string } | null;
  getLoadedWorkspaceData: () => any;
  getContextNotes: () => string[];
  getThinkingSettings: () => { enabled?: boolean; effort?: 'low' | 'medium' | 'high' } | null;
  getSelectedWorkspaceId: () => string | null;
}

/**
 * Events emitted by SubagentController
 */
export interface SubagentControllerEvents {
  onStreamingUpdate: (branchId: string, messageId: string, chunk: string, isComplete: boolean, fullContent: string) => void;
  onToolCallsDetected: (branchId: string, messageId: string, toolCalls: any[]) => void;
  onStatusChanged: () => void;
}

export class SubagentController {
  private branchService: BranchService | null = null;
  private messageQueueService: MessageQueueService | null = null;
  private subagentExecutor: SubagentExecutor | null = null;
  private agentStatusMenu: AgentStatusMenu | null = null;

  private currentBranchContext: BranchViewContext | null = null;
  private initialized = false;

  constructor(
    private app: App,
    private component: Component,
    private events: SubagentControllerEvents
  ) {}

  /**
   * Initialize subagent infrastructure
   * This is async and non-blocking - subagent features available once complete
   */
  async initialize(
    deps: SubagentControllerDependencies,
    contextProvider: SubagentContextProvider,
    streamingController: StreamingController,
    toolEventCoordinator: ToolEventCoordinator,
    settingsButtonContainer?: HTMLElement,
    settingsButton?: HTMLElement
  ): Promise<void> {
    if (this.initialized) return;

    try {
      // Create BranchService with ConversationService (unified model)
      // BranchService is now a facade over ConversationService
      const conversationService = deps.chatService.getConversationService();
      this.branchService = new BranchService({
        conversationService,
      });

      // Create MessageQueueService with processor
      this.messageQueueService = new MessageQueueService();
      this.setupMessageQueueProcessor(deps.chatService, contextProvider);

      // Create SubagentExecutor
      this.subagentExecutor = new SubagentExecutor({
        branchService: this.branchService,
        messageQueueService: this.messageQueueService,
        directToolExecutor: deps.directToolExecutor,
        streamingGenerator: this.createStreamingGenerator(deps.llmService, deps.directToolExecutor),
        getToolSchemas: this.createToolSchemaFetcher(deps.directToolExecutor),
      });

      // Set event handlers
      this.setupEventHandlers(streamingController, toolEventCoordinator);

      // Wire up to AgentManagerAgent
      deps.agentManagerAgent.setSubagentExecutor(
        this.subagentExecutor,
        () => this.buildSubagentContext(contextProvider)
      );

      // Initialize status menu if container provided
      if (settingsButtonContainer && settingsButton) {
        this.agentStatusMenu = new AgentStatusMenu(
          settingsButtonContainer,
          this.subagentExecutor,
          { onOpenModal: () => this.openAgentStatusModal(contextProvider) },
          this.component,
          settingsButton
        );
        this.agentStatusMenu.render();
      }

      this.initialized = true;
    } catch (error) {
      console.error('[SubagentController] Failed to initialize:', error);
      throw error;
    }
  }

  /**
   * Set up the message queue processor for subagent results
   */
  private setupMessageQueueProcessor(
    chatService: ChatService,
    contextProvider: SubagentContextProvider
  ): void {
    if (!this.messageQueueService) return;

    this.messageQueueService.setProcessor(async (message) => {
      if (message.type !== 'subagent_result') return;

      try {
        const result = JSON.parse(message.content || '{}');
        const metadata = message.metadata || {};

        const conversationId = metadata.conversationId;
        if (!conversationId) return;

        // Format result for display
        const taskLabel = metadata.subagentTask || 'Task';
        const resultContent = result.success
          ? `[Subagent "${taskLabel}" completed]\n\nResult:\n${result.result || 'Task completed successfully.'}`
          : `[Subagent "${taskLabel}" ${result.status === 'max_iterations' ? 'paused (max iterations)' : 'failed'}]\n\n${result.error || 'Unknown error'}`;

        // Check if viewing parent conversation
        const currentConversation = contextProvider.getCurrentConversation();
        const isViewingParent = currentConversation?.id === conversationId && !this.currentBranchContext;

        // Add result as user message
        await chatService.addMessage({
          conversationId,
          role: 'user',
          content: resultContent,
          metadata: {
            type: 'subagent_result',
            branchId: metadata.branchId,
            subagentId: metadata.subagentId,
            success: result.success,
            iterations: result.iterations,
            isAutoGenerated: true,
          },
        });

        // Trigger LLM response in background
        const parentConversation = await chatService.getConversation(conversationId);
        if (parentConversation) {
          try {
            const generator = chatService.generateResponseStreaming(
              parentConversation.id,
              resultContent,
              {}
            );
            for await (const chunk of generator) {
              if (chunk.complete) break;
            }
          } catch (llmError) {
            console.error('[SubagentController] Failed to generate LLM response:', llmError);
          }
        }
      } catch (error) {
        console.error('[SubagentController] Failed to process subagent result:', error);
      }
    });
  }

  /**
   * Create the streaming generator for SubagentExecutor
   */
  private createStreamingGenerator(
    llmService: LLMService,
    directToolExecutor: DirectToolExecutor
  ) {
    return async function* (
      messages: any[],
      options: {
        provider?: string;
        model?: string;
        systemPrompt?: string;
        abortSignal?: AbortSignal;
        workspaceId?: string;
        sessionId?: string;
      }
    ) {
      try {
        const tools = await directToolExecutor.getAvailableTools();
        const streamOptions = {
          provider: options?.provider,
          model: options?.model,
          systemPrompt: options?.systemPrompt,
          sessionId: options?.sessionId,
          workspaceId: options?.workspaceId,
          tools: tools as any[],
        };

        for await (const chunk of llmService.generateResponseStream(messages, streamOptions)) {
          if (options?.abortSignal?.aborted) return;

          yield {
            chunk: chunk.chunk || '',
            complete: chunk.complete,
            toolCalls: chunk.toolCalls,
            reasoning: chunk.reasoning,
          };
        }
      } catch (error) {
        console.error('[SubagentController] Streaming error:', error);
        throw error;
      }
    };
  }

  /**
   * Create tool schema fetcher for SubagentExecutor
   */
  private createToolSchemaFetcher(directToolExecutor: DirectToolExecutor) {
    return async (agentName: string, toolSlugs: string[]): Promise<ToolSchemaInfo[]> => {
      try {
        const tools = await directToolExecutor.getAvailableTools() as Array<{ name?: string }>;
        return tools.filter(t => t.name && toolSlugs.includes(t.name)) as ToolSchemaInfo[];
      } catch {
        return [];
      }
    };
  }

  /**
   * Set up event handlers for SubagentExecutor
   */
  private setupEventHandlers(
    streamingController: StreamingController,
    toolEventCoordinator: ToolEventCoordinator
  ): void {
    if (!this.subagentExecutor) return;

    const eventHandlers = createSubagentEventHandlers();

    // Track streaming state per message
    let streamingInitialized = false;
    let currentStreamingMessageId = '';

    this.subagentExecutor.setEventHandlers({
      ...eventHandlers,
      onSubagentError: (subagentId: string, error: string) => {
        console.error('[SubagentController] Error:', subagentId, error);
        eventHandlers.onSubagentError?.(subagentId, error);
      },
      onStreamingUpdate: (branchId: string, messageId: string, chunk: string, isComplete: boolean, fullContent: string) => {
        // Only update if viewing this branch
        if (this.currentBranchContext?.branchId !== branchId) return;

        // Reset tracking if message changed
        if (messageId !== currentStreamingMessageId) {
          streamingInitialized = false;
          currentStreamingMessageId = messageId;
        }

        if (!streamingInitialized) {
          streamingController.startStreaming(messageId);
          streamingInitialized = true;
        }

        if (chunk) {
          streamingController.updateStreamingChunk(messageId, chunk);
        }

        if (isComplete) {
          streamingController.finalizeStreaming(messageId, fullContent);
          streamingInitialized = false;
          currentStreamingMessageId = '';
        }

        this.events.onStreamingUpdate(branchId, messageId, chunk, isComplete, fullContent);
      },
      onToolCallsDetected: (branchId: string, messageId: string, toolCalls: any[]) => {
        if (this.currentBranchContext?.branchId !== branchId) return;
        toolEventCoordinator.handleToolCallsDetected(messageId, toolCalls);
        this.events.onToolCallsDetected(branchId, messageId, toolCalls);
      },
    });
  }

  /**
   * Build context for subagent execution from current state
   */
  private buildSubagentContext(contextProvider: SubagentContextProvider) {
    const currentConversation = contextProvider.getCurrentConversation();
    const messages = currentConversation?.messages || [];
    const lastMessage = messages[messages.length - 1];
    const workspaceId = contextProvider.getSelectedWorkspaceId() || undefined;
    const sessionId = currentConversation?.metadata?.chatSettings?.sessionId || undefined;
    const selectedModel = contextProvider.getSelectedModel();
    const selectedAgent = contextProvider.getSelectedAgent();
    const workspaceData = contextProvider.getLoadedWorkspaceData();
    const contextNotes = contextProvider.getContextNotes() || [];
    const thinkingSettings = contextProvider.getThinkingSettings();

    return {
      conversationId: currentConversation?.id || 'unknown',
      messageId: lastMessage?.id || 'unknown',
      workspaceId,
      sessionId,
      source: 'internal' as const,
      isSubagentBranch: false,
      provider: selectedModel?.providerId,
      model: selectedModel?.modelId,
      agentPrompt: selectedAgent?.systemPrompt,
      agentName: selectedAgent?.name,
      workspaceData,
      contextNotes,
      thinkingEnabled: thinkingSettings?.enabled,
      thinkingEffort: thinkingSettings?.effort,
    };
  }

  /**
   * Get streaming branch messages for live UI updates
   */
  getStreamingBranchMessages(branchId: string) {
    return this.subagentExecutor?.getStreamingBranchMessages(branchId) || null;
  }

  /**
   * Cancel a running subagent
   */
  cancelSubagent(subagentId: string): boolean {
    if (!this.subagentExecutor) return false;
    const cancelled = this.subagentExecutor.cancelSubagent(subagentId);
    if (cancelled) {
      this.agentStatusMenu?.refresh();
    }
    return cancelled;
  }

  /**
   * Get agent status list for UI
   */
  getAgentStatusList(): AgentStatusItem[] {
    return this.subagentExecutor?.getAgentStatusList() || [];
  }

  /**
   * Clear agent status (call when switching conversations)
   */
  clearAgentStatus(): void {
    this.subagentExecutor?.clearAgentStatus();
    getSubagentEventBus().trigger('status-changed');
  }

  /**
   * Set current branch context (for event filtering)
   */
  setCurrentBranchContext(context: BranchViewContext | null): void {
    this.currentBranchContext = context;
  }

  /**
   * Get current branch context
   */
  getCurrentBranchContext(): BranchViewContext | null {
    return this.currentBranchContext;
  }

  /**
   * Update branch header context metadata
   */
  updateBranchHeaderMetadata(subagentId: string, updates: Partial<any>): void {
    const contextMetadata = this.currentBranchContext?.metadata;
    if (isSubagentMetadata(contextMetadata) && contextMetadata.subagentId === subagentId) {
      Object.assign(contextMetadata, updates);
    }
  }

  /**
   * Get branch service (for external queries)
   */
  getBranchService(): BranchService | null {
    return this.branchService;
  }

  /**
   * Get subagent executor (for external queries)
   */
  getSubagentExecutor(): SubagentExecutor | null {
    return this.subagentExecutor;
  }

  /**
   * Open the agent status modal
   */
  private openAgentStatusModal(contextProvider: SubagentContextProvider): void {
    if (!this.subagentExecutor) {
      console.warn('[SubagentController] SubagentExecutor not available');
      return;
    }

    const currentConversation = contextProvider.getCurrentConversation();
    const modal = new AgentStatusModal(
      this.app,
      this.subagentExecutor,
      {
        onViewBranch: (branchId) => {
          // This needs to be wired up by ChatView
          console.log('[SubagentController] View branch requested:', branchId);
        },
        onContinueAgent: (branchId) => {
          console.log('[SubagentController] Continue agent requested:', branchId);
        },
      },
      this.branchService,
      currentConversation?.id ?? null
    );
    modal.open();
  }

  /**
   * Open status modal with custom callbacks
   */
  openStatusModal(
    contextProvider: SubagentContextProvider,
    callbacks: {
      onViewBranch: (branchId: string) => void;
      onContinueAgent: (branchId: string) => void;
    }
  ): void {
    if (!this.subagentExecutor) {
      console.warn('[SubagentController] SubagentExecutor not available');
      return;
    }

    const currentConversation = contextProvider.getCurrentConversation();
    const modal = new AgentStatusModal(
      this.app,
      this.subagentExecutor,
      callbacks,
      this.branchService,
      currentConversation?.id ?? null
    );
    modal.open();
  }

  /**
   * Check if initialized
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Cleanup resources
   */
  cleanup(): void {
    this.agentStatusMenu?.cleanup();
    this.subagentExecutor = null;
    this.branchService = null;
    this.messageQueueService = null;
    this.initialized = false;
  }
}
