/**
 * ChatView - Clean orchestrator for the chat interface
 * Location: /src/ui/chat/ChatView.ts
 *
 * Coordinates between services, controllers, and UI components following SOLID principles.
 * This class is responsible for initialization, delegation, and high-level event coordination only.
 * Delegates UI construction to ChatLayoutBuilder, event binding to ChatEventBinder,
 * and tool event coordination to ToolEventCoordinator.
 */

import { ItemView, WorkspaceLeaf, Notice } from 'obsidian';
import { ConversationList } from './components/ConversationList';
import { MessageDisplay } from './components/MessageDisplay';
import { ChatInput } from './components/ChatInput';
import { ContextProgressBar } from './components/ContextProgressBar';
import { ChatSettingsModal } from './components/ChatSettingsModal';
import { ChatService } from '../../services/chat/ChatService';
import { ConversationData, ConversationMessage } from '../../types/chat/ChatTypes';
import { MessageEnhancement } from './components/suggesters/base/SuggesterInterfaces';
import type NexusPlugin from '../../main';
import type { WorkspaceService } from '../../services/WorkspaceService';

// Services
import { ConversationManager, ConversationManagerEvents } from './services/ConversationManager';
import { MessageManager, MessageManagerEvents } from './services/MessageManager';
import { ModelAgentManager, ModelAgentManagerEvents } from './services/ModelAgentManager';
import { BranchManager, BranchManagerEvents } from './services/BranchManager';
import { ContextCompactionService } from '../../services/chat/ContextCompactionService';
import { ContextPreservationService } from '../../services/chat/ContextPreservationService';
import { ContextTracker } from './services/ContextTracker';

// Controllers
import { UIStateController, UIStateControllerEvents } from './controllers/UIStateController';
import { StreamingController } from './controllers/StreamingController';
import { NexusLoadingController } from './controllers/NexusLoadingController';
import { SubagentController, SubagentContextProvider } from './controllers/SubagentController';

// Coordinators
import { ToolEventCoordinator } from './coordinators/ToolEventCoordinator';

// Builders and Utilities
import { ChatLayoutBuilder, ChatLayoutElements } from './builders/ChatLayoutBuilder';
import { ChatEventBinder } from './utils/ChatEventBinder';

// Utils
import { ReferenceMetadata } from './utils/ReferenceExtractor';
import { CHAT_VIEW_TYPES } from '../../constants/branding';
import { getNexusPlugin } from '../../utils/pluginLocator';

// Nexus Lifecycle
import { getWebLLMLifecycleManager } from '../../services/llm/adapters/webllm/WebLLMLifecycleManager';

// Subagent infrastructure (delegated to SubagentController)
import type { AgentManager } from '../../services/AgentManager';
import type { DirectToolExecutor } from '../../services/chat/DirectToolExecutor';
import type { PromptManagerAgent } from '../../agents/promptManager/promptManager';
import type { HybridStorageAdapter } from '../../database/adapters/HybridStorageAdapter';

// Branch UI components
import { BranchHeader, BranchViewContext } from './components/BranchHeader';
import { isSubagentMetadata } from '../../types/branch/BranchTypes';

export const CHAT_VIEW_TYPE = CHAT_VIEW_TYPES.current;

export class ChatView extends ItemView {
  /** Maximum time (ms) to wait for services to become available */
  private static readonly SERVICE_POLL_TIMEOUT_MS = 60000;
  /** Interval (ms) between service availability checks */
  private static readonly SERVICE_POLL_INTERVAL_MS = 500;

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
  private compactionService: ContextCompactionService;
  private preservationService: ContextPreservationService | null = null;
  private contextTracker!: ContextTracker;

  // Controllers and Coordinators
  private uiStateController!: UIStateController;
  private streamingController!: StreamingController;
  private nexusLoadingController!: NexusLoadingController;
  private toolEventCoordinator!: ToolEventCoordinator;

  // Subagent infrastructure (delegated to SubagentController)
  private subagentController: SubagentController | null = null;

  // Disposal guard - prevents polling loops from operating on detached DOM
  private isClosing: boolean = false;

  // Branch UI state
  private branchHeader: BranchHeader | null = null;
  private currentBranchContext: BranchViewContext | null = null;

  // Parent conversation reference when viewing a branch
  // Used for back navigation - the branch becomes currentConversation when viewing
  private parentConversationId: string | null = null;
  // Scroll position to restore when returning from branch
  private parentScrollPosition: number = 0;

  // Layout elements
  private layoutElements!: ChatLayoutElements;

  constructor(leaf: WorkspaceLeaf, private chatService: ChatService) {
    super(leaf);
    this.compactionService = new ContextCompactionService();
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
    // Reset disposal flag in case the view is being reopened
    this.isClosing = false;

    if (this.chatService) {
      // ChatService already available - initialize immediately
      await this.performFullInitialization();
    } else {
      // ChatService not ready yet - show loading UI and poll in background.
      // CRITICAL: Do NOT await here. onOpen() must return promptly so Obsidian's
      // layout restoration completes, which fires onLayoutReady, which starts
      // service initialization. Awaiting here would cause a deadlock.
      this.waitForChatServiceAndInitialize();
    }
  }

  /**
   * Wait for database to be ready, showing loading overlay if needed
   * Uses getServiceIfReady to avoid blocking startup with SQLite WASM loading
   */
  private async waitForDatabaseReady(): Promise<void> {
    const plugin = getNexusPlugin<NexusPlugin>(this.app);
    if (!plugin) return;

    // Use getServiceIfReady to avoid triggering SQLite WASM loading during startup
    let storageAdapter = plugin.getServiceIfReady<{ isReady?: () => boolean; waitForReady?: () => Promise<boolean> }>('hybridStorageAdapter');

    // If adapter doesn't exist yet or isn't ready, show loading overlay and poll
    if (!storageAdapter || !storageAdapter.isReady?.()) {
      this.nexusLoadingController.showDatabaseLoadingOverlay();

      // Poll for adapter to be created and ready
      const startTime = Date.now();

      while (Date.now() - startTime < ChatView.SERVICE_POLL_TIMEOUT_MS) {
        await new Promise(resolve => setTimeout(resolve, ChatView.SERVICE_POLL_INTERVAL_MS));

        // Stop polling if view was closed during the wait
        if (this.isClosing) return;

        storageAdapter = plugin.getServiceIfReady<{ isReady?: () => boolean; waitForReady?: () => Promise<boolean> }>('hybridStorageAdapter');
        if (storageAdapter?.isReady?.()) {
          break;
        }
      }

      // View may have closed while we were polling - skip DOM operations
      if (this.isClosing) return;

      this.nexusLoadingController.hideDatabaseLoadingOverlay();
      return;
    }

    // Adapter exists and is ready - delegate to controller for any remaining checks
    await this.nexusLoadingController.waitForDatabaseReady(storageAdapter);
  }

  /**
   * Fire-and-forget: show loading UI, poll for chatService, then run full initialization.
   * This method is intentionally NOT awaited in onOpen() to prevent deadlock.
   * onOpen() must return promptly so Obsidian finishes layout restoration, which
   * triggers onLayoutReady, which starts the service initialization that creates chatService.
   */
  private waitForChatServiceAndInitialize(): void {
    const plugin = getNexusPlugin<NexusPlugin>(this.app);
    if (!plugin || !plugin.getServiceIfReady) {
      this.showServiceUnavailableMessage();
      return;
    }

    // Show loading UI while polling
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass('chat-view-container');

    const loadingDiv = container.createDiv('chat-service-loading');
    loadingDiv.createDiv({ cls: 'chat-service-loading-spinner' });
    loadingDiv.createDiv({ cls: 'chat-service-loading-text', text: 'Loading chat service...' });

    // Poll for chatService in background
    const startTime = Date.now();

    const poll = async (): Promise<void> => {
      while (Date.now() - startTime < ChatView.SERVICE_POLL_TIMEOUT_MS) {
        await new Promise(resolve => setTimeout(resolve, ChatView.SERVICE_POLL_INTERVAL_MS));

        // Stop polling if view was closed during the wait
        if (this.isClosing) return;

        const chatService = plugin.getServiceIfReady<ChatService>('chatService');
        if (chatService) {
          this.chatService = chatService;
          container.empty();
          try {
            await this.performFullInitialization();
          } catch (error) {
            console.error('[ChatView] Deferred initialization failed:', error);
            this.showServiceUnavailableMessage();
          }
          return;
        }
      }

      // View may have closed while we were polling - skip DOM operations
      if (this.isClosing) return;

      // Timed out - show error state
      this.showServiceUnavailableMessage();
    };

    // Fire and forget - do NOT await
    poll().catch(error => {
      console.error('[ChatView] Background chatService polling failed:', error);
      this.showServiceUnavailableMessage();
    });
  }

  /**
   * Perform the full ChatView initialization sequence.
   * Called either directly from onOpen() when chatService is already available,
   * or from waitForChatServiceAndInitialize() after chatService appears.
   */
  private async performFullInitialization(): Promise<void> {
    try {
      await this.chatService.initialize();

      // Set up tool event callback for live UI updates
      this.chatService.setToolEventCallback((messageId, event, data) => {
        this.handleToolEvent(messageId, event, data);
      });
    } catch (error) {
      // ChatService initialization failed - continue with UI setup anyway
    }

    this.initializeArchitecture();

    // Check if database is still loading and show overlay
    await this.waitForDatabaseReady();

    await this.loadInitialData();

    // Set up Nexus lifecycle callbacks for loading indicator
    const lifecycleManager = getWebLLMLifecycleManager();
    lifecycleManager.setCallbacks({
      onLoadingStart: () => this.nexusLoadingController.showNexusLoadingOverlay(),
      onLoadingProgress: (progress, stage) => this.nexusLoadingController.updateNexusLoadingProgress(progress, stage),
      onLoadingComplete: () => this.nexusLoadingController.hideNexusLoadingOverlay(),
      onError: (error) => {
        this.nexusLoadingController.hideNexusLoadingOverlay();
        console.error('[ChatView] Nexus loading error:', error);
      }
    });

    // Notify Nexus lifecycle manager that ChatView is open
    // Pass current provider so it can pre-load if Nexus is selected
    const currentProvider = (await this.modelAgentManager.getMessageOptions()).provider;
    lifecycleManager.handleChatViewOpened(currentProvider).catch((error) => {
      console.error('[ChatView] handleChatViewOpened failed:', error);
    });
  }

  /**
   * Show a message when the chat service is unavailable
   */
  private showServiceUnavailableMessage(): void {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass('chat-view-container');

    const errorDiv = container.createDiv('chat-service-error');
    errorDiv.createDiv({ cls: 'chat-service-error-icon', text: '⚠️' });
    errorDiv.createDiv({ cls: 'chat-service-error-text', text: 'Chat service unavailable. Please reload Obsidian.' });
  }

  async onClose(): Promise<void> {
    // Signal polling loops to stop before any cleanup runs
    this.isClosing = true;

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
      onGenerationAborted: (messageId, partialContent) => this.handleGenerationAborted(messageId, partialContent),
      // Token usage tracking for local models with limited context
      onUsageAvailable: (usage) => this.modelAgentManager.recordTokenUsage(usage.promptTokens, usage.completionTokens)
    };
    this.messageManager = new MessageManager(this.chatService, this.branchManager, messageEvents);

    // Model and agent management
    const modelAgentEvents: ModelAgentManagerEvents = {
      onModelChanged: (model) => this.handleModelChanged(model),
      onPromptChanged: (prompt) => this.handlePromptChanged(prompt),
      onSystemPromptChanged: () => this.updateContextProgress()
    };
    this.modelAgentManager = new ModelAgentManager(
      this.app,
      modelAgentEvents,
      this.chatService.getConversationService()
    );

    // Context tracking
    this.contextTracker = new ContextTracker(
      this.conversationManager,
      this.modelAgentManager
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
    this.nexusLoadingController = new NexusLoadingController(this.containerEl);
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
   * Initialize subagent infrastructure via SubagentController
   * This is async and non-blocking - subagent features will be available once this completes
   */
  private async initializeSubagentInfrastructure(): Promise<void> {
    try {
      const plugin = getNexusPlugin<NexusPlugin>(this.app);
      if (!plugin) return;

      // Get required services
      const directToolExecutor = await plugin.getService<DirectToolExecutor>('directToolExecutor');
      if (!directToolExecutor) return;

      const agentManager = await plugin.getService<AgentManager>('agentManager');
      if (!agentManager) return;

      const promptManagerAgent = agentManager.getAgent('promptManager') as PromptManagerAgent | null;
      if (!promptManagerAgent) return;

      // Use getServiceIfReady to avoid triggering SQLite WASM loading during startup
      const storageAdapter = plugin.getServiceIfReady<HybridStorageAdapter>('hybridStorageAdapter');
      if (!storageAdapter) {
        return;
      }

      const llmService = this.chatService.getLLMService();
      if (!llmService) return;

      // Create SubagentController
      this.subagentController = new SubagentController(this.app, this, {
        onStreamingUpdate: () => { /* handled internally */ },
        onToolCallsDetected: () => { /* handled internally */ },
        onStatusChanged: () => { /* status menu auto-updates */ },
        onConversationNeedsRefresh: async (conversationId: string) => {
          // Reload conversation if viewing the one that was updated
          const current = this.conversationManager?.getCurrentConversation();
          if (current?.id === conversationId) {
            // Re-select current conversation to trigger full reload
            await this.conversationManager?.selectConversation(current);
          }
        },
      });

      // Build context provider from ModelAgentManager
      const contextProvider: SubagentContextProvider = {
        getCurrentConversation: () => this.conversationManager?.getCurrentConversation() ?? null,
        getSelectedModel: () => this.modelAgentManager?.getSelectedModel() ?? null,
        getSelectedPrompt: () => this.modelAgentManager?.getSelectedPrompt() ?? null,
        getLoadedWorkspaceData: () => this.modelAgentManager?.getLoadedWorkspaceData(),
        getContextNotes: () => this.modelAgentManager?.getContextNotes() || [],
        getThinkingSettings: () => this.modelAgentManager?.getThinkingSettings() ?? null,
        getSelectedWorkspaceId: () => this.modelAgentManager?.getSelectedWorkspaceId() ?? null,
      };

      // Initialize with dependencies
      await this.subagentController.initialize(
        {
          app: this.app,
          chatService: this.chatService,
          directToolExecutor,
          promptManagerAgent,
          storageAdapter,
          llmService,
        },
        contextProvider,
        this.streamingController,
        this.toolEventCoordinator,
        this.layoutElements.settingsButton?.parentElement ?? undefined,
        this.layoutElements.settingsButton
      );

      // Wire up navigation callbacks for agent status modal
      this.subagentController.setNavigationCallbacks({
        onNavigateToBranch: (branchId) => this.navigateToBranch(branchId),
        onContinueAgent: (branchId) => this.continueSubagent(branchId),
      });

      // Initialize ContextPreservationService for LLM-driven saveState at 90% context
      this.preservationService = new ContextPreservationService({
        llmService: llmService,
        getAgent: (name: string) => agentManager.getAgent(name),
        executeToolCalls: (toolCalls, context) =>
          directToolExecutor.executeToolCalls(toolCalls, context),
      });


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

    // Clear agent status when switching conversations (session-scoped)
    this.subagentController?.clearAgentStatus();

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

  private handleConversationUpdated(conversation: ConversationData | null): void {
    if (!conversation) {
      // null signals a force-refresh; reload from current state
      this.updateChatTitle();
      this.updateContextProgress();
      return;
    }
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

      // Check if context compaction is needed (local models with limited context)
      // Triggered at 90% context usage - uses LLM to save state before compacting
      if (this.modelAgentManager.shouldCompactBeforeSending(message)) {
        await this.performContextCompaction(currentConversation);
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

  /**
   * Perform context compaction when approaching token limit (90%)
   * Shows an auto-save style notice (like a video game) during the process.
   *
   * Flow:
   * 1. Try LLM-driven saveState via preservationService (rich semantic context)
   * 2. Fall back to programmatic compaction if LLM fails
   * 3. Compact conversation messages
   * 4. Update storage and progress bar
   */
  private async performContextCompaction(conversation: ConversationData): Promise<void> {
    let stateContent: string | undefined;
    let usedLLM = false;

    // Try LLM-driven saveState if preservationService is available
    if (this.preservationService) {
      // Show "saving" notice - like a video game auto-save
      const savingNotice = new Notice('Saving context...', 0); // 0 = don't auto-dismiss

      try {
        const messageOptions = await this.modelAgentManager.getMessageOptions();
        const result = await this.preservationService.forceStateSave(
          conversation.messages,
          {
            provider: messageOptions.provider,
            model: messageOptions.model,
          },
          {
            workspaceId: this.modelAgentManager.getSelectedWorkspaceId() || undefined,
            sessionId: conversation.metadata?.chatSettings?.sessionId,
          }
        );

        if (result.success && result.stateContent) {
          stateContent = result.stateContent;
          usedLLM = true;
        }
      } catch (error) {
        // LLM-driven preservation failed, will fall back to programmatic
        console.error('[ChatView] LLM-driven saveState failed, using programmatic fallback:', error);
      } finally {
        // Dismiss the "saving" notice
        savingNotice.hide();
      }
    }

    // Run programmatic compaction (truncates messages)
    const compactedContext = this.compactionService.compact(conversation, {
      exchangesToKeep: 2, // Keep last 2 user/assistant exchanges
      maxSummaryLength: 500,
      includeFileReferences: true
    });

    if (compactedContext.messagesRemoved > 0) {
      // Use LLM-saved state if available, otherwise use programmatic summary
      if (stateContent) {
        compactedContext.summary = stateContent;
      }

      // Set previous context for injection into system prompt
      this.modelAgentManager.setPreviousContext(compactedContext);

      // Reset token tracker for fresh accounting with compacted conversation
      this.modelAgentManager.resetTokenTracker();

      // Update conversation in storage with compacted messages
      await this.chatService.updateConversation(conversation);

      // Update progress bar immediately to reflect new token count
      this.updateContextProgress();

      // Show completion notice - brief auto-save style feedback
      const savedMsg = usedLLM
        ? `Context saved (${compactedContext.messagesRemoved} messages compacted)`
        : `Context compacted (${compactedContext.messagesRemoved} messages)`;
      new Notice(savedMsg, 2500);
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

  private handleGenerationAborted(messageId: string, _partialContent: string): void {
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

    // Get actual content from conversation (progressively saved during streaming)
    // The passed partialContent is always empty; real content is in conversation object
    const currentConversation = this.conversationManager?.getCurrentConversation();
    const message = currentConversation?.messages.find(m => m.id === messageId);
    const actualContent = message?.content || '';

    // Only finalize if we have content - otherwise just stop the animation
    if (actualContent) {
      this.streamingController.finalizeStreaming(messageId, actualContent);
    }
  }

  private handleLoadingStateChanged(loading: boolean): void {
    if (this.chatInput) {
      this.chatInput.setLoading(loading);
    }
  }

  private handleModelChanged(model: any | null): void {
    this.updateContextProgress();
  }

  private handlePromptChanged(prompt: any | null): void {
    // Prompt changed
  }

  private async getContextUsage() {
    return await this.contextTracker.getContextUsage();
  }

  private getConversationCost(): { totalCost: number; currency: string } | null {
    return this.contextTracker.getConversationCost();
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


  // Branch navigation methods for subagent viewing

  /**
   * Navigate to a specific branch (subagent or human)
   * Shows the branch messages in the message display with a back header
   *
   * For actively streaming branches, uses in-memory messages for flicker-free updates.
   * StreamingController handles live updates via onStreamingUpdate event.
   *
   * ARCHITECTURE NOTE (Dec 2025):
   * A branch IS a conversation with parent metadata. When viewing a branch,
   * we set the branch as the currentConversation in ConversationManager.
   * This means all message operations (send, edit, retry) naturally save to
   * the branch conversation via ChatService - no special routing needed.
   */
  async navigateToBranch(branchId: string): Promise<void> {
    const currentConversation = this.conversationManager.getCurrentConversation();
    if (!currentConversation) {
      return;
    }

    try {
      // In the new architecture, branchId IS the conversation ID.
      // Prefer the in-memory version if this branch is the currently active
      // conversation (avoids stale reads when streaming recently updated it
      // but storage hasn't been flushed yet).
      const inMemoryCurrent = this.conversationManager.getCurrentConversation();
      const branchConversation = (inMemoryCurrent && inMemoryCurrent.id === branchId)
        ? inMemoryCurrent
        : await this.chatService.getConversation(branchId);
      if (!branchConversation) {
        console.error('[ChatView] Branch conversation not found:', branchId);
        return;
      }

      // Store parent conversation ID and scroll position for back navigation
      // Only set if not already viewing a branch (avoid nested overwrite)
      if (!this.parentConversationId) {
        this.parentConversationId = currentConversation.id;
        this.parentScrollPosition = this.messageDisplay.getScrollPosition();
      }

      // Check if this branch is actively streaming - use in-memory messages
      const inMemoryMessages = this.subagentController?.getStreamingBranchMessages(branchId);
      const isStreaming = inMemoryMessages !== null;

      // Build branch context for header display (uses conversation metadata)
      const branchType = branchConversation.metadata?.branchType || 'human';
      const parentMessageId = branchConversation.metadata?.parentMessageId || '';

      this.currentBranchContext = {
        conversationId: branchConversation.metadata?.parentConversationId || currentConversation.id,
        branchId,
        parentMessageId,
        branchType: branchType as 'human' | 'subagent',
        metadata: branchConversation.metadata?.subagent || { description: branchConversation.title },
      };

      // Sync context to SubagentController for event filtering
      this.subagentController?.setCurrentBranchContext(this.currentBranchContext);

      // Set the branch as the current conversation
      // All message operations will now naturally save to the branch
      this.conversationManager.setCurrentConversation(branchConversation);

      // Use in-memory messages if streaming, otherwise use stored messages
      if (isStreaming && inMemoryMessages) {
        const streamingView: ConversationData = {
          ...branchConversation,
          messages: inMemoryMessages,
        };
        this.messageDisplay.setConversation(streamingView);
      } else {
        this.messageDisplay.setConversation(branchConversation);
      }

      // If streaming, initialize StreamingController for the active message
      if (isStreaming && inMemoryMessages && inMemoryMessages.length > 0) {
        const lastMessage = inMemoryMessages[inMemoryMessages.length - 1];
        if (lastMessage.state === 'streaming') {
          this.streamingController.startStreaming(lastMessage.id);
        }
      }

      // Show branch header
      if (!this.branchHeader) {
        this.branchHeader = new BranchHeader(
          this.layoutElements.branchHeaderContainer,
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
   *
   * ARCHITECTURE NOTE (Dec 2025):
   * When viewing a branch, the branch IS the currentConversation.
   * To go back, we restore the parent conversation as current.
   */
  async navigateToParent(): Promise<void> {
    // Hide branch header
    this.branchHeader?.hide();
    this.currentBranchContext = null;
    this.subagentController?.setCurrentBranchContext(null);

    // Get parent ID and scroll position before clearing
    const parentId = this.parentConversationId;
    const scrollPosition = this.parentScrollPosition;
    this.parentConversationId = null;
    this.parentScrollPosition = 0;

    if (parentId) {
      // Load parent conversation fresh (may have new messages from subagent results)
      const parentConversation = await this.chatService.getConversation(parentId);
      if (parentConversation) {
        // Set parent as current conversation
        this.conversationManager.setCurrentConversation(parentConversation);
        this.messageDisplay.setConversation(parentConversation);
        // Restore scroll position after render
        requestAnimationFrame(() => {
          this.messageDisplay.setScrollPosition(scrollPosition);
        });
        return;
      }
    }

    // Fallback: reload current conversation (shouldn't happen normally)
    const currentConversation = this.conversationManager.getCurrentConversation();
    if (currentConversation) {
      const updated = await this.chatService.getConversation(currentConversation.id);
      if (updated) {
        this.conversationManager.setCurrentConversation(updated);
        this.messageDisplay.setConversation(updated);
      }
    }
  }

  /**
   * Cancel a running subagent
   */
  private cancelSubagent(subagentId: string): void {
    const cancelled = this.subagentController?.cancelSubagent(subagentId);
    if (cancelled) {
      // Update the branch header if we're viewing this branch
      const contextMetadata = this.currentBranchContext?.metadata;
      if (isSubagentMetadata(contextMetadata) && contextMetadata.subagentId === subagentId) {
        this.branchHeader?.update({
          metadata: { ...contextMetadata, state: 'cancelled' },
        });
      }
    }
  }

  /**
   * Continue a paused subagent (hit max_iterations)
   */
  private async continueSubagent(branchId: string): Promise<void> {
    // Navigate back to parent first
    await this.navigateToParent();

    // TODO: Implement subagent continuation
    // This would call the subagent tool with continueBranchId parameter
  }

  /**
   * Open the agent status modal
   */
  private openAgentStatusModal(): void {
    if (!this.subagentController?.isInitialized()) {
      // SubagentController not initialized - cannot open modal
      return;
    }

    const contextProvider: SubagentContextProvider = {
      getCurrentConversation: () => this.conversationManager?.getCurrentConversation() ?? null,
      getSelectedModel: () => this.modelAgentManager?.getSelectedModel() ?? null,
      getSelectedPrompt: () => this.modelAgentManager?.getSelectedPrompt() ?? null,
      getLoadedWorkspaceData: () => this.modelAgentManager?.getLoadedWorkspaceData(),
      getContextNotes: () => this.modelAgentManager?.getContextNotes() || [],
      getThinkingSettings: () => this.modelAgentManager?.getThinkingSettings() ?? null,
      getSelectedWorkspaceId: () => this.modelAgentManager?.getSelectedWorkspaceId() ?? null,
    };

    this.subagentController.openStatusModal(contextProvider, {
      onViewBranch: (branchId) => this.navigateToBranch(branchId),
      onContinueAgent: (branchId) => this.continueSubagent(branchId),
    });
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
    this.nexusLoadingController?.unload();
    this.subagentController?.cleanup();
    this.branchHeader?.cleanup();
  }
}
