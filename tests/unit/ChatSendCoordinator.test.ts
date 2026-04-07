import { ChatSendCoordinator } from '../../src/ui/chat/services/ChatSendCoordinator';
import type { ConversationData, ConversationMessage } from '../../src/types/chat/ChatTypes';

function createMessage(
  id: string,
  role: ConversationMessage['role'],
  content: string
): ConversationMessage {
  return {
    id,
    role,
    content,
    timestamp: 1000,
    conversationId: 'conv-1'
  };
}

function createConversation(messages: ConversationMessage[]): ConversationData {
  return {
    id: 'conv-1',
    title: 'Conversation',
    created: 1000,
    updated: 2000,
    messages,
    metadata: {
      chatSettings: {
        sessionId: 'session-1'
      }
    }
  };
}

function createHarness() {
  const conversation = createConversation([
    createMessage('u1', 'user', 'first request'),
    createMessage('a1', 'assistant', 'partial response'),
    createMessage('u2', 'user', 'follow-up request'),
    createMessage('a2', 'assistant', 'latest response')
  ]);

  const bubble = {
    stopLoadingAnimation: jest.fn()
  };

  const contentEl = {} as Element;
  const messageEl = {
    querySelector: jest.fn((selector: string) =>
      selector === '.message-bubble .message-content' ? contentEl : null
    )
  } as unknown as Element;
  const containerEl = {
    querySelector: jest.fn((selector: string) =>
      selector === '[data-message-id="a1"]' ? messageEl : null
    )
  } as unknown as HTMLElement;

  const conversationManager = {
    getCurrentConversation: jest.fn().mockReturnValue(conversation)
  };

  const messageManager = {
    getIsLoading: jest.fn().mockReturnValue(false),
    interruptCurrentGeneration: jest.fn().mockResolvedValue(undefined),
    sendMessage: jest.fn().mockResolvedValue(undefined),
    handleRetryMessage: jest.fn().mockResolvedValue(undefined),
    handleEditMessage: jest.fn().mockResolvedValue(undefined),
    cancelCurrentGeneration: jest.fn().mockResolvedValue(undefined)
  };

  const modelAgentManager = {
    setMessageEnhancement: jest.fn(),
    clearMessageEnhancement: jest.fn(),
    getMessageOptions: jest.fn().mockResolvedValue({
      provider: 'github-copilot',
      model: 'copilot-model',
      systemPrompt: 'System prompt'
    }),
    shouldCompactBeforeSending: jest.fn().mockReturnValue(false),
    getSelectedWorkspaceId: jest.fn().mockReturnValue('workspace-1'),
    appendCompactionRecord: jest.fn(),
    buildMetadataWithCompactionRecord: jest.fn().mockImplementation((_metadata, compactedContext) => ({
      chatSettings: { sessionId: 'session-1' },
      compaction: { frontier: [compactedContext] }
    })),
    resetTokenTracker: jest.fn()
  };

  const chatInput = {
    clearMessageEnhancer: jest.fn(),
    setPreSendCompacting: jest.fn()
  };

  const messageDisplay = {
    showTransientEventRow: jest.fn(),
    clearTransientEventRow: jest.fn(),
    findMessageBubble: jest.fn().mockReturnValue(bubble)
  };

  const streamingController = {
    stopLoadingAnimation: jest.fn(),
    finalizeStreaming: jest.fn()
  };

  const updateConversation = jest.fn().mockResolvedValue(undefined);
  const chatService = {
    getConversationService: jest.fn().mockReturnValue({
      updateConversation
    }),
    updateConversation: jest.fn().mockResolvedValue(undefined)
  };

  const compactionService = {
    compact: jest.fn().mockImplementation((targetConversation: ConversationData) => {
      targetConversation.messages = targetConversation.messages.slice(-2);
      return {
        summary: 'Compacted summary',
        messagesRemoved: 2,
        messagesKept: 2,
        filesReferenced: [],
        topics: ['topic'],
        compactedAt: 3000
      };
    })
  };

  const onUpdateContextProgress = jest.fn();

  const coordinator = new ChatSendCoordinator({
    app: {} as never,
    chatService: chatService as never,
    getContainerEl: () => containerEl,
    getConversationManager: () => conversationManager,
    getMessageManager: () => messageManager,
    getModelAgentManager: () => modelAgentManager,
    getChatInput: () => chatInput,
    getMessageDisplay: () => messageDisplay,
    getStreamingController: () => streamingController,
    getPreservationService: () => null,
    getStorageAdapter: () => null,
    onUpdateContextProgress,
    compactionService
  });

  return {
    coordinator,
    conversation,
    contentEl,
    conversationManager,
    messageManager,
    modelAgentManager,
    chatInput,
    messageDisplay,
    streamingController,
    chatService,
    updateConversation,
    compactionService,
    onUpdateContextProgress,
    bubble
  };
}

describe('ChatSendCoordinator', () => {
  it('compacts context before sending when the selected model requires it', async () => {
    const harness = createHarness();
    harness.modelAgentManager.shouldCompactBeforeSending.mockReturnValue(true);

    await harness.coordinator.handleSendMessage('next message');

    expect(harness.compactionService.compact).toHaveBeenCalledTimes(1);
    expect(harness.modelAgentManager.getMessageOptions).toHaveBeenCalledTimes(2);
    expect(harness.chatInput.setPreSendCompacting).toHaveBeenCalledWith(true);
    expect(harness.messageDisplay.showTransientEventRow).toHaveBeenCalledWith('Compacting context before sending...');
    expect(harness.modelAgentManager.appendCompactionRecord).toHaveBeenCalledTimes(1);
    expect(harness.modelAgentManager.resetTokenTracker).toHaveBeenCalledTimes(1);
    expect(harness.updateConversation).toHaveBeenCalledWith('conv-1', expect.objectContaining({
      title: 'Conversation',
      messages: harness.conversation.messages
    }));
    expect(harness.onUpdateContextProgress).toHaveBeenCalledTimes(1);
    expect(harness.messageManager.sendMessage).toHaveBeenCalledWith(
      harness.conversation,
      'next message',
      expect.objectContaining({
        provider: 'github-copilot',
        model: 'copilot-model'
      }),
      undefined
    );
    expect(harness.modelAgentManager.clearMessageEnhancement).toHaveBeenCalledTimes(1);
    expect(harness.chatInput.clearMessageEnhancer).toHaveBeenCalledTimes(1);
    expect(harness.messageDisplay.clearTransientEventRow).toHaveBeenCalled();
  });

  it('stops animations and finalizes with the persisted partial content when generation aborts', () => {
    const harness = createHarness();

    harness.coordinator.handleGenerationAborted('a1');

    expect(harness.messageDisplay.findMessageBubble).toHaveBeenCalledWith('a1');
    expect(harness.bubble.stopLoadingAnimation).toHaveBeenCalledTimes(1);
    expect(harness.streamingController.stopLoadingAnimation).toHaveBeenCalledWith(harness.contentEl);
    expect(harness.streamingController.finalizeStreaming).toHaveBeenCalledWith('a1', 'partial response');
  });
});
