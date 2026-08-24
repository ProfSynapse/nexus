import { Component } from 'obsidian';
import { ChatService } from '../../../services/chat/ChatService';
import { ConversationData } from '../../../types/chat/ChatTypes';
import { ChatEventBinder } from '../utils/ChatEventBinder';

export interface WorkflowMessageOptions {
  provider?: string;
  model?: string;
  systemPrompt?: string;
  workspaceId?: string;
  sessionId?: string;
  operationOrigin?: import('../../../types/tools/ToolOperationTypes').ToolExecutionOrigin;
  operationScopeId?: string;
  enableThinking?: boolean;
  thinkingEffort?: 'low' | 'medium' | 'high';
}

interface ConversationManagerLike {
  loadConversations(): Promise<void>;
  getConversations(): ConversationData[];
  getCurrentConversation(): ConversationData | null;
  selectConversation(conversation: ConversationData): Promise<void>;
  createNewConversation(): Promise<void>;
  isSearchActive: boolean;
  hasMore: boolean;
  isLoading: boolean;
}

interface MessageManagerLike {
  getIsLoading(): boolean;
  interruptCurrentGeneration(): Promise<void>;
  sendMessage(
    conversation: ConversationData,
    message: string,
    options?: WorkflowMessageOptions
  ): Promise<void>;
}

interface ModelAgentManagerLike {
  initializeDefaults(): Promise<void>;
  initializeFromConversation(conversationId: string): Promise<void>;
  setCurrentConversationId(conversationId: string | null): void;
}

interface ConversationListLike {
  setIsSearchActive(isSearchActive: boolean): void;
  setConversations(conversations: ConversationData[]): void;
  setHasMore(hasMore: boolean): void;
  setIsLoading(isLoading: boolean): void;
}

interface MessageDisplayLike {
  setConversation(conversation: ConversationData): void;
}

interface ChatInputLike {
  setConversationState(hasConversation: boolean): void;
}

interface UIStateControllerLike {
  showWelcomeState(hasConfiguredProviders?: boolean): void;
  setInputPlaceholder(placeholder: string): void;
  getSidebarVisible(): boolean;
  toggleConversationList(): void;
}

interface ChatSessionCoordinatorDependencies {
  /**
   * Resolved lazily — see the note on ChatSubagentIntegration's getChatService.
   * ChatView is constructed before the plugin's service graph produces
   * chatService, so this dependency must never be captured by value.
   */
  getChatService: () => ChatService | null;
  component: Component;
  getContainerEl: () => HTMLElement;
  getChatTitleEl: () => HTMLElement | null;
  getConversationManager: () => ConversationManagerLike | null;
  getMessageManager: () => MessageManagerLike | null;
  getModelAgentManager: () => ModelAgentManagerLike | null;
  getConversationList: () => ConversationListLike | null;
  getMessageDisplay: () => MessageDisplayLike | null;
  getChatInput: () => ChatInputLike | null;
  getUIStateController: () => UIStateControllerLike | null;
  onClearStreamingState: () => void;
  onClearAgentStatus: () => void;
  onUpdateChatTitle: () => void;
  onUpdateContextProgress: () => void;
}

export class ChatSessionCoordinator {
  private pendingConversationId: string | null = null;

  constructor(private readonly deps: ChatSessionCoordinatorDependencies) {}

  async loadInitialData(): Promise<void> {
    const conversationManager = this.deps.getConversationManager();
    if (!conversationManager) {
      return;
    }

    await conversationManager.loadConversations();

    if (conversationManager.getConversations().length === 0) {
      await this.showWelcomeState();
    }

    if (this.pendingConversationId) {
      const pendingId = this.pendingConversationId;
      this.pendingConversationId = null;
      await this.openConversationById(pendingId);
    }
  }

  async openConversationById(conversationId: string): Promise<void> {
    const conversationManager = this.deps.getConversationManager();
    if (!conversationManager) {
      this.pendingConversationId = conversationId;
      return;
    }

    const chatService = this.deps.getChatService();
    if (!chatService) {
      return;
    }

    const conversation = await chatService.getConversation(conversationId);
    if (!conversation) {
      return;
    }

    await conversationManager.loadConversations();
    const listedConversation = conversationManager
      .getConversations()
      .find(item => item.id === conversationId);

    await conversationManager.selectConversation(listedConversation || conversation);
  }

  async sendMessageToConversation(
    conversationId: string,
    message: string,
    options?: WorkflowMessageOptions
  ): Promise<void> {
    const conversationManager = this.deps.getConversationManager();
    const messageManager = this.deps.getMessageManager();
    if (!conversationManager || !messageManager) {
      this.pendingConversationId = conversationId;
      throw new Error('Chat view is not ready');
    }

    await this.openConversationById(conversationId);

    const currentConversation = conversationManager.getCurrentConversation();
    if (!currentConversation || currentConversation.id !== conversationId) {
      throw new Error('Failed to focus workflow conversation');
    }

    if (messageManager.getIsLoading()) {
      await messageManager.interruptCurrentGeneration();
    }

    const existingMessageIds = new Set(currentConversation.messages.map(item => item.id));
    await messageManager.sendMessage(currentConversation, message, options);

    const assistantResponse = [...currentConversation.messages]
      .reverse()
      .find(item => item.role === 'assistant' && !existingMessageIds.has(item.id));
    if (!assistantResponse) {
      throw new Error('Workflow run did not produce an assistant response.');
    }
    if (assistantResponse.state === 'invalid') {
      throw new Error('Workflow run failed during generation.');
    }
    if (assistantResponse.state === 'aborted') {
      throw new Error('Workflow run was aborted.');
    }
    if (assistantResponse.state !== 'complete') {
      throw new Error('Workflow run ended without a completed assistant response.');
    }
  }

  async handleConversationSelected(conversation: ConversationData): Promise<void> {
    const messageManager = this.deps.getMessageManager();
    const modelAgentManager = this.deps.getModelAgentManager();
    const messageDisplay = this.deps.getMessageDisplay();
    const chatInput = this.deps.getChatInput();
    const uiStateController = this.deps.getUIStateController();
    if (!messageManager || !modelAgentManager || !messageDisplay || !uiStateController) {
      return;
    }

    if (messageManager.getIsLoading()) {
      void messageManager.interruptCurrentGeneration();
      this.deps.onClearStreamingState();
    }

    this.deps.onClearAgentStatus();
    modelAgentManager.setCurrentConversationId(conversation.id);

    await modelAgentManager.initializeFromConversation(conversation.id);
    messageDisplay.setConversation(conversation);
    this.deps.onUpdateChatTitle();
    uiStateController.setInputPlaceholder('Type your message...');
    this.deps.onUpdateContextProgress();
    chatInput?.setConversationState(true);

    if (uiStateController.getSidebarVisible()) {
      uiStateController.toggleConversationList();
    }
  }

  async handleConversationsChanged(): Promise<void> {
    const conversationManager = this.deps.getConversationManager();
    if (!conversationManager) {
      return;
    }

    const conversationList = this.deps.getConversationList();
    if (conversationList) {
      conversationList.setIsSearchActive(conversationManager.isSearchActive);
      conversationList.setConversations(conversationManager.getConversations());
      conversationList.setHasMore(conversationManager.hasMore);
      conversationList.setIsLoading(conversationManager.isLoading);
    }

    const conversations = conversationManager.getConversations();
    const currentConversation = conversationManager.getCurrentConversation();

    if (conversations.length === 0 && !conversationManager.isSearchActive) {
      await this.showWelcomeState();
      return;
    }

    if (!currentConversation && conversations.length > 0) {
      await conversationManager.selectConversation(conversations[0]);
    }
  }

  private async showWelcomeState(): Promise<void> {
    const modelAgentManager = this.deps.getModelAgentManager();
    const uiStateController = this.deps.getUIStateController();
    if (!modelAgentManager || !uiStateController) {
      return;
    }

    await modelAgentManager.initializeDefaults();

    const hasProviders = this.deps.getChatService()?.hasConfiguredProviders() ?? false;
    uiStateController.showWelcomeState(hasProviders);

    const chatTitle = this.deps.getChatTitleEl();
    if (chatTitle) {
      chatTitle.textContent = 'Chat';
    }

    this.deps.getChatInput()?.setConversationState(false);

    if (hasProviders) {
      this.bindWelcomeButton();
    }
  }

  private bindWelcomeButton(): void {
    ChatEventBinder.bindWelcomeButton(
      this.deps.getContainerEl(),
      () => {
        const conversationManager = this.deps.getConversationManager();
        if (conversationManager) {
          void conversationManager.createNewConversation();
        }
      },
      this.deps.component
    );
  }
}
