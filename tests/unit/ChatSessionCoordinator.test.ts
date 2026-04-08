import { Component } from 'obsidian';
import { ChatSessionCoordinator } from '../../src/ui/chat/services/ChatSessionCoordinator';
import { ConversationData } from '../../src/types/chat/ChatTypes';

class FakeElement {
  textContent = '';
  className = '';
  private children: FakeElement[] = [];

  appendChild(child: FakeElement): void {
    this.children.push(child);
  }

  querySelector(selector: string): FakeElement | null {
    if (selector === '.chat-welcome-button') {
      return this.children.find(child => child.className === 'chat-welcome-button') ?? null;
    }

    return null;
  }
}

function createConversation(id = 'conv-1', title = 'Conversation'): ConversationData {
  return {
    id,
    title,
    messages: [],
    created: 1000,
    updated: 2000,
  };
}

function createCoordinatorHarness() {
  const containerEl = new FakeElement();
  const chatTitleEl = new FakeElement();

  const component = {
    registerDomEvent: jest.fn(),
  } as unknown as Component;

  const conversationManager = {
    loadConversations: jest.fn().mockResolvedValue(undefined),
    getConversations: jest.fn().mockReturnValue([]),
    getCurrentConversation: jest.fn().mockReturnValue(null),
    selectConversation: jest.fn().mockResolvedValue(undefined),
    createNewConversation: jest.fn().mockResolvedValue(undefined),
    isSearchActive: false,
    hasMore: false,
    isLoading: false,
  };

  const messageManager = {
    getIsLoading: jest.fn().mockReturnValue(false),
    cancelCurrentGeneration: jest.fn().mockResolvedValue(undefined),
    interruptCurrentGeneration: jest.fn().mockResolvedValue(undefined),
    sendMessage: jest.fn().mockResolvedValue(undefined),
  };

  const modelAgentManager = {
    initializeDefaults: jest.fn().mockResolvedValue(undefined),
    initializeFromConversation: jest.fn().mockResolvedValue(undefined),
    setCurrentConversationId: jest.fn(),
  };

  const conversationList = {
    setIsSearchActive: jest.fn(),
    setConversations: jest.fn(),
    setHasMore: jest.fn(),
    setIsLoading: jest.fn(),
  };

  const messageDisplay = {
    setConversation: jest.fn(),
  };

  const chatInput = {
    setConversationState: jest.fn(),
  };

  const uiStateController = {
    showWelcomeState: jest.fn((hasProviders: boolean) => {
      if (hasProviders) {
        const button = new FakeElement();
        button.className = 'chat-welcome-button';
        containerEl.appendChild(button);
      }
    }),
    setInputPlaceholder: jest.fn(),
    getSidebarVisible: jest.fn().mockReturnValue(false),
    toggleConversationList: jest.fn(),
  };

  const chatService = {
    hasConfiguredProviders: jest.fn().mockReturnValue(true),
    getConversation: jest.fn(),
  };

  const onUpdateChatTitle = jest.fn();
  const onUpdateContextProgress = jest.fn();
  const onClearStreamingState = jest.fn();
  const onClearAgentStatus = jest.fn();

  const coordinator = new ChatSessionCoordinator({
    chatService: chatService as never,
    component,
      getContainerEl: () => containerEl as unknown as HTMLElement,
      getChatTitleEl: () => chatTitleEl as unknown as HTMLElement,
    getConversationManager: () => conversationManager as never,
    getMessageManager: () => messageManager as never,
    getModelAgentManager: () => modelAgentManager as never,
    getConversationList: () => conversationList as never,
    getMessageDisplay: () => messageDisplay as never,
    getChatInput: () => chatInput as never,
    getUIStateController: () => uiStateController as never,
    onClearStreamingState,
    onClearAgentStatus,
    onUpdateChatTitle,
    onUpdateContextProgress,
  });

  return {
    coordinator,
    containerEl,
    chatTitleEl,
    component,
    conversationManager,
    messageManager,
    modelAgentManager,
    conversationList,
    messageDisplay,
    chatInput,
    uiStateController,
    chatService,
    onUpdateChatTitle,
    onUpdateContextProgress,
    onClearStreamingState,
    onClearAgentStatus,
  };
}

describe('ChatSessionCoordinator', () => {
  it('shows welcome state and binds the welcome button when initial data is empty', async () => {
    const harness = createCoordinatorHarness();

    await harness.coordinator.loadInitialData();

    expect(harness.conversationManager.loadConversations).toHaveBeenCalledTimes(1);
    expect(harness.modelAgentManager.initializeDefaults).toHaveBeenCalledTimes(1);
    expect(harness.chatService.hasConfiguredProviders).toHaveBeenCalledTimes(1);
    expect(harness.uiStateController.showWelcomeState).toHaveBeenCalledWith(true);
    expect(harness.chatTitleEl.textContent).toBe('Chat');
    expect(harness.chatInput.setConversationState).toHaveBeenCalledWith(false);
    expect(harness.component.registerDomEvent).toHaveBeenCalledTimes(1);
    expect(harness.containerEl.querySelector('.chat-welcome-button')).not.toBeNull();
  });

  it('sets the current conversation id through ModelAgentManager public API when selecting a conversation', async () => {
    const harness = createCoordinatorHarness();
    const conversation = createConversation('conv-selected', 'Selected');

    await harness.coordinator.handleConversationSelected(conversation);

    expect(harness.modelAgentManager.setCurrentConversationId).toHaveBeenCalledWith('conv-selected');
    expect(harness.modelAgentManager.initializeFromConversation).toHaveBeenCalledWith('conv-selected');
    expect(harness.messageDisplay.setConversation).toHaveBeenCalledWith(conversation);
    expect(harness.uiStateController.setInputPlaceholder).toHaveBeenCalledWith('Type your message...');
    expect(harness.chatInput.setConversationState).toHaveBeenCalledWith(true);
    expect(harness.onClearAgentStatus).toHaveBeenCalledTimes(1);
    expect(harness.onUpdateChatTitle).toHaveBeenCalledTimes(1);
    expect(harness.onUpdateContextProgress).toHaveBeenCalledTimes(1);
  });
});
