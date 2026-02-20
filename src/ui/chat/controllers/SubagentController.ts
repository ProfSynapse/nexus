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

import { App, Component, Notice } from 'obsidian';
import { BranchService } from '../../../services/chat/BranchService';
import { MessageQueueService } from '../../../services/chat/MessageQueueService';
import { SubagentExecutor } from '../../../services/chat/SubagentExecutor';
import { AgentStatusMenu, SubagentEventBus } from '../components/AgentStatusMenu';
import { AgentStatusModal } from '../components/AgentStatusModal';
import type { ChatService } from '../../../services/chat/ChatService';
import type { DirectToolExecutor } from '../../../services/chat/DirectToolExecutor';
import type { PromptManagerAgent } from '../../../agents/promptManager/promptManager';
import type { HybridStorageAdapter } from '../../../database/adapters/HybridStorageAdapter';
import type { LLMService } from '../../../services/llm/core/LLMService';
import type { ToolSchemaInfo, AgentStatusItem, BranchViewContext } from '../../../types/branch/BranchTypes';
import type { ConversationData } from '../../../types/chat/ChatTypes';
import type { Tool } from '../../../services/llm/adapters/types';
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
  promptManagerAgent: PromptManagerAgent;
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
  getSelectedPrompt: () => { name?: string; systemPrompt?: string } | null;
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
  onConversationNeedsRefresh?: (conversationId: string) => void;
}

export class SubagentController {
  private branchService: BranchService | null = null;
  private messageQueueService: MessageQueueService | null = null;
  private subagentExecutor: SubagentExecutor | null = null;
  private agentStatusMenu: AgentStatusMenu | null = null;
  private eventBus: SubagentEventBus;

  private currentBranchContext: BranchViewContext | null = null;
  private initialized = false;
  private navigationCallback: ((branchId: string) => void) | null = null;
  private continueCallback: ((branchId: string) => void) | null = null;

  // M7: Generation guard to prevent concurrent parent LLM responses
  private isGeneratingParentResponse = false;
  private pendingSubagentResults: Array<{
    chatService: ChatService;
    contextProvider: SubagentContextProvider;
    message: { content: string; metadata: Record<string, unknown>; conversationId: string };
  }> = [];

  // F5: Track active streaming branches for navigation resilience
  private activeStreamingBranches: Map<string, {
    messageId: string;
    streamingInitialized: boolean;
  }> = new Map();

  constructor(
    private app: App,
    private component: Component,
    private events: SubagentControllerEvents
  ) {
    this.eventBus = new SubagentEventBus();
  }

  /**
   * Set navigation callbacks (called by ChatView after initialization)
   */
  setNavigationCallbacks(callbacks: {
    onNavigateToBranch: (branchId: string) => void;
    onContinueAgent: (branchId: string) => void;
  }): void {
    this.navigationCallback = callbacks.onNavigateToBranch;
    this.continueCallback = callbacks.onContinueAgent;
  }

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

      // Create SubagentExecutor with instance-scoped EventBus
      this.subagentExecutor = new SubagentExecutor({
        branchService: this.branchService,
        messageQueueService: this.messageQueueService,
        directToolExecutor: deps.directToolExecutor,
        streamingGenerator: this.createStreamingGenerator(deps.llmService, deps.directToolExecutor),
        getToolSchemas: this.createToolSchemaFetcher(deps.directToolExecutor),
        eventBus: this.eventBus,
      });

      // Set event handlers
      this.setupEventHandlers(streamingController, toolEventCoordinator);

      // Wire up to PromptManagerAgent
      deps.promptManagerAgent.setSubagentExecutor(
        this.subagentExecutor,
        () => this.buildSubagentContext(contextProvider)
      );

      // Initialize status menu if container provided (pass instance-scoped eventBus)
      if (settingsButtonContainer && settingsButton) {
        this.agentStatusMenu = new AgentStatusMenu(
          settingsButtonContainer,
          this.subagentExecutor,
          { onOpenModal: () => this.openAgentStatusModal(contextProvider) },
          this.component,
          settingsButton,
          this.eventBus
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
      if (message.type !== 'subagent_result') {
        return;
      }

      try {
        const result = JSON.parse(message.content || '{}');
        const metadata = message.metadata || {};

        const conversationId = metadata.conversationId as string | undefined;
        if (!conversationId) {
          console.error('[SubagentController] No conversationId in metadata');
          return;
        }

        // Format result for display
        const taskLabel = (metadata.subagentTask as string) || 'Task';
        const resultContent = result.success
          ? `[Subagent "${taskLabel}" completed]\n\nResult:\n${result.result || 'Task completed successfully.'}`
          : `[Subagent "${taskLabel}" ${result.status === 'max_iterations' ? 'paused (max iterations)' : 'failed'}]\n\n${result.error || 'Unknown error'}`;

        // M7: Check generation guard — queue if parent LLM is already generating
        if (this.isGeneratingParentResponse) {
          this.pendingSubagentResults.push({
            chatService,
            contextProvider,
            message: { content: resultContent, metadata: metadata as Record<string, unknown>, conversationId },
          });
          return;
        }

        await this.processSubagentResult(chatService, contextProvider, resultContent, metadata as Record<string, unknown>, conversationId);
      } catch (error) {
        // M9: Show error to user instead of silent console log
        const taskLabel = (message.metadata?.subagentTask as string) || 'subagent';
        new Notice(`Subagent "${taskLabel}" result processing failed. Check console for details.`);
        console.error('[SubagentController] Processor error:', error);
      }
    });
  }

  /**
   * Process a single subagent result: add message and trigger parent LLM response
   * Extracted to support M7 generation guard queue draining.
   */
  private async processSubagentResult(
    chatService: ChatService,
    contextProvider: SubagentContextProvider,
    resultContent: string,
    metadata: Record<string, unknown>,
    conversationId: string
  ): Promise<void> {
    // Add result as user message
    await chatService.addMessage({
      conversationId,
      role: 'user',
      content: resultContent,
      metadata: {
        type: 'subagent_result',
        branchId: metadata.branchId,
        subagentId: metadata.subagentId,
        success: metadata.success ?? (metadata as Record<string, unknown>).success,
        iterations: metadata.iterations,
        isAutoGenerated: true,
      },
    });

    // Trigger LLM response with generation guard (M7) and lifecycle tracking (F8)
    const parentConversation = await chatService.getConversation(conversationId);
    if (parentConversation) {
      this.isGeneratingParentResponse = true;
      this.messageQueueService?.onGenerationStart();
      try {
        const generator = chatService.generateResponseStreaming(
          parentConversation.id,
          resultContent,
          {}
        );
        for await (const chunk of generator) {
          if (chunk.complete) {
            break;
          }
        }
        // Notify UI to refresh conversation display
        this.events.onConversationNeedsRefresh?.(conversationId);
      } catch (llmError) {
        // M9: Show error to user
        new Notice('Failed to generate response for subagent result. Check console for details.');
        console.error('[SubagentController] LLM response failed:', llmError);
      } finally {
        this.isGeneratingParentResponse = false;
        // F8: Signal generation complete so queued messages can process
        this.messageQueueService?.onGenerationComplete();
        // M7: Drain pending results sequentially
        await this.drainPendingResults(chatService, contextProvider);
      }
    } else {
      // M9: Show error to user
      new Notice('Could not load parent conversation for subagent result.');
      console.error('[SubagentController] Could not load parent conversation');
    }
  }

  /**
   * M7: Drain queued subagent results one at a time (sequential generation)
   */
  private async drainPendingResults(
    chatService: ChatService,
    contextProvider: SubagentContextProvider
  ): Promise<void> {
    while (this.pendingSubagentResults.length > 0 && !this.isGeneratingParentResponse) {
      const pending = this.pendingSubagentResults.shift()!;
      await this.processSubagentResult(
        pending.chatService,
        pending.contextProvider,
        pending.message.content,
        pending.message.metadata,
        pending.message.conversationId
      );
    }
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
        enableThinking?: boolean;
        thinkingEffort?: 'low' | 'medium' | 'high';
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
          tools: tools as Tool[],
          enableThinking: options?.enableThinking,
          thinkingEffort: options?.thinkingEffort,
        };

        for await (const chunk of llmService.generateResponseStream(messages, streamOptions)) {
          if (options?.abortSignal?.aborted) {
            // M6 fix: throw AbortError instead of silently returning
            // so SubagentExecutor can distinguish cancellation from completion
            throw new DOMException('Subagent streaming aborted', 'AbortError');
          }

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

    this.subagentExecutor.setEventHandlers({
      // Use instance-scoped eventBus instead of deprecated global
      onSubagentStarted: () => {
        this.eventBus.trigger('status-changed');
      },
      onSubagentProgress: () => {
        this.eventBus.trigger('status-changed');
      },
      onSubagentComplete: () => {
        this.eventBus.trigger('status-changed');
      },
      onSubagentError: (subagentId: string, error: string) => {
        console.error('[SubagentController] Error:', subagentId, error);
        this.eventBus.trigger('status-changed');
      },
      onStreamingUpdate: (branchId: string, messageId: string, chunk: string, isComplete: boolean, fullContent: string) => {
        // F5: Track streaming state per branch (not just current view)
        let branchState = this.activeStreamingBranches.get(branchId);
        if (!branchState || branchState.messageId !== messageId) {
          branchState = { messageId, streamingInitialized: false };
          this.activeStreamingBranches.set(branchId, branchState);
        }

        // Only update streaming controller if viewing this branch
        if (this.currentBranchContext?.branchId === branchId) {
          if (!branchState.streamingInitialized) {
            streamingController.startStreaming(messageId);
            branchState.streamingInitialized = true;
          }

          if (chunk) {
            streamingController.updateStreamingChunk(messageId, chunk);
          }

          if (isComplete) {
            streamingController.finalizeStreaming(messageId, fullContent);
          }
        }

        if (isComplete) {
          this.activeStreamingBranches.delete(branchId);
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
    const selectedPrompt = contextProvider.getSelectedPrompt();
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
      agentPrompt: selectedPrompt?.systemPrompt,
      agentName: selectedPrompt?.name,
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
    this.eventBus.trigger('status-changed');
  }

  /**
   * Set current branch context (for event filtering)
   * F5: When navigating to a branch that is actively streaming,
   * the streaming events will automatically render because the
   * onStreamingUpdate handler checks currentBranchContext on each chunk.
   * No duplicate bubble is created because activeStreamingBranches tracks
   * per-branch streaming state independently of navigation.
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
   * M10: Use spread instead of Object.assign to avoid mutating shared object
   * M3: Persist metadata updates to storage via BranchService
   */
  updateBranchHeaderMetadata(subagentId: string, updates: Partial<Record<string, unknown>>): void {
    if (!this.currentBranchContext) return;
    const contextMetadata = this.currentBranchContext.metadata;
    if (isSubagentMetadata(contextMetadata) && contextMetadata.subagentId === subagentId) {
      // M10: Create new object instead of mutating shared reference
      this.currentBranchContext = {
        ...this.currentBranchContext,
        metadata: { ...contextMetadata, ...updates },
      };

      // M3: Persist to storage so metadata survives reload
      if (this.branchService && this.currentBranchContext.branchId) {
        this.branchService.updateBranchMetadata(
          this.currentBranchContext.branchId,
          updates
        ).catch(error => {
          console.error('[SubagentController] Failed to persist branch metadata:', error);
        });
      }
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
      return;
    }

    const currentConversation = contextProvider.getCurrentConversation();
    const modal = new AgentStatusModal(
      this.app,
      this.subagentExecutor,
      {
        onViewBranch: (branchId) => {
          if (this.navigationCallback) {
            this.navigationCallback(branchId);
          }
        },
        onContinueAgent: (branchId) => {
          if (this.continueCallback) {
            this.continueCallback(branchId);
          }
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
    this.eventBus.destroy();
    this.subagentExecutor = null;
    this.branchService = null;
    this.messageQueueService = null;
    this.initialized = false;
    this.isGeneratingParentResponse = false;
    this.pendingSubagentResults = [];
    this.activeStreamingBranches.clear();
  }
}
