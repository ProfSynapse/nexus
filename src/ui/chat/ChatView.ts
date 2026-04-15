/**
 * ChatView - Clean orchestrator for the chat interface
 * Location: /src/ui/chat/ChatView.ts
 *
 * Coordinates between services, controllers, and UI components following SOLID principles.
 * This class is responsible for initialization, delegation, and high-level event coordination only.
 * Delegates UI construction to ChatLayoutBuilder, event binding to ChatEventBinder,
 * and tool event coordination to ToolEventCoordinator.
 */

import { ItemView, Notice, Platform, WorkspaceLeaf } from 'obsidian';
import { ConversationList } from './components/ConversationList';
import { MessageDisplay } from './components/MessageDisplay';
import { ChatInput } from './components/ChatInput';
import { ChatSettingsModal } from './components/ChatSettingsModal';
import { ChatService } from '../../services/chat/ChatService';
import { ConversationData, ConversationMessage } from '../../types/chat/ChatTypes';
import type NexusPlugin from '../../main';
import type { WorkspaceService } from '../../services/WorkspaceService';
// Services
import { ConversationManager, ConversationManagerEvents } from './services/ConversationManager';
import { MessageManager, MessageManagerEvents } from './services/MessageManager';
import { ModelAgentManager, ModelAgentManagerEvents } from './services/ModelAgentManager';
import { BranchManager, BranchManagerEvents } from './services/BranchManager';
import { ChatSessionCoordinator, WorkflowMessageOptions } from './services/ChatSessionCoordinator';
import { ChatSendCoordinator } from './services/ChatSendCoordinator';
import { ChatBranchViewCoordinator } from './services/ChatBranchViewCoordinator';
import { ChatSubagentIntegration } from './services/ChatSubagentIntegration';
import { ContextPreservationService } from '../../services/chat/ContextPreservationService';
import { ContextTracker } from './services/ContextTracker';

// Controllers
import { UIStateController, UIStateControllerEvents } from './controllers/UIStateController';
import { StreamingController } from './controllers/StreamingController';
import { NexusLoadingController } from './controllers/NexusLoadingController';
import { SubagentController } from './controllers/SubagentController';

// Coordinators
import { ToolStatusBar } from './components/ToolStatusBar';
import { openTaskBoardView } from '../tasks/taskBoardNavigation';
import { ToolStatusLabelResolver } from './services/ToolStatusLabelResolver';
import { setToolStatusLabelResolver } from './utils/toolDisplayFormatter';
import type { AgentManager } from '../../services/AgentManager';
import { ToolInspectionModal } from './components/ToolInspectionModal';
import { ToolStatusBarController } from './controllers/ToolStatusBarController';
import { ToolEventCoordinator } from './coordinators/ToolEventCoordinator';
import { ToolCallStateManager } from './services/ToolCallStateManager';

// Builders and Utilities
import { ChatLayoutBuilder, ChatLayoutElements } from './builders/ChatLayoutBuilder';
import { ChatEventBinder } from './utils/ChatEventBinder';

import { CHAT_VIEW_TYPES } from '../../constants/branding';
import { getNexusPlugin } from '../../utils/pluginLocator';

// Nexus Lifecycle
import { getWebLLMLifecycleManager } from '../../services/llm/adapters/webllm/WebLLMLifecycleManager';

// Subagent infrastructure (delegated to SubagentController)
import type { HybridStorageAdapter, ExternalSyncEvent } from '../../database/adapters/HybridStorageAdapter';
import type { ModelOption, PromptOption } from './types/SelectionTypes';
import type { ToolEventData as ChatServiceToolEventData } from '../../services/chat/ToolCallService';
import type { BranchViewContext } from './components/BranchHeader';

export const CHAT_VIEW_TYPE = CHAT_VIEW_TYPES.current;
type ChatToolEventData = Parameters<ToolEventCoordinator['handleToolEvent']>[2];
type DetectedToolCalls = Parameters<ToolEventCoordinator['handleToolCallsDetected']>[1];

export class ChatView extends ItemView {
  /** Maximum time (ms) to wait for services to become available */
  private static readonly SERVICE_POLL_TIMEOUT_MS = 60000;
  /** Interval (ms) between service availability checks */
  private static readonly SERVICE_POLL_INTERVAL_MS = 500;

  // Core components
  private conversationList!: ConversationList;
  private messageDisplay!: MessageDisplay;
  private chatInput!: ChatInput;

  // Services
  private conversationManager!: ConversationManager;
  private messageManager!: MessageManager;
  private modelAgentManager!: ModelAgentManager;
  private branchManager!: BranchManager;
  private preservationService: ContextPreservationService | null = null;
  private contextTracker!: ContextTracker;

  // Controllers and Coordinators
  private uiStateController!: UIStateController;
  private streamingController!: StreamingController;
  private nexusLoadingController!: NexusLoadingController;
  private toolCallStateManager!: ToolCallStateManager;
  private toolEventCoordinator!: ToolEventCoordinator;
  private toolStatusBar!: ToolStatusBar;
  private toolStatusBarController!: ToolStatusBarController;

  // Subagent infrastructure (delegated to SubagentController)
  private subagentController: SubagentController | null = null;

  // Disposal guard - prevents polling loops from operating on detached DOM
  private isClosing = false;

  // Search debounce timer for conversation search input
  private searchDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  private sessionCoordinator: ChatSessionCoordinator;
  private sendCoordinator: ChatSendCoordinator;
  private branchViewCoordinator: ChatBranchViewCoordinator;
  private subagentIntegration: ChatSubagentIntegration;

  // Layout elements
  private layoutElements!: ChatLayoutElements;

  constructor(leaf: WorkspaceLeaf, private chatService: ChatService) {
    super(leaf);
    this.sessionCoordinator = new ChatSessionCoordinator({
      chatService: this.chatService,
      component: this,
      getContainerEl: () => this.containerEl,
      getChatTitleEl: () => this.layoutElements?.chatTitle ?? null,
      getConversationManager: () => this.conversationManager ?? null,
      getMessageManager: () => this.messageManager ?? null,
      getModelAgentManager: () => this.modelAgentManager ?? null,
      getConversationList: () => this.conversationList ?? null,
      getMessageDisplay: () => this.messageDisplay ?? null,
      getChatInput: () => this.chatInput ?? null,
      getUIStateController: () => this.uiStateController ?? null,
      onClearStreamingState: () => this.streamingController?.cleanup(),
      onClearAgentStatus: () => this.subagentController?.clearAgentStatus(),
      onUpdateChatTitle: () => this.updateChatTitle(),
      onUpdateContextProgress: () => {
        void this.updateContextProgress();
      }
    });
    this.sendCoordinator = new ChatSendCoordinator({
      app: this.app,
      chatService: this.chatService,
      getContainerEl: () => this.containerEl,
      getConversationManager: () => this.conversationManager ?? null,
      getMessageManager: () => this.messageManager ?? null,
      getModelAgentManager: () => this.modelAgentManager ?? null,
      getChatInput: () => this.chatInput ?? null,
      getMessageDisplay: () => this.messageDisplay ?? null,
      getStreamingController: () => this.streamingController ?? null,
      getPreservationService: () => this.preservationService,
      getStorageAdapter: () =>
        getNexusPlugin<NexusPlugin>(this.app)?.getServiceIfReady<HybridStorageAdapter>('hybridStorageAdapter') ?? null,
      onUpdateContextProgress: () => {
        void this.updateContextProgress();
      },
    });
    this.subagentIntegration = new ChatSubagentIntegration({
      app: this.app,
      component: this,
      chatService: this.chatService,
      getConversationManager: () => this.conversationManager ?? null,
      getModelAgentManager: () => this.modelAgentManager ?? null,
      getStreamingController: () => this.streamingController ?? null,
      getToolEventCoordinator: () => this.toolEventCoordinator ?? null,
      getAgentStatusSlot: () => this.toolStatusBar?.getAgentSlotEl(),
      getSettingsButton: () => undefined,
      getNavigationTarget: () => this.branchViewCoordinator ?? null,
    });
    this.branchViewCoordinator = new ChatBranchViewCoordinator({
      component: this,
      getConversation: (conversationId) => this.chatService.getConversation(conversationId),
      getConversationManager: () => this.conversationManager ?? null,
      getBranchManager: () => this.branchManager ?? null,
      getMessageDisplay: () => this.messageDisplay ?? null,
      getStreamingController: () => this.streamingController ?? null,
      getSubagentController: () => this.subagentController,
      getSubagentContextProvider: () => this.subagentIntegration.createContextProvider(),
      getBranchHeaderContainer: () => this.layoutElements.branchHeaderContainer,
    });
  }

  private getChatContainer(): HTMLElement | null {
    const container = this.containerEl.children[1];
    return container instanceof HTMLElement ? container : null;
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
  private async waitForDatabaseReady(): Promise<boolean> {
    const plugin = getNexusPlugin<NexusPlugin>(this.app);
    if (!plugin) return false;

    type StorageAdapterStartupState = {
      phase: 'idle' | 'running' | 'complete' | 'error';
      isBlocking: boolean;
      percent: number;
      statusText: string;
      error?: string;
    };

    type StartupAwareStorageAdapter = {
      isReady?: () => boolean;
      waitForReady?: () => Promise<boolean>;
      isStartupHydrationBlocking?: () => boolean;
      getStartupHydrationState?: () => StorageAdapterStartupState;
    };

    // Use getServiceIfReady to avoid triggering SQLite WASM loading during startup
    let storageAdapter = plugin.getServiceIfReady<StartupAwareStorageAdapter>('hybridStorageAdapter');

    // If adapter doesn't exist yet or isn't ready, show loading overlay and poll
    if (!storageAdapter || !storageAdapter.isReady?.()) {
      this.nexusLoadingController.showDatabaseLoadingOverlay();

      // Poll for adapter to be created and ready
      const startTime = Date.now();

      while (Date.now() - startTime < ChatView.SERVICE_POLL_TIMEOUT_MS) {
        await new Promise(resolve => setTimeout(resolve, ChatView.SERVICE_POLL_INTERVAL_MS));

        // Stop polling if view was closed during the wait
        if (this.isClosing) return false;

        storageAdapter = plugin.getServiceIfReady<StartupAwareStorageAdapter>('hybridStorageAdapter');
        if (storageAdapter?.isReady?.()) {
          break;
        }
      }

      // View may have closed while we were polling - skip DOM operations
      if (this.isClosing) return false;
    }

    if (!storageAdapter) {
      this.nexusLoadingController.hideDatabaseLoadingOverlay();
      return false;
    }

    await this.nexusLoadingController.waitForDatabaseReady(storageAdapter);
    return this.waitForStartupHydration(storageAdapter);
  }

  private async waitForStartupHydration(storageAdapter: {
    isStartupHydrationBlocking?: () => boolean;
    getStartupHydrationState?: () => {
      phase: 'idle' | 'running' | 'complete' | 'error';
      isBlocking: boolean;
      percent: number;
      statusText: string;
      error?: string;
    };
  }): Promise<boolean> {
    const snapshot = storageAdapter.getStartupHydrationState?.();
    if (!snapshot || !storageAdapter.isStartupHydrationBlocking?.()) {
      this.nexusLoadingController.hideDatabaseLoadingOverlay();
      return true;
    }

    this.nexusLoadingController.showDatabaseLoadingOverlay();
    this.nexusLoadingController.updateDatabaseLoadingProgress(
      snapshot.percent / 100,
      snapshot.statusText || 'Updating local chat index...'
    );

    while (true) {
      await new Promise(resolve => setTimeout(resolve, ChatView.SERVICE_POLL_INTERVAL_MS));

      if (this.isClosing) return false;

      const nextSnapshot = storageAdapter.getStartupHydrationState?.();
      if (!nextSnapshot) {
        break;
      }

      this.nexusLoadingController.updateDatabaseLoadingProgress(
        nextSnapshot.percent / 100,
        nextSnapshot.statusText || 'Updating local chat index...'
      );

      if (nextSnapshot.phase === 'error') {
        this.nexusLoadingController.updateDatabaseLoadingProgress(
          0,
          nextSnapshot.error || nextSnapshot.statusText || 'Local chat index update failed'
        );
        return false;
      }

      if (nextSnapshot.phase === 'complete' || !nextSnapshot.isBlocking) {
        this.nexusLoadingController.hideDatabaseLoadingOverlay();
        return true;
      }
    }

    this.nexusLoadingController.hideDatabaseLoadingOverlay();
    return true;
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
    const container = this.getChatContainer();
    if (!container) {
      return;
    }
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
        this.handleToolEvent(messageId, event, data as unknown as ChatToolEventData);
      });
    } catch {
      // ChatService initialization failed - continue with UI setup anyway
    }

    this.initializeArchitecture();

    // Check if database is still loading and show overlay
    const databaseReady = await this.waitForDatabaseReady();
    if (!databaseReady) {
      return;
    }

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
    const container = this.getChatContainer();
    if (!container) {
      return;
    }
    container.empty();
    container.addClass('chat-view-container');

    const errorDiv = container.createDiv('chat-service-error');
    errorDiv.createDiv({ cls: 'chat-service-error-icon', text: '⚠️' });
    errorDiv.createDiv({ cls: 'chat-service-error-text', text: 'Chat service unavailable. Please reload Obsidian.' });
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- Obsidian ItemView lifecycle method
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
    const container = this.getChatContainer();
    if (!container) {
      return;
    }
    this.layoutElements = ChatLayoutBuilder.buildLayout(container);
  }

  /**
   * Initialize business logic services
   */
  private initializeServices(): void {
    // Branch management
    const branchEvents: BranchManagerEvents = {
      onBranchCreated: (messageId: string, branchId: string) => {
        this.branchViewCoordinator.handleBranchCreated(messageId, branchId);
      },
      onBranchSwitched: (messageId: string, branchId: string) => {
        this.branchViewCoordinator.handleBranchSwitched(messageId, branchId);
      },
      onError: (message) => this.uiStateController.showError(message)
    };
    this.branchManager = new BranchManager(this.chatService.getConversationRepository(), branchEvents);

    // Conversation management
    const conversationEvents: ConversationManagerEvents = {
      onConversationSelected: (conversation) => {
        void this.sessionCoordinator.handleConversationSelected(conversation);
      },
      onConversationsChanged: () => {
        void this.sessionCoordinator.handleConversationsChanged();
      },
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
      onToolCallsDetected: (messageId, toolCalls) =>
        this.toolEventCoordinator.handleToolCallsDetected(
          messageId,
          toolCalls as unknown as DetectedToolCalls
        ),
      onToolExecutionStarted: (messageId, toolCall) => this.toolEventCoordinator.handleToolExecutionStarted(messageId, toolCall),
      onToolExecutionCompleted: (messageId, toolId, result, success, error) =>
        this.toolEventCoordinator.handleToolExecutionCompleted(messageId, toolId, result, success, error),
      onMessageIdUpdated: (oldId, newId, updatedMessage) => this.handleMessageIdUpdated(oldId, newId, updatedMessage),
      onGenerationAborted: (messageId, _partialContent) => this.sendCoordinator.handleGenerationAborted(messageId),
      // Token usage tracking for local models with limited context
      onUsageAvailable: (usage) => this.modelAgentManager.recordTokenUsage(usage.promptTokens, usage.completionTokens)
    };
    this.messageManager = new MessageManager(this.chatService, this.branchManager, messageEvents);

    // Model and agent management
    const modelAgentEvents: ModelAgentManagerEvents = {
      onModelChanged: (model) => this.handleModelChanged(model),
      onPromptChanged: (prompt) => this.handlePromptChanged(prompt),
      onSystemPromptChanged: () => {
        void this.updateContextProgress();
      }
    };
    this.modelAgentManager = new ModelAgentManager(
      this.app,
      modelAgentEvents,
      this.chatService.getConversationService() as unknown as ConstructorParameters<typeof ModelAgentManager>[2]
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
      onSidebarToggled: (_visible) => { /* Sidebar toggled */ }
    };
    this.uiStateController = new UIStateController(this.containerEl, uiStateEvents, this);
    this.uiStateController.setOpenSettingsCallback(() => {
      void this.openChatSettingsModal();
    });
    this.streamingController = new StreamingController(this.containerEl, this.app, this);
    this.nexusLoadingController = new NexusLoadingController(this.containerEl);
  }

  /**
   * Initialize UI components
   */
  private initializeComponents(): void {
    this.conversationList = new ConversationList(
      this.layoutElements.conversationListContainer,
      (conversation) => {
        void this.conversationManager.selectConversation(conversation);
        this.closeConversationListOnMobile();
      },
      (conversationId) => {
        void this.conversationManager.deleteConversation(conversationId);
      },
      (conversationId, newTitle) => {
        void this.conversationManager.renameConversation(conversationId, newTitle);
      },
      this, // Pass Component for registerDomEvent
      () => {
        void this.conversationManager.loadMoreConversations();
      }
    );

    this.messageDisplay = new MessageDisplay(
      this.layoutElements.messageContainer,
      this.app,
      this.branchManager,
      (messageId) => {
        void this.sendCoordinator.handleRetryMessage(messageId);
      },
      (messageId, newContent) => {
        void this.sendCoordinator.handleEditMessage(messageId, newContent);
      },
      (messageId: string, alternativeIndex: number) => {
        void this.branchViewCoordinator.handleBranchSwitchedByIndex(messageId, alternativeIndex);
      }
    );

    this.toolStatusBar = new ToolStatusBar(
      this.layoutElements.toolStatusBarContainer,
      this.contextTracker,
      {
        onInspectClick: () => this.handleInspectTools(),
        onTaskClick: () => this.handleOpenTasks(),
        onCompactClick: () => {
          void this.ensurePreservationServiceAndCompact();
        },
        onAgentClick: () => { void this.handleOpenAgentStatus(); },
      },
      this
    );

    this.toolStatusBarController = new ToolStatusBarController(this.toolStatusBar, this.streamingController, this);

    // Wire the colocated tool status label resolver. The resolver routes
    // `technicalName` → owning tool → `getStatusLabel()` override, with a
    // lazy agent lookup so it survives plugin init ordering. Installed
    // via a module-level setter on toolDisplayFormatter so every caller
    // of formatToolStepLabel shares the same route. Cleared in cleanup().
    const resolver = new ToolStatusLabelResolver((agentName) => {
      const plugin = getNexusPlugin<NexusPlugin>(this.app);
      const agentManager = plugin?.getServiceIfReady<AgentManager>('agentManager');
      try {
        return agentManager?.getAgent(agentName);
      } catch {
        return undefined;
      }
    });
    setToolStatusLabelResolver(resolver);
    this.register(() => setToolStatusLabelResolver(null));

    // Initialize tool call state machine and event coordinator
    this.toolCallStateManager = new ToolCallStateManager();
    this.toolEventCoordinator = new ToolEventCoordinator(this.toolStatusBarController, this.toolCallStateManager);
    this.register(() => this.toolCallStateManager.clear());

    this.chatInput = new ChatInput(
      this.layoutElements.inputContainer,
      (message, enhancement, metadata) => {
        void this.sendCoordinator.handleSendMessage(message, enhancement, metadata);
      },
      () => this.messageManager.getIsLoading(),
      this.app,
      () => {
        this.sendCoordinator.handleStopGeneration();
      },
      () => this.conversationManager.getCurrentConversation() !== null,
      this // Pass Component for registerDomEvent
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
      () => {
        void this.conversationManager.createNewConversation();
        this.closeConversationListOnMobile();
      },
      this
    );

    ChatEventBinder.bindSettingsButton(
      this.layoutElements.settingsButton,
      () => {
        void this.openChatSettingsModal();
      },
      this
    );

    this.uiStateController.initializeEventListeners();

    // Wire search input with 300ms debounce
    if (this.layoutElements.searchInput) {
      this.registerDomEvent(this.layoutElements.searchInput, 'input', () => {
        if (this.searchDebounceTimer) {
          clearTimeout(this.searchDebounceTimer);
        }
        const query = this.layoutElements.searchInput.value.trim();
        if (query.length === 0) {
          this.searchDebounceTimer = null;
          void this.conversationManager.clearSearch();
          return;
        }
        this.searchDebounceTimer = setTimeout(() => {
          this.searchDebounceTimer = null;
          void this.conversationManager.searchConversations(query);
        }, 300);
      });
    }

    // Refresh chat chrome when user switches back to this tab
    this.registerEvent(
      this.app.workspace.on('active-leaf-change', (leaf) => {
        if (leaf === this.leaf) {
          void this.updateContextProgress();
        }
      })
    );

    // Refresh conversation list / active conversation when Obsidian Sync
    // lands JSONL updates from another device. The adapter has already
    // reconciled SQLite by the time this fires — we just re-query.
    this.subscribeToExternalSync();
  }

  /**
   * Subscribe to the HybridStorageAdapter `external-sync` event so
   * desktop→mobile chat changes (and vice versa) appear without a
   * manual refresh. The subscription is registered with `registerEvent`
   * so it auto-detaches when the view unloads.
   */
  private subscribeToExternalSync(): void {
    const plugin = getNexusPlugin<NexusPlugin>(this.app);
    const adapter = plugin?.getServiceIfReady<HybridStorageAdapter>('hybridStorageAdapter') ?? null;
    if (!adapter || typeof adapter.onExternalSync !== 'function') {
      return;
    }

    const ref = adapter.onExternalSync((event) => {
      void this.handleExternalSync(event);
    });
    this.registerEvent(ref);
  }

  /**
   * Handle an external-sync event:
   * - If any conversation stream changed, reload the conversation list
   *   (a new conversation may have arrived, titles may be stale, etc.).
   * - If the *currently-open* conversation was one of the modified
   *   streams, re-select it to pull the new messages from SQLite.
   *
   * Other categories (workspaces, tasks) are handled by their own views.
   */
  private async handleExternalSync(event: ExternalSyncEvent): Promise<void> {
    if (!this.conversationManager) {
      return;
    }

    const conversationChanges = event.modified.filter((m) => m.category === 'conversations');
    if (conversationChanges.length === 0) {
      return;
    }

    try {
      // Refresh list first so the sidebar reflects any new arrivals.
      await this.conversationManager.loadConversations();

      // If the user is currently viewing one of the changed conversations,
      // re-select it so new messages show up in the main pane.
      const current = this.conversationManager.getCurrentConversation();
      if (current) {
        const hitCurrent = conversationChanges.some((m) => m.businessId === current.id);
        if (hitCurrent) {
          await this.conversationManager.selectConversation(current);
        }
      }
    } catch (error) {
      console.error('[ChatView] Failed to apply external-sync refresh:', error);
    }
  }

  /**
   * Initialize subagent infrastructure via SubagentController
   * This is async and non-blocking - subagent features will be available once this completes
   */
  private async initializeSubagentInfrastructure(): Promise<void> {
    try {
      const result = await this.subagentIntegration.initialize();
      this.subagentController = result.subagentController;
      this.preservationService = result.preservationService;
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
      this.modelAgentManager.setCurrentConversationId(currentConversation.id);
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
    await this.sessionCoordinator.loadInitialData();
  }

  async openConversationById(conversationId: string): Promise<void> {
    await this.sessionCoordinator.openConversationById(conversationId);
  }

  async sendMessageToConversation(
    conversationId: string,
    message: string,
    options?: WorkflowMessageOptions
  ): Promise<void> {
    await this.sessionCoordinator.sendMessageToConversation(conversationId, message, options);
  }

  private handleAIMessageStarted(message: ConversationMessage): void {
    this.messageDisplay.addAIMessage(message);
  }

  private handleStreamingUpdate(messageId: string, content: string, isComplete: boolean, isIncremental?: boolean): void {
    if (isIncremental) {
      this.streamingController.updateStreamingChunk(messageId, content);
    } else if (isComplete) {
      this.streamingController.finalizeStreaming(messageId, content);
      this.messageDisplay.updateMessageContent(messageId, content);
      this.toolEventCoordinator.clearToolNameCache();
    } else {
      this.streamingController.startStreaming(messageId);
      this.streamingController.updateStreamingChunk(messageId, content);
      this.toolEventCoordinator.ensureListening();
    }
  }

  private handleConversationUpdated(conversation: ConversationData | null): void {
    if (!conversation) {
      // Null signals a forced UI refresh (e.g., subagent completion)
      this.updateChatTitle();
      void this.updateContextProgress();
      return;
    }
    this.conversationManager.updateCurrentConversation(conversation);
    this.messageDisplay.setConversation(conversation);
    this.updateChatTitle();

    void this.updateContextProgress();
  }

  private handleLoadingStateChanged(loading: boolean): void {
    if (this.chatInput) {
      if (loading) {
        this.chatInput.setPreSendCompacting(false);
        this.messageDisplay.clearTransientEventRow();
      }
      this.chatInput.setLoading(loading);
    }
  }

  private handleModelChanged(_model: ModelOption | null): void {
    void this.updateContextProgress();
  }

  private handlePromptChanged(_prompt: PromptOption | null): void {
    // Prompt changed
  }

  private async updateContextProgress(): Promise<void> {
    if (this.toolStatusBar) {
      await this.toolStatusBar.updateContext();
    }
  }

  private handleOpenTasks(): void {
    void openTaskBoardView(this.app, {}, 'tab');
  }

  private handleInspectTools(): void {
    const conversation = this.conversationManager.getCurrentConversation();
    if (!conversation) {
      return;
    }

    new ToolInspectionModal(this.app, {
      conversationId: conversation.id,
      historySource: {
        getToolCallMessagesForConversation: (conversationId, options) =>
          this.chatService.getToolCallMessagesForConversation(conversationId, options),
      },
    }, this).open();
  }

  private async ensurePreservationServiceAndCompact(): Promise<void> {
    // Lazy-init preservationService if subagent infrastructure hasn't loaded yet.
    // This decouples compaction from the subagent init path so the compact button
    // always works, even before subagent setup completes.
    if (!this.preservationService) {
      try {
        const plugin = getNexusPlugin(this.app) as { getServiceIfReady?<T>(name: string): T | null } | null;
        const agentManager = plugin?.getServiceIfReady?.('agentManager') as AgentManager | null;
        const llmService = this.chatService.getLLMService();
        if (agentManager && llmService) {
          const { DirectToolExecutor } = await import('../../services/chat/DirectToolExecutor');
          const agentProvider = {
            getAgent: (name: string) => agentManager.getAgent(name),
            getAllAgents: () => agentManager.getAgents(),
          };
          const executor = new DirectToolExecutor({ agentProvider });
          this.preservationService = new ContextPreservationService({
            llmService: llmService as unknown as import('../../services/chat/ContextPreservationService').PreservationDependencies['llmService'],
            getAgent: (name: string) => { try { return agentManager.getAgent(name); } catch { return null; } },
            executeToolCalls: async (toolCalls: unknown[], context?: { sessionId?: string; workspaceId?: string }) => {
              // ContextPreservationService calls tools by bare name (e.g. "createState").
              // DirectToolExecutor expects "agentName_toolName" format. Map bare names
              // to their agent-qualified form.
              const mapped = toolCalls.map(tc => {
                const call = tc as Record<string, unknown>;
                const name = typeof call.name === 'string' ? call.name : '';
                return { ...call, name: name.includes('_') ? name : `memoryManager_${name}` };
              });
              return executor.executeToolCalls(mapped as never, context as never);
            },
          });
        }
      } catch (error) {
        console.warn('[ChatView] Failed to lazy-init preservationService:', error);
      }
    }
    await this.sendCoordinator.compactCurrentConversation();
  }

  private async handleOpenAgentStatus(): Promise<void> {
    if (!this.branchViewCoordinator) return;

    // Lazy-init subagent infrastructure if it hasn't loaded yet
    if (!this.subagentController) {
      try {
        await this.initializeSubagentInfrastructure();
      } catch (error) {
        console.warn('[ChatView] Failed to lazy-init subagent infrastructure for agent status:', error);
        new Notice('Subagent system unavailable', 2500);
        return;
      }
    }

    try {
      this.branchViewCoordinator.openAgentStatusModal();
    } catch (error) {
      console.warn('[ChatView] Failed to open agent status modal:', error);
      new Notice('Subagent system unavailable', 2500);
    }
  }

  private closeConversationListOnMobile(): void {
    if (!Platform.isMobile || !this.uiStateController?.getSidebarVisible()) {
      return;
    }

    this.uiStateController.toggleConversationList();
  }

  private updateChatTitle(): void {
    const conversation = this.conversationManager.getCurrentConversation();

    if (this.layoutElements.chatTitle) {
      const title = conversation?.title || 'Nexus Chat';
      this.layoutElements.chatTitle.textContent = title;
      this.layoutElements.chatTitle.setAttr('title', title);
    }
  }

  // Tool event handlers delegated to coordinator

  private handleToolEvent(
    messageId: string,
    event: 'detected' | 'updated' | 'started' | 'completed',
    data: ChatToolEventData | ChatServiceToolEventData
  ): void {
    this.toolEventCoordinator.handleToolEvent(messageId, event, data as ChatToolEventData);
  }

  private handleMessageIdUpdated(oldId: string, newId: string, updatedMessage: ConversationMessage): void {
    this.messageDisplay.updateMessageId(oldId, newId, updatedMessage);
  }

  isViewingBranch(): boolean {
    return this.branchViewCoordinator.isViewingBranch();
  }

  /**
   * Get current branch context (for external use)
   */
  getCurrentBranchContext(): BranchViewContext | null {
    return this.branchViewCoordinator.getCurrentBranchContext();
  }

  private cleanup(): void {
    if (this.searchDebounceTimer) {
      clearTimeout(this.searchDebounceTimer);
      this.searchDebounceTimer = null;
    }
    this.conversationList?.cleanup();
    this.messageDisplay?.cleanup();
    this.chatInput?.cleanup();
    this.toolStatusBar?.cleanup();
    this.uiStateController?.cleanup();
    this.streamingController?.cleanup();
    this.nexusLoadingController?.unload();
    this.subagentController?.cleanup();
    this.branchViewCoordinator.cleanup();
  }
}
