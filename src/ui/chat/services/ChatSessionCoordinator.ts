import { Component, Notice } from 'obsidian';
import { ChatService } from '../../../services/chat/ChatService';
import { ConversationData } from '../../../types/chat/ChatTypes';
import { ChatEventBinder } from '../utils/ChatEventBinder';

export interface WorkflowMessageOptions {
  provider?: string;
  model?: string;
  systemPrompt?: string;
  workspaceId?: string;
  sessionId?: string;
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
  chatService: ChatService;
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

    const conversation = await this.deps.chatService.getConversation(conversationId);
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

    void messageManager.sendMessage(currentConversation, message, options).catch(error => {
      console.error('[ChatSessionCoordinator] Failed to send workflow message:', error);
      new Notice('Failed to start workflow run');
    });
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

    const hasProviders = this.deps.chatService.hasConfiguredProviders();
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
