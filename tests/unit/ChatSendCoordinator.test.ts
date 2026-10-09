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
import { ContextPreservationService } from '../../src/services/chat/ContextPreservationService';
import { ContextCompactionService } from '../../src/services/chat/ContextCompactionService';
import { CompactionFrontierService } from '../../src/services/chat/CompactionFrontierService';

// A pending/failed handoff must gate the real coordinator's send, not merely
// report a mocked successful compaction result.
describe('Context handoff send coordination', () => {
  test('waits for a handoff and sends the pending message exactly once', async () => {
    const harness = createHarness();
    let release!: () => void;
    harness.modelAgentManager.waitForContextHandoff.mockImplementation(() => new Promise<void>(resolve => { release = resolve; }));
    const send = harness.coordinator.handleSendMessage('pending draft');
    expect(harness.messageManager.sendMessage).not.toHaveBeenCalled();
    expect(await harness.coordinator.handleSendMessage('duplicate')).toBe(false);
    harness.modelAgentManager.waitForContextHandoff.mockResolvedValue(undefined);
    release();
    expect(await send).toBe(true);
    expect(harness.messageManager.sendMessage).toHaveBeenCalledTimes(1);
    expect(harness.messageManager.sendMessage.mock.calls[0][1]).toBe('pending draft');
  });

  test('failed or cancelled handoff leaves draft references available and sends nothing', async () => {
    const harness = createHarness();
    harness.modelAgentManager.waitForContextHandoff.mockRejectedValue(new Error('Context handoff was cancelled'));
    await expect(harness.coordinator.handleSendMessage('pending draft')).rejects.toThrow('cancelled');
    expect(harness.messageManager.sendMessage).not.toHaveBeenCalled();
    expect(harness.chatInput.clearMessageEnhancer).not.toHaveBeenCalled();
    expect(harness.modelAgentManager.clearMessageEnhancement).not.toHaveBeenCalled();
  });

  test('does not retry or edit a message removed from the active context', async () => {
    const h = createHarness();
    h.conversation.metadata = { compaction: { frontier: [{ boundaryMessageId: 'a2', boundaryMode: 'after' }] } };
    await h.coordinator.handleRetryMessage('a2');
    await h.coordinator.handleEditMessage('u1', 'edited request');
    expect(h.messageManager.handleRetryMessage).not.toHaveBeenCalled();
    expect(h.messageManager.handleEditMessage).not.toHaveBeenCalled();
  });

  test('does not move a pending draft into a different chat after waiting', async () => {
    const h = createHarness();
    let release!: () => void;
    h.modelAgentManager.waitForContextHandoff.mockImplementation(() => new Promise<void>(resolve => { release = resolve; }));
    const send = h.coordinator.handleSendMessage('original chat draft');
    h.conversationManager.getCurrentConversation.mockReturnValue({ ...h.conversation, id: 'different' });
    release();
    expect(await send).toBe(false);
    expect(h.messageManager.sendMessage).not.toHaveBeenCalled();
  });

  test('uses the previous model to prepare an oversized exchange without changing the transcript', async () => {
    const generateResponseStream = jest.fn(async function* () {
      yield { chunk: 'Goal and completed tool outcomes preserved.\nHANDOFF_SUMMARY_COMPLETE', complete: false };
      yield { chunk: '', complete: true, stopReason: 'end_turn' };
    });
    const preservation = new ContextPreservationService({
      llmService: { generateResponseStream }, getAgent: () => null,
      executeToolCalls: jest.fn()
    });
    const harness = createHarness('anthropic', preservation);
    harness.conversation.messages = [createMessage('huge', 'user', 'x'.repeat(1_000_000))];
    const original = harness.conversation.messages;
    const candidate = await harness.coordinator.prepareContextHandoff({
      conversationId: harness.conversation.id,
      source: { providerId: 'anthropic', modelId: 'source', contextWindow: 1_000_000 },
      destination: { providerId: 'openai', modelId: 'destination', contextWindow: 128_000 },
      signal: new AbortController().signal
    });
    expect(candidate).toBeDefined();
    expect(generateResponseStream).toHaveBeenCalled();
    expect(generateResponseStream.mock.calls[0][1]).toEqual(expect.objectContaining({ provider: 'anthropic', model: 'source' }));
    expect(harness.conversation.messages).toBe(original);
    expect(harness.updateConversation).not.toHaveBeenCalled();
    const later = createMessage('later', 'user', 'continue');
    expect(ContextCompactionService.getMessagesAfterBoundary([...original, later], { compaction: { frontier: [candidate] } })).toEqual([later]);
    expect(harness.messageManager.sendMessage).not.toHaveBeenCalled();
  });
});

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

function createHarness(provider = 'github-copilot', preservation: ContextPreservationService | null = null, realCompaction = false) {
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
    waitForContextHandoff: jest.fn().mockResolvedValue(undefined),
    isContextHandoffPending: jest.fn().mockReturnValue(false),
    cancelContextHandoff: jest.fn(),
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
    buildMetadataWithCompactionRecord: jest.fn().mockImplementation((metadata, compactedContext) => ({
      ...metadata,
      compaction: { frontier: new CompactionFrontierService().appendRecord(metadata?.compaction?.frontier ?? [], compactedContext) }
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
    getContextTools: jest.fn().mockReturnValue([]),
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
    getChatService: () => chatService as never,
    getContainerEl: () => containerEl,
    getConversationManager: () => conversationManager,
    getMessageManager: () => messageManager,
    getModelAgentManager: () => modelAgentManager,
    getChatInput: () => chatInput,
    getMessageDisplay: () => messageDisplay,
    getStreamingController: () => streamingController,
    getPreservationService: () => preservation,
    getStorageAdapter: () => null,
    onUpdateContextProgress,
    compactionService: realCompaction ? new ContextCompactionService() : compactionService
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
    // The refreshed prompt fits after one compaction.
    harness.modelAgentManager.shouldCompactBeforeSending.mockReturnValueOnce(true);

    await harness.coordinator.handleSendMessage('next message');

    expect(harness.compactionService.compact).toHaveBeenCalledTimes(1);
    expect(harness.chatInput.setPreSendCompacting).toHaveBeenCalledWith(true);
    expect(harness.messageDisplay.showTransientEventRow).toHaveBeenCalledWith('Compacting');
    expect(harness.modelAgentManager.appendCompactionRecord).toHaveBeenCalledTimes(1);
    expect(harness.modelAgentManager.resetTokenTracker).toHaveBeenCalledTimes(1);
    expect(harness.updateConversation).toHaveBeenCalledWith('conv-1', expect.objectContaining({
      metadata: harness.conversation.metadata
    }));
    expect(harness.onUpdateContextProgress).toHaveBeenCalledTimes(1);
    // Pre-send compaction resumes the pending send, without an extra model call.
    expect(harness.messageManager.sendMessage).toHaveBeenCalledWith(
      harness.conversation,
      'next message',
      expect.objectContaining({
        provider: 'github-copilot',
        model: 'copilot-model'
      }),
      undefined
    );
    expect(harness.messageManager.sendMessage).toHaveBeenCalledTimes(1);
    expect(harness.modelAgentManager.clearMessageEnhancement).toHaveBeenCalled();
    expect(harness.chatInput.clearMessageEnhancer).toHaveBeenCalled();
    expect(harness.messageDisplay.clearTransientEventRow).toHaveBeenCalled();
  });

  it('blocks the user send if the refreshed prompt still exceeds the selected context window', async () => {
    const harness = createHarness();
    harness.modelAgentManager.shouldCompactBeforeSending
      .mockReturnValueOnce(true)  // original user message
      .mockReturnValueOnce(true); // same user message with refreshed context

    const sent = await harness.coordinator.handleSendMessage('oversized message');

    expect(sent).toBe(false);
    expect(harness.modelAgentManager.shouldCompactBeforeSending).toHaveBeenCalledTimes(2);
    expect(harness.compactionService.compact).toHaveBeenCalledTimes(1);
    expect(harness.messageManager.sendMessage).not.toHaveBeenCalled();
    expect(mockNotices.some(notice => notice.message.includes('Increase context window'))).toBe(true);
    expect(harness.modelAgentManager.clearMessageEnhancement).not.toHaveBeenCalled();
    expect(harness.chatInput.clearMessageEnhancer).not.toHaveBeenCalled();
  });

  it('still resumes once after an explicit manual compaction', async () => {
    const harness = createHarness();
    await harness.coordinator.compactCurrentConversation();
    expect(harness.compactionService.compact).toHaveBeenCalledTimes(1);
    expect(harness.messageManager.sendMessage).toHaveBeenCalledTimes(1);
    expect(harness.messageManager.sendMessage).toHaveBeenCalledWith(
      harness.conversation, expect.stringContaining('Continue where you left off'),
      expect.anything(), { hidden: true }
    );
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

describe('ChatSendCoordinator compaction after a model handoff', () => {
  beforeEach(() => { mockNotices.length = 0; jest.clearAllMocks(); });

  const preservation = () => new ContextPreservationService({
    llmService: { generateResponseStream: jest.fn().mockImplementation(async function* (messages: ConversationMessage[]) {
      yield { chunk: `Fresh active context from ${messages[0].content.includes('u4') ? 'u4' : 'u2'}.\nHANDOFF_SUMMARY_COMPLETE`, complete: true };
    }) },
    getAgent: () => null,
    executeToolCalls: jest.fn()
  });

  it('manual compact immediately after a full handoff leaves its summary and exclusive boundary intact', async () => {
    const h = createHarness('openai', preservation(), true);
    h.conversation.metadata = { compaction: { frontier: [{
      summary: 'Original goal and decisions', boundaryMessageId: 'a2', boundaryMode: 'after',
      messagesRemoved: 4, messagesKept: 0, filesReferenced: [], topics: [], compactedAt: 1000
    }] } };
    await h.coordinator.compactCurrentConversation();
    expect(h.conversation.metadata.compaction.frontier).toHaveLength(1);
    expect(h.conversation.metadata.compaction.frontier[0].summary).toBe('Original goal and decisions');
    expect(ContextCompactionService.getMessagesAfterBoundary(h.conversation.messages, h.conversation.metadata)).toEqual([]);
    expect(h.updateConversation).not.toHaveBeenCalled();
    expect(h.messageManager.sendMessage).not.toHaveBeenCalled();
  });

  it('later automatic compaction advances through fresh turns without restoring old transcript', async () => {
    const generateResponseStream = jest.fn().mockImplementation(async function* () {
      yield { chunk: 'Fresh active context.\nHANDOFF_SUMMARY_COMPLETE', complete: true };
    });
    const h = createHarness('openai', new ContextPreservationService({
      llmService: { generateResponseStream }, getAgent: () => null, executeToolCalls: jest.fn()
    }), true);
    h.conversation.metadata = { compaction: { frontier: [{
      summary: 'Original goal and decisions', boundaryMessageId: 'a2', boundaryMode: 'after',
      messagesRemoved: 4, messagesKept: 0, filesReferenced: [], topics: [], compactedAt: 1000
    }] } };
    h.conversation.messages.push(
      createMessage('u3', 'user', 'u3 fresh request'), createMessage('a3', 'assistant', 'a3 answer'),
      createMessage('u4', 'user', 'u4 fresh request'), createMessage('a4', 'assistant', 'a4 answer'),
      createMessage('u5', 'user', 'u5 fresh request'), createMessage('a5', 'assistant', 'a5 answer')
    );
    h.modelAgentManager.shouldCompactBeforeSending.mockReturnValueOnce(true);
    expect(await h.coordinator.handleSendMessage('next')).toBe(true);
    const frontier = h.conversation.metadata.compaction.frontier;
    expect(frontier[0].summary).toBe('Original goal and decisions');
    expect(frontier[frontier.length - 1].boundaryMessageId).toBe('u4');
    expect(frontier[frontier.length - 1].summary).toBe('Fresh active context.');
    expect(generateResponseStream).toHaveBeenCalledTimes(1);
    const preservationInput = generateResponseStream.mock.calls[0][0][0].content as string;
    expect(preservationInput).toContain('u3 fresh request');
    expect(preservationInput).not.toContain('first request');
    expect(preservationInput).not.toContain('Original goal and decisions');
    expect(ContextCompactionService.getMessagesAfterBoundary(h.conversation.messages, h.conversation.metadata).map(message => message.id)).toEqual(['u4', 'a4', 'u5', 'a5']);
    expect(h.conversation.messages.map(message => message.id)).toEqual(['u1', 'a1', 'u2', 'a2', 'u3', 'a3', 'u4', 'a4', 'u5', 'a5']);
  });

  it('keeps the previous summary and boundary when the active summary fails', async () => {
    const h = createHarness('openai', new ContextPreservationService({
      llmService: { generateResponseStream: jest.fn().mockImplementation(async function* () {
        yield { chunk: 'Truncated', complete: true, finishReason: 'length' };
      }) }, getAgent: () => null, executeToolCalls: jest.fn()
    }), true);
    h.conversation.metadata = { compaction: { frontier: [{
      summary: 'Original goal and decisions', boundaryMessageId: 'a2', boundaryMode: 'after',
      messagesRemoved: 4, messagesKept: 0, filesReferenced: [], topics: [], compactedAt: 1000
    }] } };
    h.conversation.messages.push(createMessage('u3', 'user', 'fresh oversized request'));
    h.modelAgentManager.shouldCompactBeforeSending.mockReturnValue(true);
    expect(await h.coordinator.handleSendMessage('new request')).toBe(false);
    expect(h.conversation.metadata.compaction.frontier).toHaveLength(1);
    expect(h.conversation.metadata.compaction.frontier[0].summary).toBe('Original goal and decisions');
    expect(ContextCompactionService.getMessagesAfterBoundary(h.conversation.messages, h.conversation.metadata).map(message => message.id)).toEqual(['u3']);
    expect(h.updateConversation).not.toHaveBeenCalled();
    expect(h.messageManager.sendMessage).not.toHaveBeenCalled();
  });

  it('does not advance the live frontier when persistence fails', async () => {
    const h = createHarness('openai', preservation(), true);
    h.conversation.messages.push(createMessage('u3', 'user', 'fresh oversized request'));
    h.modelAgentManager.shouldCompactBeforeSending.mockReturnValue(true);
    h.updateConversation.mockRejectedValueOnce(new Error('disk unavailable'));
    expect(await h.coordinator.handleSendMessage('next')).toBe(false);
    expect(h.conversation.metadata.compaction).toBeUndefined();
    expect(h.modelAgentManager.appendCompactionRecord).not.toHaveBeenCalled();
    expect(h.modelAgentManager.resetTokenTracker).not.toHaveBeenCalled();
    expect(h.messageManager.sendMessage).not.toHaveBeenCalled();
  });

  it('does not append an old chat summary after navigation during summarization', async () => {
    let release!: () => void;
    const h = createHarness('openai', new ContextPreservationService({
      llmService: { generateResponseStream: jest.fn().mockImplementation(async function* () {
        await new Promise<void>(resolve => { release = resolve; });
        yield { chunk: 'Old chat summary.\nHANDOFF_SUMMARY_COMPLETE', complete: true };
      }) }, getAgent: () => null, executeToolCalls: jest.fn()
    }), true);
    h.conversation.messages.push(createMessage('u3', 'user', 'fresh oversized request'));
    h.modelAgentManager.shouldCompactBeforeSending.mockReturnValue(true);
    const send = h.coordinator.handleSendMessage('next');
    while (!release) await Promise.resolve();
    h.conversationManager.getCurrentConversation.mockReturnValue({ ...h.conversation, id: 'another-chat' });
    release();
    expect(await send).toBe(false);
    expect(h.modelAgentManager.appendCompactionRecord).not.toHaveBeenCalled();
    expect(h.updateConversation).not.toHaveBeenCalled();
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
