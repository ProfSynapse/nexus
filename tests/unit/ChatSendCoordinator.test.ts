// Notice-spy: preserve the full real obsidian mock (ContextCompactionService and
// other transitive imports depend on it) and swap ONLY Notice for a constructor
// spy that records {message, timeout} into a shared array. Mirrors the
// established DataTab.test.ts pattern.
const mockNotices: Array<{ message: string; timeout?: number }> = [];
jest.mock('obsidian', () => {
  const actual = jest.requireActual('obsidian');
  return {
    ...actual,
    Notice: jest.fn().mockImplementation((message: string, timeout?: number) => {
      mockNotices.push({ message, timeout });
      return { message, timeout, hide: jest.fn() };
    })
  };
});

import { ChatSendCoordinator } from '../../src/ui/chat/services/ChatSendCoordinator';
import type { ConversationData, ConversationMessage } from '../../src/types/chat/ChatTypes';
import type { MessageEnhancement } from '../../src/ui/chat/components/suggesters/base/SuggesterInterfaces';

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

function createHarness(provider = 'github-copilot') {
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
      provider,
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
    showCompactionDivider: jest.fn(),
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

/**
 * Build a minimal MessageEnhancement carrying only the fields the text-only
 * runtime guard inspects (tools / prompts lengths). Other required fields are
 * filled with empty defaults and cast — the guard never reads them.
 */
function enhancementWith(
  parts: { tools?: unknown[]; prompts?: unknown[] }
): MessageEnhancement {
  return {
    originalMessage: '',
    cleanedMessage: '',
    tools: parts.tools ?? [],
    prompts: parts.prompts ?? [],
    notes: [],
    workspaces: [],
    totalTokens: 0
  } as unknown as MessageEnhancement;
}

describe('ChatSendCoordinator', () => {
  beforeEach(() => {
    mockNotices.length = 0;
    jest.clearAllMocks();
  });

  it('compacts context before sending when the selected model requires it', async () => {
    const harness = createHarness();
    // Return true only for the first call (user's message).
    // Auto-continue after compaction calls handleSendMessage again — return false to avoid infinite loop.
    harness.modelAgentManager.shouldCompactBeforeSending.mockReturnValueOnce(true);

    await harness.coordinator.handleSendMessage('next message');

    expect(harness.compactionService.compact).toHaveBeenCalledTimes(1);
    expect(harness.chatInput.setPreSendCompacting).toHaveBeenCalledWith(true);
    expect(harness.messageDisplay.showTransientEventRow).toHaveBeenCalledWith('Compacting');
    expect(harness.modelAgentManager.appendCompactionRecord).toHaveBeenCalledTimes(1);
    expect(harness.modelAgentManager.resetTokenTracker).toHaveBeenCalledTimes(1);
    expect(harness.updateConversation).toHaveBeenCalledWith('conv-1', expect.objectContaining({
      title: 'Conversation',
      messages: harness.conversation.messages
    }));
    expect(harness.onUpdateContextProgress).toHaveBeenCalledTimes(1);
    // sendMessage is called twice: once for the user's message, once for auto-continue
    expect(harness.messageManager.sendMessage).toHaveBeenCalledWith(
      harness.conversation,
      'next message',
      expect.objectContaining({
        provider: 'github-copilot',
        model: 'copilot-model'
      }),
      undefined
    );
    expect(harness.messageManager.sendMessage).toHaveBeenCalledTimes(2);
    expect(harness.modelAgentManager.clearMessageEnhancement).toHaveBeenCalled();
    expect(harness.chatInput.clearMessageEnhancer).toHaveBeenCalled();
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

describe('ChatSendCoordinator text-only provider runtime guard', () => {
  beforeEach(() => {
    mockNotices.length = 0;
    jest.clearAllMocks();
  });

  const TEXT_ONLY_NOTICE =
    "This provider is text completions only — it can't run tools or agents, so the requested tool calls won't execute. Switch providers for agentic, tool-driven work.";

  it('fires a Notice when a text-only provider (Antigravity) is active AND tools were invoked', async () => {
    const harness = createHarness('google-gemini-cli');

    await harness.coordinator.handleSendMessage(
      'edit my note',
      enhancementWith({ tools: [{ id: 'content_read' }] })
    );

    expect(mockNotices).toHaveLength(1);
    expect(mockNotices[0].message).toBe(TEXT_ONLY_NOTICE);
    expect(mockNotices[0].timeout).toBe(6000);
    // The guard is a warning only — it must NOT block the send.
    expect(harness.messageManager.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('fires a Notice when a text-only provider is active AND prompt actions were invoked', async () => {
    const harness = createHarness('perplexity');

    await harness.coordinator.handleSendMessage(
      'run my prompt',
      enhancementWith({ prompts: [{ id: 'summarize' }] })
    );

    expect(mockNotices).toHaveLength(1);
    expect(mockNotices[0].message).toBe(TEXT_ONLY_NOTICE);
  });

  it('stays SILENT on a plain-text send (no tools/prompts) for a text-only provider', async () => {
    const harness = createHarness('google-gemini-cli');

    // No enhancement at all — the settings notice already communicates the limit.
    await harness.coordinator.handleSendMessage('just chatting');

    expect(mockNotices).toHaveLength(0);
    expect(harness.messageManager.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('stays SILENT for a text-only provider when enhancement has empty tools/prompts arrays', async () => {
    const harness = createHarness('google-gemini-cli');

    await harness.coordinator.handleSendMessage(
      'just chatting',
      enhancementWith({ tools: [], prompts: [] })
    );

    expect(mockNotices).toHaveLength(0);
  });

  it('stays SILENT for a normal tool-capable provider even when tools were invoked', async () => {
    const harness = createHarness('openai');

    await harness.coordinator.handleSendMessage(
      'edit my note',
      enhancementWith({ tools: [{ id: 'content_read' }] })
    );

    expect(mockNotices).toHaveLength(0);
    expect(harness.messageManager.sendMessage).toHaveBeenCalledTimes(1);
  });
});
