/**
 * ChatView - Clean orchestrator for the chat interface
 * Location: /src/ui/chat/ChatView.ts
 *
 * Coordinates between services, controllers, and UI components following SOLID principles.
 * This class is responsible for initialization, delegation, and high-level event coordination only.
 * Delegates UI construction to ChatLayoutBuilder, event binding to ChatEventBinder,
 * and tool event coordination to ToolEventCoordinator.
 */

import { ItemView, WorkspaceLeaf, setIcon, Plugin } from 'obsidian';
import { ConversationList } from './components/ConversationList';
import { MessageDisplay } from './components/MessageDisplay';
import { ChatInput } from './components/ChatInput';
import { ContextProgressBar } from './components/ContextProgressBar';
import { ChatSettingsModal } from './components/ChatSettingsModal';
import { ChatService } from '../../services/chat/ChatService';
import { ConversationData, ConversationMessage } from '../../types/chat/ChatTypes';
import { MessageEnhancement } from './components/suggesters/base/SuggesterInterfaces';
import type { ServiceManager } from '../../core/ServiceManager';
import type NexusPlugin from '../../main';
import type { WorkspaceService } from '../../services/WorkspaceService';

// Services
import { ConversationManager, ConversationManagerEvents } from './services/ConversationManager';
import { MessageManager, MessageManagerEvents } from './services/MessageManager';
import { ModelAgentManager, ModelAgentManagerEvents } from './services/ModelAgentManager';
import { BranchManager, BranchManagerEvents } from './services/BranchManager';

// Controllers
import { UIStateController, UIStateControllerEvents } from './controllers/UIStateController';
import { StreamingController } from './controllers/StreamingController';

// Coordinators
import { ToolEventCoordinator } from './coordinators/ToolEventCoordinator';

// Builders and Utilities
import { ChatLayoutBuilder, ChatLayoutElements } from './builders/ChatLayoutBuilder';
import { ChatEventBinder } from './utils/ChatEventBinder';

// Utils
import { TokenCalculator } from './utils/TokenCalculator';
import { ReferenceMetadata } from './utils/ReferenceExtractor';
import { CHAT_VIEW_TYPES } from '../../constants/branding';
import { getNexusPlugin } from '../../utils/pluginLocator';

// Nexus Lifecycle
import { getWebLLMLifecycleManager } from '../../services/llm/adapters/webllm/WebLLMLifecycleManager';

// Subagent infrastructure
import { BranchService } from '../../services/chat/BranchService';
import { MessageQueueService } from '../../services/chat/MessageQueueService';
import { SubagentExecutor } from '../../services/chat/SubagentExecutor';
import type { AgentManager } from '../../services/AgentManager';
import type { DirectToolExecutor } from '../../services/chat/DirectToolExecutor';
import type { AgentManagerAgent } from '../../agents/agentManager/agentManager';
import type { ToolSchemaInfo } from '../../types/branch/BranchTypes';
import { isSubagentMetadata } from '../../types/branch/BranchTypes';
import type { HybridStorageAdapter } from '../../database/adapters/HybridStorageAdapter';

// Subagent UI components
import { AgentStatusMenu } from './components/AgentStatusMenu';
import { AgentStatusModal } from './components/AgentStatusModal';
import { BranchHeader, BranchViewContext } from './components/BranchHeader';

export const CHAT_VIEW_TYPE = CHAT_VIEW_TYPES.current;

export class ChatView extends ItemView {
  // Core components
  private conversationList!: ConversationList;
  private messageDisplay!: MessageDisplay;
  private chatInput!: ChatInput;
  private contextProgressBar!: ContextProgressBar;

  // Services
  private conversationManager!: ConversationManager;
  private messageManager!: MessageManager;
  private modelAgentManager!: ModelAgentManager;
  private branchManager!: BranchManager;

  // Controllers and Coordinators
  private uiStateController!: UIStateController;
  private streamingController!: StreamingController;
  private toolEventCoordinator!: ToolEventCoordinator;

  // Subagent infrastructure
  private branchService: BranchService | null = null;
  private messageQueueService: MessageQueueService | null = null;
  private subagentExecutor: SubagentExecutor | null = null;

  // Subagent UI components
  private agentStatusMenu: AgentStatusMenu | null = null;
  private branchHeader: BranchHeader | null = null;
  private currentBranchContext: BranchViewContext | null = null;

  // Layout elements
  private layoutElements!: ChatLayoutElements;

  constructor(leaf: WorkspaceLeaf, private chatService: ChatService) {
    super(leaf);
  }

  getViewType(): string {
    return CHAT_VIEW_TYPE;
  }

  getDisplayText(): string {
    const conversation = this.conversationManager?.getCurrentConversation();
    return conversation?.title || 'Nexus Chat';
  }

  getIcon(): string {
    return 'message-square';
  }

  async onOpen(): Promise<void> {
    if (!this.chatService) {
      return;
    }

    try {
      await this.chatService.initialize();

      // Set up tool event callback for live UI updates
      this.chatService.setToolEventCallback((messageId, event, data) => {
        this.handleToolEvent(messageId, event, data);
      });

    } catch (error) {
      // ChatService initialization failed
    }

    this.initializeArchitecture();

    // Check if database is still loading and show overlay
    await this.waitForDatabaseReady();

    await this.loadInitialData();

    // Set up Nexus lifecycle callbacks for loading indicator
    const lifecycleManager = getWebLLMLifecycleManager();
    lifecycleManager.setCallbacks({
      onLoadingStart: () => this.showNexusLoadingOverlay(),
      onLoadingProgress: (progress, stage) => this.updateNexusLoadingProgress(progress, stage),
      onLoadingComplete: () => this.hideNexusLoadingOverlay(),
      onError: (error) => {
        this.hideNexusLoadingOverlay();
        console.error('[ChatView] Nexus loading error:', error);
      }
    });

    // Notify Nexus lifecycle manager that ChatView is open
    // This triggers pre-loading if Nexus is the default provider
    lifecycleManager.handleChatViewOpened().catch(() => {
      // Silently handle errors
    });
  }

  /**
   * Wait for database to be ready, showing loading overlay if needed
   */
  private async waitForDatabaseReady(): Promise<void> {
    const plugin = getNexusPlugin<NexusPlugin>(this.app);
    if (!plugin) return;

    try {
      const storageAdapter = await plugin.getService<{ isReady?: () => boolean; waitForReady?: () => Promise<boolean> }>('hybridStorageAdapter');
      if (!storageAdapter) return;

      // If already ready, no need to show overlay
      if (storageAdapter.isReady?.()) {
        return;
      }

      // Show loading overlay while waiting
      this.showDatabaseLoadingOverlay();

      // Wait for database to be ready
      const success = await storageAdapter.waitForReady?.();

      // Hide overlay
      this.hideDatabaseLoadingOverlay();
    } catch (error) {
      this.hideDatabaseLoadingOverlay();
    }
  }

  /**
   * Show database loading overlay
   */
  private showDatabaseLoadingOverlay(): void {
    const overlay = this.layoutElements?.loadingOverlay;
    if (!overlay) return;

    // Update text for database loading
    const statusEl = overlay.querySelector('[data-status-el]');
    if (statusEl) statusEl.textContent = 'Loading database...';

    overlay.addClass('chat-loading-overlay-visible');
    overlay.offsetHeight; // Trigger reflow
    overlay.addClass('is-visible');
  }

  /**
   * Hide database loading overlay
   */
  private hideDatabaseLoadingOverlay(): void {
    const overlay = this.layoutElements?.loadingOverlay;
    if (!overlay) return;

    overlay.removeClass('is-visible');
    setTimeout(() => {
      overlay.removeClass('chat-loading-overlay-visible');
      overlay.addClass('chat-loading-overlay-hidden');
      // Reset text for potential Nexus loading later
      const statusEl = overlay.querySelector('[data-status-el]');
      if (statusEl) statusEl.textContent = 'Loading Nexus model...';
    }, 300);
  }

  async onClose(): Promise<void> {
    // Notify Nexus lifecycle manager that ChatView is closing
    // This starts the idle timer for potential model unloading
    const lifecycleManager = getWebLLMLifecycleManager();
    lifecycleManager.handleChatViewClosed();

    this.cleanup();
  }

  /**
   * Initialize the clean architecture components
   */
  private initializeArchitecture(): void {
    this.createChatInterface();
    this.initializeServices();
    this.initializeControllers();
    this.initializeComponents();
    this.wireEventHandlers();

    // Initialize subagent infrastructure (async, non-blocking)
    this.initializeSubagentInfrastructure().catch((error) => {
      console.error('[ChatView] Failed to initialize subagent infrastructure:', error);
    });
  }

  /**
   * Create the main chat interface layout using builder
   */
  private createChatInterface(): void {
    const container = this.containerEl.children[1] as HTMLElement;
    this.layoutElements = ChatLayoutBuilder.buildLayout(container);
  }

  /**
   * Initialize business logic services
   */
  private initializeServices(): void {
    // Branch management
    const branchEvents: BranchManagerEvents = {
      onBranchCreated: (messageId: string, branchId: string) => this.handleBranchCreated(messageId, branchId),
      onBranchSwitched: (messageId: string, branchId: string) => this.handleBranchSwitched(messageId, branchId),
      onError: (message) => this.uiStateController.showError(message)
    };
    this.branchManager = new BranchManager(this.chatService.getConversationRepository(), branchEvents);

    // Conversation management
    const conversationEvents: ConversationManagerEvents = {
      onConversationSelected: (conversation) => this.handleConversationSelected(conversation),
      onConversationsChanged: () => this.handleConversationsChanged(),
      onError: (message) => this.uiStateController.showError(message)
    };
    this.conversationManager = new ConversationManager(this.app, this.chatService, this.branchManager, conversationEvents);

    // Message handling
    const messageEvents: MessageManagerEvents = {
      onMessageAdded: (message) => this.messageDisplay.addMessage(message),
      onAIMessageStarted: (message) => this.handleAIMessageStarted(message),
      onStreamingUpdate: (messageId, content, isComplete, isIncremental) =>
        this.handleStreamingUpdate(messageId, content, isComplete, isIncremental),
      onConversationUpdated: (conversation) => this.handleConversationUpdated(conversation),
      onLoadingStateChanged: (loading) => this.handleLoadingStateChanged(loading),
      onError: (message) => this.uiStateController.showError(message),
      onToolCallsDetected: (messageId, toolCalls) => this.toolEventCoordinator.handleToolCallsDetected(messageId, toolCalls),
      onToolExecutionStarted: (messageId, toolCall) => this.toolEventCoordinator.handleToolExecutionStarted(messageId, toolCall),
      onToolExecutionCompleted: (messageId, toolId, result, success, error) =>
        this.toolEventCoordinator.handleToolExecutionCompleted(messageId, toolId, result, success, error),
      onMessageIdUpdated: (oldId, newId, updatedMessage) => this.handleMessageIdUpdated(oldId, newId, updatedMessage),
      onGenerationAborted: (messageId, partialContent) => this.handleGenerationAborted(messageId, partialContent)
    };
    this.messageManager = new MessageManager(this.chatService, this.branchManager, messageEvents);

    // Model and agent management
    const modelAgentEvents: ModelAgentManagerEvents = {
      onModelChanged: (model) => this.handleModelChanged(model),
      onAgentChanged: (agent) => this.handleAgentChanged(agent),
      onSystemPromptChanged: () => this.updateContextProgress()
    };
    this.modelAgentManager = new ModelAgentManager(
      this.app,
      modelAgentEvents,
      this.chatService.getConversationService()
    );
  }

  /**
   * Initialize UI controllers and coordinators
   */
  private initializeControllers(): void {
    const uiStateEvents: UIStateControllerEvents = {
      onSidebarToggled: (visible) => { /* Sidebar toggled */ }
    };
    this.uiStateController = new UIStateController(this.containerEl, uiStateEvents, this);
    this.uiStateController.setOpenSettingsCallback(() => this.openChatSettingsModal());
    this.streamingController = new StreamingController(this.containerEl, this.app, this);
  }

  /**
   * Initialize UI components
   */
  private initializeComponents(): void {
    this.conversationList = new ConversationList(
      this.layoutElements.conversationListContainer,
      (conversation) => this.conversationManager.selectConversation(conversation),
      (conversationId) => this.conversationManager.deleteConversation(conversationId),
      (conversationId, newTitle) => this.conversationManager.renameConversation(conversationId, newTitle),
      this // Pass Component for registerDomEvent
    );

    this.messageDisplay = new MessageDisplay(
      this.layoutElements.messageContainer,
      this.app,
      this.branchManager,
      (messageId) => this.handleRetryMessage(messageId),
      (messageId, newContent) => this.handleEditMessage(messageId, newContent),
      (messageId, event, data) => this.handleToolEvent(messageId, event, data),
      (messageId: string, alternativeIndex: number) => this.handleBranchSwitchedByIndex(messageId, alternativeIndex),
      (branchId: string) => this.navigateToBranch(branchId)
    );

    // Initialize tool event coordinator after messageDisplay is created
    this.toolEventCoordinator = new ToolEventCoordinator(this.messageDisplay);

    this.chatInput = new ChatInput(
      this.layoutElements.inputContainer,
      (message, enhancement, metadata) => this.handleSendMessage(message, enhancement, metadata),
      () => this.messageManager.getIsLoading(),
      this.app,
      () => this.handleStopGeneration(),
      () => this.conversationManager.getCurrentConversation() !== null,
      this // Pass Component for registerDomEvent
    );

    this.contextProgressBar = new ContextProgressBar(
      this.layoutElements.contextContainer,
      () => this.getContextUsage(),
      () => this.getConversationCost()
    );

    // Update conversation list if conversations were already loaded
    const conversations = this.conversationManager.getConversations();
    if (conversations.length > 0) {
      this.conversationList.setConversations(conversations);
    }
  }

  /**
   * Wire up event handlers using event binder
   */
  private wireEventHandlers(): void {
    ChatEventBinder.bindNewChatButton(
      this.layoutElements.newChatButton,
      () => this.conversationManager.createNewConversation(),
      this
    );

    ChatEventBinder.bindSettingsButton(
      this.layoutElements.settingsButton,
      () => this.openChatSettingsModal(),
      this
    );

    this.uiStateController.initializeEventListeners();
  }

  /**
   * Initialize subagent infrastructure (SubagentExecutor, BranchService, MessageQueueService)
   * This is async and non-blocking - subagent features will be available once this completes
   */
  private async initializeSubagentInfrastructure(): Promise<void> {
    try {
      const plugin = getNexusPlugin<NexusPlugin>(this.app);
      if (!plugin) {
        return;
      }

      // Get required services
      const directToolExecutor = await plugin.getService<DirectToolExecutor>('directToolExecutor');
      if (!directToolExecutor) {
        return;
      }

      const agentManager = await plugin.getService<AgentManager>('agentManager');
      if (!agentManager) {
        return;
      }

      // Get the AgentManagerAgent which has the subagent tools
      const agentManagerAgent = agentManager.getAgent('agentManager') as AgentManagerAgent | null;
      if (!agentManagerAgent) {
        return;
      }

      // Get HybridStorageAdapter for BranchRepository
      const storageAdapter = await plugin.getService<HybridStorageAdapter>('hybridStorageAdapter');
      if (!storageAdapter) {
        return;
      }
      const branchRepository = storageAdapter.getBranchRepository();

      // Create BranchService with repository (eliminates race conditions)
      const conversationService = this.chatService.getConversationService();
      this.branchService = new BranchService({
        branchRepository,
        conversationService,
      });

      // Create MessageQueueService
      this.messageQueueService = new MessageQueueService();
      this.messageQueueService.setProcessor(async (message) => {
        if (message.type === 'subagent_result') {
          try {
            // Parse the result
            const result = JSON.parse(message.content || '{}');
            const metadata = message.metadata || {};

            // Get the parent conversation
            const conversationId = metadata.conversationId;
            if (!conversationId) {
              return;
            }

            // Format the result for display
            const resultSummary = result.success
              ? `Subagent completed: ${result.result?.substring?.(0, 500) || 'Task complete'}`
              : `Subagent ${result.status === 'max_iterations' ? 'paused (max iterations)' : 'failed'}: ${result.error || 'Unknown error'}`;

            // Add tool result message to parent conversation via ChatService
            await this.chatService.addMessage({
              conversationId,
              role: 'assistant',
              content: `**[Subagent Result: ${metadata.subagentTask || 'Task'}]**\n\n${resultSummary}`,
              metadata: {
                type: 'subagent_result',
                branchId: metadata.branchId,
                subagentId: metadata.subagentId,
                success: result.success,
                iterations: result.iterations,
              },
            });

            // Refresh UI if viewing the parent conversation
            const currentConversation = this.conversationManager.getCurrentConversation();
            if (currentConversation?.id === conversationId && !this.isViewingBranch()) {
              // Re-render the conversation to show the new message
              const updated = await this.chatService.getConversation(conversationId);
              if (updated) {
                this.messageDisplay.setConversation(updated);
              }
            }

          } catch (error) {
            console.error('[Subagent] Failed to process result:', error);
          }
        }
      });

      // Get LLM service for streaming
      const llmService = this.chatService.getLLMService();
      if (!llmService) {
        return;
      }

      // Create SubagentExecutor with real LLM streaming
      const self = this;
      this.subagentExecutor = new SubagentExecutor({
        branchService: this.branchService,
        messageQueueService: this.messageQueueService,
        directToolExecutor: directToolExecutor,
        streamingGenerator: async function* (messages, options) {
          try {
            // Get available tools for the subagent
            const tools = await directToolExecutor.getAvailableTools();

            // Use the LLMService's generateResponseStream for real streaming
            const streamOptions = {
              provider: options?.provider,
              model: options?.model,
              systemPrompt: options?.systemPrompt,
              sessionId: options?.sessionId,
              workspaceId: options?.workspaceId,
              tools: tools as any[], // Pass tools so LLM can make tool calls
            };

            for await (const chunk of llmService.generateResponseStream(messages, streamOptions)) {
              if (options?.abortSignal?.aborted) {
                return;
              }

              yield {
                chunk: chunk.chunk || '',
                complete: chunk.complete,
                toolCalls: chunk.toolCalls,
                reasoning: chunk.reasoning,
              };
            }

          } catch (error) {
            console.error('[Subagent] Streaming error:', error);
            throw error;
          }
        },
        getToolSchemas: async (agentName: string, toolSlugs: string[]): Promise<ToolSchemaInfo[]> => {
          try {
            const tools = await directToolExecutor.getAvailableTools() as Array<{ name?: string }>;
            return tools.filter(t => t.name && toolSlugs.includes(t.name)) as ToolSchemaInfo[];
          } catch {
            return [];
          }
        },
      });

      // Set event handlers (minimal logging)
      this.subagentExecutor.setEventHandlers({
        onSubagentStarted: () => {
          // AgentStatusMenu will update automatically
        },
        onSubagentProgress: () => {
          // Progress is tracked internally
        },
        onSubagentComplete: () => {
          // Completion handled by queueResultToParent
        },
        onSubagentError: (subagentId: string, error: string) => {
          console.error('[Subagent] Error:', subagentId, error);
        },
      });

      // Wire up the executor to the AgentManagerAgent's subagent tool
      // Context provider passes ALL parent settings to be inherited by subagent
      agentManagerAgent.setSubagentExecutor(this.subagentExecutor, () => {
        const currentConversation = this.conversationManager?.getCurrentConversation();
        const messages = currentConversation?.messages || [];
        const lastMessage = messages[messages.length - 1];
        const workspaceId = this.modelAgentManager?.getSelectedWorkspaceId() || undefined;
        const sessionId = currentConversation?.metadata?.chatSettings?.sessionId || undefined;

        // Get current model settings to pass to subagent
        const selectedModel = this.modelAgentManager?.getSelectedModel();

        // Get current agent settings
        const selectedAgent = this.modelAgentManager?.getSelectedAgent();

        // Get workspace data (full comprehensive data, not just ID)
        const workspaceData = this.modelAgentManager?.getLoadedWorkspaceData();

        // Get context notes (file paths)
        const contextNotes = this.modelAgentManager?.getContextNotes() || [];

        // Get thinking settings
        const thinkingSettings = this.modelAgentManager?.getThinkingSettings();

        return {
          conversationId: currentConversation?.id || 'unknown',
          messageId: lastMessage?.id || 'unknown',
          workspaceId,
          sessionId,
          source: 'internal' as const,
          isSubagentBranch: false,
          // Inherit parent's model settings
          provider: selectedModel?.providerId,
          model: selectedModel?.modelId,
          // Inherit parent's agent settings
          agentPrompt: selectedAgent?.systemPrompt,
          agentName: selectedAgent?.name,
          // Inherit parent's workspace data (full comprehensive data)
          workspaceData,
          // Inherit parent's context notes (file paths to include)
          contextNotes,
          // Inherit parent's thinking settings
          thinkingEnabled: thinkingSettings?.enabled,
          thinkingEffort: thinkingSettings?.effort,
        };
      });

      // Initialize AgentStatusMenu in the header
      if (this.layoutElements.settingsButton?.parentElement) {
        this.agentStatusMenu = new AgentStatusMenu(
          this.layoutElements.settingsButton.parentElement,
          this.subagentExecutor,
          {
            onOpenModal: () => this.openAgentStatusModal(),
          },
          this
        );
        this.agentStatusMenu.render();
      }

    } catch (error) {
      console.error('[ChatView] Failed to initialize subagent infrastructure:', error);
      throw error;
    }
  }

  /**
   * Open chat settings modal
   */
  private async openChatSettingsModal(): Promise<void> {
    const plugin = getNexusPlugin<NexusPlugin>(this.app);
    if (!plugin) {
      console.error('[ChatView] Plugin not found');
      return;
    }

    const workspaceService = await plugin.getService<WorkspaceService>('workspaceService');
    if (!workspaceService) {
      console.error('[ChatView] WorkspaceService not available');
      return;
    }

    const currentConversation = this.conversationManager.getCurrentConversation();

    if (currentConversation) {
      // Access private property via type assertion - currentConversationId exists but is private
      (this.modelAgentManager as unknown as { currentConversationId: string | null }).currentConversationId = currentConversation.id;
    }

    const modal = new ChatSettingsModal(
      this.app,
      currentConversation?.id || null,
      workspaceService,
      this.modelAgentManager
    );
    modal.open();
  }

  /**
   * Load initial data
   */
  private async loadInitialData(): Promise<void> {
    await this.conversationManager.loadConversations();

    const conversations = this.conversationManager.getConversations();
    if (conversations.length === 0) {
      // Initialize with defaults (model, workspace, agent) for new chats
      await this.modelAgentManager.initializeDefaults();

      const hasProviders = this.chatService.hasConfiguredProviders();
      this.uiStateController.showWelcomeState(hasProviders);
      if (this.chatInput) {
        this.chatInput.setConversationState(false);
      }
      if (hasProviders) {
        this.wireWelcomeButton();
      }
    }
  }

  /**
   * Wire up the welcome screen button
   */
  private wireWelcomeButton(): void {
    ChatEventBinder.bindWelcomeButton(
      this.containerEl,
      () => this.conversationManager.createNewConversation(),
      this
    );
  }

  // Event Handlers

  private async handleConversationSelected(conversation: ConversationData): Promise<void> {
    // Cancel any ongoing generation from the previous conversation
    // This prevents the loading state from blocking the new conversation
    if (this.messageManager.getIsLoading()) {
      this.messageManager.cancelCurrentGeneration();
      this.streamingController.cleanup();
    }

    // Access private property via type assertion - currentConversationId exists but is private
    (this.modelAgentManager as unknown as { currentConversationId: string | null }).currentConversationId = conversation.id;
    await this.modelAgentManager.initializeFromConversation(conversation.id);
    this.messageDisplay.setConversation(conversation);
    this.updateChatTitle();
    this.uiStateController.setInputPlaceholder('Type your message...');
    this.updateContextProgress();

    if (this.chatInput) {
      this.chatInput.setConversationState(true);
    }

    if (this.uiStateController.getSidebarVisible()) {
      this.uiStateController.toggleConversationList();
    }
  }

  private async handleConversationsChanged(): Promise<void> {
    if (this.conversationList) {
      this.conversationList.setConversations(this.conversationManager.getConversations());
    }

    const conversations = this.conversationManager.getConversations();
    const currentConversation = this.conversationManager.getCurrentConversation();

    if (conversations.length === 0) {
      // Re-initialize with defaults when returning to welcome state
      await this.modelAgentManager.initializeDefaults();

      const hasProviders = this.chatService.hasConfiguredProviders();
      this.uiStateController.showWelcomeState(hasProviders);
      if (this.chatInput) {
        this.chatInput.setConversationState(false);
      }
      if (hasProviders) {
        this.wireWelcomeButton();
      }
    } else if (!currentConversation && conversations.length > 0) {
      await this.conversationManager.selectConversation(conversations[0]);
    }
  }

  private handleAIMessageStarted(message: ConversationMessage): void {
    this.messageDisplay.addAIMessage(message);
  }

  private handleStreamingUpdate(messageId: string, content: string, isComplete: boolean, isIncremental?: boolean): void {
    const currentConversation = this.conversationManager?.getCurrentConversation();
    const message = currentConversation?.messages.find((m) => m.id === messageId);
    const isRetry = message && message.branches && message.branches.length > 0;

    if (isIncremental) {
      this.streamingController.updateStreamingChunk(messageId, content);
    } else if (isComplete) {
      this.streamingController.finalizeStreaming(messageId, content);
      this.messageDisplay.updateMessageContent(messageId, content);
    } else {
      this.streamingController.startStreaming(messageId);
      this.streamingController.updateStreamingChunk(messageId, content);
    }
  }

  private handleConversationUpdated(conversation: ConversationData): void {
    this.conversationManager.updateCurrentConversation(conversation);
    this.messageDisplay.setConversation(conversation);
    this.updateChatTitle();

    this.updateContextProgress();
  }

  private async handleSendMessage(
    message: string,
    enhancement?: MessageEnhancement,
    metadata?: ReferenceMetadata
  ): Promise<void> {
    const currentConversation = this.conversationManager.getCurrentConversation();

    if (!currentConversation) {
      return;
    }

    try {
      if (enhancement) {
        this.modelAgentManager.setMessageEnhancement(enhancement);
      }

      const messageOptions = await this.modelAgentManager.getMessageOptions();

      await this.messageManager.sendMessage(
        currentConversation,
        message,
        messageOptions,
        metadata
      );
    } finally {
      this.modelAgentManager.clearMessageEnhancement();
      this.chatInput?.clearMessageEnhancer();
    }
  }

  private async handleRetryMessage(messageId: string): Promise<void> {
    const currentConversation = this.conversationManager.getCurrentConversation();
    if (currentConversation) {
      const messageOptions = await this.modelAgentManager.getMessageOptions();
      await this.messageManager.handleRetryMessage(
        currentConversation,
        messageId,
        messageOptions
      );
    }
  }

  private async handleEditMessage(messageId: string, newContent: string): Promise<void> {
    const currentConversation = this.conversationManager.getCurrentConversation();
    if (currentConversation) {
      const messageOptions = await this.modelAgentManager.getMessageOptions();
      await this.messageManager.handleEditMessage(
        currentConversation,
        messageId,
        newContent,
        messageOptions
      );
    }
  }

  private handleStopGeneration(): void {
    this.messageManager.cancelCurrentGeneration();
  }

  private handleGenerationAborted(messageId: string, partialContent: string): void {
    const messageBubble = this.messageDisplay.findMessageBubble(messageId);
    if (messageBubble) {
      messageBubble.stopLoadingAnimation();
    }

    const messageElement = this.containerEl.querySelector(`[data-message-id="${messageId}"]`);
    if (messageElement) {
      const contentElement = messageElement.querySelector('.message-bubble .message-content');
      if (contentElement) {
        this.streamingController.stopLoadingAnimation(contentElement);
      }
    }

    this.streamingController.finalizeStreaming(messageId, partialContent);
  }

  private handleLoadingStateChanged(loading: boolean): void {
    if (this.chatInput) {
      this.chatInput.setLoading(loading);
    }
  }

  private handleModelChanged(model: any | null): void {
    this.updateContextProgress();
  }

  private handleAgentChanged(agent: any | null): void {
    // Agent changed
  }

  private async getContextUsage() {
    const conversation = this.conversationManager.getCurrentConversation();
    const selectedModel = await this.modelAgentManager.getSelectedModelOrDefault();

    const usage = await TokenCalculator.getContextUsage(
      selectedModel,
      conversation,
      await this.modelAgentManager.getCurrentSystemPrompt()
    );
    return usage;
  }

  private getConversationCost(): { totalCost: number; currency: string } | null {
    const conversation = this.conversationManager.getCurrentConversation();
    if (!conversation) return null;

    // Prefer structured cost field if present
    if (conversation.cost?.totalCost !== undefined) {
      return {
        totalCost: conversation.cost.totalCost,
        currency: conversation.cost.currency || 'USD'
      };
    }

    // Fallback to metadata (legacy)
    if (conversation.metadata?.cost?.totalCost !== undefined) {
      return {
        totalCost: conversation.metadata.cost.totalCost,
        currency: conversation.metadata.cost.currency || 'USD'
      };
    }

    if (conversation.metadata?.totalCost !== undefined) {
      return {
        totalCost: conversation.metadata.totalCost,
        currency: conversation.metadata.currency || 'USD'
      };
    }

    return null;
  }

  private async updateContextProgress(): Promise<void> {
    if (this.contextProgressBar) {
      await this.contextProgressBar.update();
      this.contextProgressBar.checkWarningThresholds();
    }
  }

  private updateChatTitle(): void {
    const conversation = this.conversationManager.getCurrentConversation();

    if (this.layoutElements.chatTitle) {
      this.layoutElements.chatTitle.textContent = conversation?.title || 'Nexus Chat';
    }
  }

  // Tool event handlers delegated to coordinator

  private handleToolEvent(messageId: string, event: 'detected' | 'updated' | 'started' | 'completed', data: any): void {
    this.toolEventCoordinator.handleToolEvent(messageId, event, data);
  }

  private handleMessageIdUpdated(oldId: string, newId: string, updatedMessage: ConversationMessage): void {
    this.messageDisplay.updateMessageId(oldId, newId, updatedMessage);
  }

  // Branch event handlers

  private handleBranchCreated(messageId: string, branchId: string): void {
    const currentConversation = this.conversationManager.getCurrentConversation();
    if (currentConversation) {
      this.messageDisplay.setConversation(currentConversation);
    }
  }

  private async handleBranchSwitched(messageId: string, branchId: string): Promise<void> {
    const currentConversation = this.conversationManager.getCurrentConversation();
    if (currentConversation) {
      const success = await this.branchManager.switchToBranch(
        currentConversation,
        messageId,
        branchId
      );

      if (success) {
        const updatedMessage = currentConversation.messages.find(msg => msg.id === messageId);
        if (updatedMessage) {
          this.messageDisplay.updateMessage(messageId, updatedMessage);
        }
      }
    }
  }

  /**
   * Handle branch switch by index (for MessageDisplay callback compatibility)
   */
  private async handleBranchSwitchedByIndex(messageId: string, alternativeIndex: number): Promise<void> {
    const currentConversation = this.conversationManager.getCurrentConversation();
    if (currentConversation) {
      const success = await this.branchManager.switchToBranchByIndex(
        currentConversation,
        messageId,
        alternativeIndex
      );

      if (success) {
        const updatedMessage = currentConversation.messages.find(msg => msg.id === messageId);
        if (updatedMessage) {
          this.messageDisplay.updateMessage(messageId, updatedMessage);
        }
      }
    }
  }

  // Nexus loading overlay methods

  /**
   * Show the Nexus model loading overlay
   */
  private showNexusLoadingOverlay(): void {
    const overlay = this.layoutElements?.loadingOverlay;
    if (!overlay) return;

    overlay.addClass('chat-loading-overlay-visible');
    // Trigger reflow for animation
    overlay.offsetHeight;
    overlay.addClass('is-visible');
  }

  /**
   * Update Nexus loading progress
   */
  private updateNexusLoadingProgress(progress: number, stage: string): void {
    const overlay = this.layoutElements?.loadingOverlay;
    if (!overlay) return;

    const statusEl = overlay.querySelector('[data-status-el]');
    const progressBar = overlay.querySelector('[data-progress-el]') as HTMLElement;
    const progressText = overlay.querySelector('[data-progress-text-el]');

    const percent = Math.round(progress * 100);

    if (statusEl) {
      statusEl.textContent = stage || 'Loading Nexus model...';
    }

    if (progressBar) {
      progressBar.style.setProperty('width', `${percent}%`);
    }

    if (progressText) {
      progressText.textContent = `${percent}%`;
    }
  }

  /**
   * Hide the Nexus model loading overlay
   */
  private hideNexusLoadingOverlay(): void {
    const overlay = this.layoutElements?.loadingOverlay;
    if (!overlay) return;

    overlay.removeClass('is-visible');

    // Wait for transition then hide
    setTimeout(() => {
      overlay.removeClass('chat-loading-overlay-visible');
      overlay.addClass('chat-loading-overlay-hidden');

      // Reset progress
      const progressBar = overlay.querySelector('[data-progress-el]') as HTMLElement;
      const progressText = overlay.querySelector('[data-progress-text-el]');
      const statusEl = overlay.querySelector('[data-status-el]');

      if (progressBar) progressBar.addClass('chat-progress-bar-reset');
      if (progressText) progressText.textContent = '0%';
      if (statusEl) statusEl.textContent = 'Loading Nexus model...';
    }, 300);
  }

  // Branch navigation methods for subagent viewing

  /**
   * Navigate to a specific branch (subagent or human)
   * Shows the branch messages in the message display with a back header
   */
  async navigateToBranch(branchId: string): Promise<void> {
    console.log('[Branch] → Navigating to branch:', branchId);

    if (!this.branchService) {
      console.warn('[ChatView] BranchService not available - cannot navigate to branch');
      return;
    }

    const currentConversation = this.conversationManager.getCurrentConversation();
    if (!currentConversation) {
      console.warn('[ChatView] No current conversation - cannot navigate to branch');
      return;
    }

    try {
      const branchInfo = await this.branchService.getBranch(currentConversation.id, branchId);
      if (!branchInfo) {
        console.warn('[ChatView] Branch not found:', branchId);
        return;
      }

      // Build the branch view context
      this.currentBranchContext = {
        conversationId: currentConversation.id,
        branchId,
        parentMessageId: branchInfo.parentMessageId,
        branchType: branchInfo.branch.type,
        metadata: branchInfo.branch.metadata as any,
      };

      // Display branch messages FIRST (this clears the container)
      // Create a temporary conversation-like structure for the branch
      const branchMetadata = branchInfo.branch.metadata;
      const branchTitle = isSubagentMetadata(branchMetadata)
        ? branchMetadata.task
        : 'Alternative';
      const branchConversation: ConversationData = {
        id: branchId,
        title: `Branch: ${branchTitle}`,
        messages: branchInfo.branch.messages,
        created: branchInfo.branch.created,
        updated: branchInfo.branch.updated,
      };

      this.messageDisplay.setConversation(branchConversation);
      console.log('[Branch] Displaying', branchInfo.branch.messages.length, 'messages');

      // Show branch header AFTER setConversation (which empties the container)
      if (!this.branchHeader) {
        this.branchHeader = new BranchHeader(
          this.layoutElements.messageContainer,
          {
            onNavigateToParent: () => this.navigateToParent(),
            onCancel: (subagentId) => this.cancelSubagent(subagentId),
            onContinue: (branchId) => this.continueSubagent(branchId),
          },
          this
        );
      }
      this.branchHeader.show(this.currentBranchContext);

    } catch (error) {
      console.error('[ChatView] Failed to navigate to branch:', error);
    }
  }

  /**
   * Navigate back to the parent conversation from a branch view
   */
  async navigateToParent(): Promise<void> {
    console.log('[Branch] ← Navigating back to parent');

    // Hide branch header
    this.branchHeader?.hide();
    this.currentBranchContext = null;

    // Restore the main conversation view
    const currentConversation = this.conversationManager.getCurrentConversation();
    if (currentConversation) {
      this.messageDisplay.setConversation(currentConversation);
    }
  }

  /**
   * Cancel a running subagent
   */
  private cancelSubagent(subagentId: string): void {
    console.log('[Subagent] Cancelling:', subagentId);

    if (!this.subagentExecutor) {
      console.warn('[ChatView] SubagentExecutor not available - cannot cancel');
      return;
    }

    const cancelled = this.subagentExecutor.cancelSubagent(subagentId);
    if (cancelled) {
      console.log('[Subagent] Cancelled:', subagentId);
      // Update the branch header if we're viewing this branch
      const contextMetadata = this.currentBranchContext?.metadata;
      if (isSubagentMetadata(contextMetadata) && contextMetadata.subagentId === subagentId) {
        this.branchHeader?.update({
          metadata: { ...contextMetadata, state: 'cancelled' },
        });
      }
      // Refresh the agent status menu
      this.agentStatusMenu?.refresh();
    }
  }

  /**
   * Continue a paused subagent (hit max_iterations)
   */
  private async continueSubagent(branchId: string): Promise<void> {
    console.log('[Branch] Continuing subagent:', branchId);

    // Navigate back to parent first
    await this.navigateToParent();

    // TODO: Implement subagent continuation
    // This would call the subagent tool with continueBranchId parameter
  }

  /**
   * Open the agent status modal
   */
  private openAgentStatusModal(): void {
    if (!this.subagentExecutor) {
      console.warn('[ChatView] SubagentExecutor not available - cannot open modal');
      return;
    }

    const modal = new AgentStatusModal(
      this.app,
      this.subagentExecutor,
      {
        onViewBranch: (branchId) => this.navigateToBranch(branchId),
        onContinueAgent: (branchId) => this.continueSubagent(branchId),
      }
    );
    modal.open();
  }

  /**
   * Check if currently viewing a branch
   */
  isViewingBranch(): boolean {
    return this.currentBranchContext !== null;
  }

  /**
   * Get current branch context (for external use)
   */
  getCurrentBranchContext(): BranchViewContext | null {
    return this.currentBranchContext;
  }

  private cleanup(): void {
    this.conversationList?.cleanup();
    this.messageDisplay?.cleanup();
    this.chatInput?.cleanup();
    this.contextProgressBar?.cleanup();
    this.uiStateController?.cleanup();
    this.streamingController?.cleanup();
    this.agentStatusMenu?.cleanup();
    this.branchHeader?.cleanup();
  }
}
