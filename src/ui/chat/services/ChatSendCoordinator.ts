import { Notice, type App } from 'obsidian';
import type { IMessageRepository } from '../../../database/repositories/interfaces/IMessageRepository';
import { ChatService } from '../../../services/chat/ChatService';
import {
  ContextCompactionService,
  type CompactedContext,
  type CompactionOptions
} from '../../../services/chat/ContextCompactionService';
import { CompactionTranscriptRecoveryService } from '../../../services/chat/CompactionTranscriptRecoveryService';
import type { ContextPreservationService } from '../../../services/chat/ContextPreservationService';
import type { ConversationData, ConversationMessage } from '../../../types/chat/ChatTypes';
import type { MessageEnhancement } from '../components/suggesters/base/SuggesterInterfaces';
import type { ReferenceMetadata } from '../utils/ReferenceExtractor';
import { GLOBAL_WORKSPACE_ID } from '../../../services/WorkspaceService';
import { isTextOnlyProvider } from '../../../services/llm/utils/ToolSchemaSupport';
import { ContextHandoffService, type HandoffModelConfig } from '../../../services/chat/ContextHandoffService';
import { ContextBudgetService } from '../../../services/chat/ContextBudgetService';

export interface MessageExecutionOptions {
  provider?: string;
  model?: string;
  systemPrompt?: string;
  workspaceId?: string;
  sessionId?: string;
  enableThinking?: boolean;
  webSearch?: boolean;
  thinkingEffort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  temperature?: number;
  imageProvider?: 'google' | 'openrouter' | 'openai';
  imageModel?: string;
  transcriptionProvider?: string;
  transcriptionModel?: string;
}

interface ConversationManagerLike {
  getCurrentConversation(): ConversationData | null;
}

interface MessageManagerLike {
  getIsLoading(): boolean;
  interruptCurrentGeneration(): Promise<void>;
  sendMessage(
    conversation: ConversationData,
    message: string,
    options?: MessageExecutionOptions,
    metadata?: ReferenceMetadata
  ): Promise<void>;
  handleRetryMessage(
    conversation: ConversationData,
    messageId: string,
    options?: MessageExecutionOptions
  ): Promise<void>;
  handleEditMessage(
    conversation: ConversationData,
    messageId: string,
    newContent: string,
    options?: MessageExecutionOptions
  ): Promise<void>;
  cancelCurrentGeneration(): Promise<void>;
}

interface ModelAgentManagerLike {
  waitForContextHandoff?(): Promise<void>;
  isContextHandoffPending?(): boolean;
  getHandoffSystemPrompt?(): Promise<string | null>;
  cancelContextHandoff?(): void;
  setMessageEnhancement(enhancement: MessageEnhancement): void;
  clearMessageEnhancement(): void;
  getMessageOptions(): Promise<MessageExecutionOptions>;
  getEffectiveContextWindow?(): number;
  shouldCompactBeforeSending(
    conversation: ConversationData,
    message: string,
    systemPrompt: string | null,
    provider: string | undefined
  ): boolean;
  getSelectedWorkspaceId(): string | null;
  appendCompactionRecord(context: CompactedContext): void;
  buildMetadataWithCompactionRecord(
    metadata: ConversationData['metadata'],
    context: CompactedContext
  ): ConversationData['metadata'];
  resetTokenTracker(): void;
}

interface ChatInputLike {
  clearMessageEnhancer(): void;
  setPreSendCompacting(compacting: boolean): void;
}

interface MessageBubbleLike {
  stopLoadingAnimation(): void;
}

interface MessageDisplayLike {
  showTransientEventRow(message: string): void;
  clearTransientEventRow(): void;
  showCompactionDivider(messagesRemoved: number): void;
  findMessageBubble(messageId: string): MessageBubbleLike | undefined;
}

interface StreamingControllerLike {
  stopLoadingAnimation(element: Element): void;
  finalizeStreaming(messageId: string, content: string): void;
}

interface StorageAdapterLike {
  messages: Pick<IMessageRepository, 'getMessages'>;
}

interface ChatSendCoordinatorDependencies {
  app: App;
  /**
   * Resolved lazily — see the note on ChatSubagentIntegration's getChatService.
   * ChatView is constructed before the plugin's service graph produces
   * chatService, so this dependency must never be captured by value.
   */
  getChatService: () => ChatService | null;
  getContainerEl: () => HTMLElement;
  getConversationManager: () => ConversationManagerLike | null;
  getMessageManager: () => MessageManagerLike | null;
  getModelAgentManager: () => ModelAgentManagerLike | null;
  getChatInput: () => ChatInputLike | null;
  getMessageDisplay: () => MessageDisplayLike | null;
  getStreamingController: () => StreamingControllerLike | null;
  getPreservationService: () => ContextPreservationService | null;
  ensurePreservationService?: () => Promise<void>;
  getStorageAdapter: () => StorageAdapterLike | null;
  onUpdateContextProgress: () => void;
  compactionService?: {
    compact(conversation: ConversationData, options?: CompactionOptions): CompactedContext;
  };
}

export class ChatSendCoordinator {
  private pendingSend: symbol | null = null;
  private sendGeneration = 0;
  private preparingHandoffs = 0;
  private compactionOperation: Promise<boolean> | null = null;
  private readonly compactionService: {
    compact(conversation: ConversationData, options?: CompactionOptions): CompactedContext;
  };

  constructor(private readonly deps: ChatSendCoordinatorDependencies) {
    this.compactionService = deps.compactionService ?? new ContextCompactionService();
  }

  async handleSendMessage(
    message: string,
    enhancement?: MessageEnhancement,
    metadata?: ReferenceMetadata
  ): Promise<boolean> {
    if (this.pendingSend) return false;
    const messageManager = this.deps.getMessageManager();
    const conversationManager = this.deps.getConversationManager();
    const modelAgentManager = this.deps.getModelAgentManager();
    const chatInput = this.deps.getChatInput();
    if (!messageManager || !conversationManager || !modelAgentManager) {
      return false;
    }

    const currentConversation = conversationManager.getCurrentConversation();
    if (!currentConversation) return false;
    let sent = false;
    const token = Symbol('pending send');
    const generation = ++this.sendGeneration;
    this.pendingSend = token;
    try {
      await modelAgentManager.waitForContextHandoff?.();
      if (messageManager.getIsLoading()) {
        await messageManager.interruptCurrentGeneration();
      }

      if (conversationManager.getCurrentConversation()?.id !== currentConversation.id) {
        return false;
      }

      if (enhancement) {
        modelAgentManager.setMessageEnhancement(enhancement);
      }

      let messageOptions = await this.getReadyMessageOptions(modelAgentManager);

      // Runtime guard: a text-completion-only provider (e.g. Antigravity) cannot
      // execute Nexus tools/agents. If the user invoked tools/prompt-actions for
      // this send, the tool calls would silently no-op — surface a clear Notice
      // instead so the limitation is never silent.
      this.warnIfTextOnlyProviderWithTools(messageOptions.provider, enhancement);

      if (modelAgentManager.shouldCompactBeforeSending(
        currentConversation,
        message,
        messageOptions.systemPrompt || null,
        messageOptions.provider
      )) {
        if (enhancement) modelAgentManager.clearMessageEnhancement();
        await this.runContextCompaction(currentConversation);
        if (enhancement) modelAgentManager.setMessageEnhancement(enhancement);
        messageOptions = await this.getReadyMessageOptions(modelAgentManager);
        if (modelAgentManager.shouldCompactBeforeSending(
          currentConversation,
          message,
          messageOptions.systemPrompt || null,
          messageOptions.provider
        )) {
          new Notice('This message is still too large for the selected context budget after compaction. Increase context window in chat settings or shorten the message and added content.', 6000);
          return false;
        }
      }

      // A model change can begin while prompt assembly or compaction is awaited.
      if (modelAgentManager.isContextHandoffPending?.()) {
        messageOptions = await this.getReadyMessageOptions(modelAgentManager);
        if (modelAgentManager.shouldCompactBeforeSending(currentConversation, message, messageOptions.systemPrompt || null, messageOptions.provider)) {
          new Notice('The pending message exceeds the new context budget. Shorten it or increase the context window.');
          return false;
        }
      }
      if (conversationManager.getCurrentConversation()?.id !== currentConversation.id) return false;
      // Only preparation is coalesced. A later send may interrupt an active response.
      if (this.pendingSend === token) this.pendingSend = null;
      await messageManager.sendMessage(
        currentConversation,
        message,
        messageOptions,
        metadata
      );
      sent = true;
      return true;
    } finally {
      if (this.pendingSend === token) this.pendingSend = null;
      if (this.preparingHandoffs === 0 && generation === this.sendGeneration) this.setPreSendCompactionState(false);
      if (sent && generation === this.sendGeneration && !(metadata && 'hidden' in metadata && metadata.hidden === true)) {
        modelAgentManager.clearMessageEnhancement();
        chatInput?.clearMessageEnhancer();
      }
    }
  }

  private async getReadyMessageOptions(manager: ModelAgentManagerLike): Promise<MessageExecutionOptions> {
    while (true) {
      await manager.waitForContextHandoff?.();
      const options = await manager.getMessageOptions();
      if (!manager.isContextHandoffPending?.()) return options;
    }
  }

  /** Prepare against the old model; the manager owns durable commit and selection. */
  async prepareContextHandoff(request: {
    conversationId: string | null;
    source: HandoffModelConfig;
    destination: HandoffModelConfig;
    signal: AbortSignal;
  }): Promise<CompactedContext | undefined> {
    this.preparingHandoffs++;
    this.setPreSendCompactionState(true);
    try {
      await this.compactionOperation;
      const messageManager = this.deps.getMessageManager();
      if (messageManager?.getIsLoading()) await messageManager.interruptCurrentGeneration();
      const conversation = this.deps.getConversationManager()?.getCurrentConversation();
      if (!conversation || conversation.id !== request.conversationId) {
        throw new Error('The chat changed before context could be prepared');
      }
      const manager = this.deps.getModelAgentManager();
      const systemPrompt = manager?.getHandoffSystemPrompt
        ? await manager.getHandoffSystemPrompt()
        : (await manager?.getMessageOptions())?.systemPrompt;
      const tools = this.deps.getChatService()?.getContextTools(request.destination.providerId) ?? [];
      const candidate = await new ContextHandoffService().prepare({
        ...request,
        conversation,
        systemPrompt: systemPrompt ?? '',
        toolTokens: ContextBudgetService.estimateTextTokens(JSON.stringify(tools)),
        summarizer: async (messages, summaryOptions) => {
          await this.deps.ensurePreservationService?.();
          const preservation = this.deps.getPreservationService();
          if (!preservation) throw new Error('Context summarization is unavailable. The current model has been kept.');
          return preservation.summarizeForHandoff(messages, summaryOptions);
        }
      });
      if (candidate) {
        const keptMessages = ContextCompactionService.getMessagesAfterBoundary(conversation.messages, {
          compaction: { frontier: [candidate] }
        });
        candidate.transcriptCoverage = await this.buildCompactionTranscriptCoverage(
          conversation.id, conversation.messages, keptMessages
        ) ?? undefined;
      }
      return candidate;
    } finally {
      this.preparingHandoffs--;
      if (this.preparingHandoffs === 0) this.setPreSendCompactionState(false);
    }
  }

  /**
   * Surface a non-silent Notice when the active provider is text-completion only
   * (cannot call Nexus tools/agents) AND the user invoked tools or prompt actions
   * for this send — those calls would otherwise silently no-op. Stays quiet on
   * plain text chats, where the settings notice already communicates the limit.
   */
  private warnIfTextOnlyProviderWithTools(
    provider: string | undefined,
    enhancement?: MessageEnhancement
  ): void {
    if (!isTextOnlyProvider(provider)) {
      return;
    }

    const requestedTools = (enhancement?.tools?.length ?? 0) > 0;
    const requestedPrompts = (enhancement?.prompts?.length ?? 0) > 0;
    if (!requestedTools && !requestedPrompts) {
      return;
    }

    new Notice(
      'This provider is text completions only — it can\'t run tools or agents, so the requested tool calls won\'t execute. Switch providers for agentic, tool-driven work.',
      6000
    );
  }

  async compactCurrentConversation(): Promise<void> {
    await this.deps.getModelAgentManager()?.waitForContextHandoff?.();
    const messageManager = this.deps.getMessageManager();
    const conversationManager = this.deps.getConversationManager();
    if (!messageManager || !conversationManager) {
      return;
    }

    if (messageManager.getIsLoading()) {
      await messageManager.interruptCurrentGeneration();
    }

    const currentConversation = conversationManager.getCurrentConversation();
    if (!currentConversation) {
      return;
    }

    const compacted = await this.runContextCompaction(currentConversation, true);
    if (!compacted) return;
    // Continue outside the compaction operation so a simultaneous handoff can
    // finish preparation before this send waits for its committed selection.
    if (conversationManager.getCurrentConversation()?.id !== currentConversation.id) return;
    try {
      await this.handleSendMessage(
        'Continue where you left off — either continue the current work or align with the user on next steps.',
        undefined,
        { hidden: true } as unknown as ReferenceMetadata
      );
    } catch (error) {
      new Notice(error instanceof Error ? error.message : 'Could not continue after compaction');
    }
  }

  async handleRetryMessage(messageId: string): Promise<void> {
    await this.deps.getModelAgentManager()?.waitForContextHandoff?.();
    const currentConversation = this.deps.getConversationManager()?.getCurrentConversation();
    const messageManager = this.deps.getMessageManager();
    const modelAgentManager = this.deps.getModelAgentManager();
    if (!currentConversation || !messageManager || !modelAgentManager) {
      return;
    }
    if (!this.canEditActiveMessage(currentConversation, messageId)) return;

    const messageOptions = await this.getReadyMessageOptions(modelAgentManager);
    if (this.deps.getConversationManager()?.getCurrentConversation()?.id !== currentConversation.id
      || !this.canEditActiveMessage(currentConversation, messageId)) return;
    await messageManager.handleRetryMessage(currentConversation, messageId, messageOptions);
  }

  async handleEditMessage(messageId: string, newContent: string): Promise<void> {
    await this.deps.getModelAgentManager()?.waitForContextHandoff?.();
    const currentConversation = this.deps.getConversationManager()?.getCurrentConversation();
    const messageManager = this.deps.getMessageManager();
    const modelAgentManager = this.deps.getModelAgentManager();
    if (!currentConversation || !messageManager || !modelAgentManager) {
      return;
    }
    if (!this.canEditActiveMessage(currentConversation, messageId)) return;

    const messageOptions = await this.getReadyMessageOptions(modelAgentManager);
    if (this.deps.getConversationManager()?.getCurrentConversation()?.id !== currentConversation.id
      || !this.canEditActiveMessage(currentConversation, messageId)) return;
    await messageManager.handleEditMessage(
      currentConversation,
      messageId,
      newContent,
      messageOptions
    );
  }

  private canEditActiveMessage(conversation: ConversationData, messageId: string): boolean {
    const active = ContextCompactionService.getMessagesAfterBoundary(conversation.messages, conversation.metadata);
    if (active.some(message => message.id === messageId)) return true;
    new Notice('This message is in summarized history. Send a new message to continue with the current context.');
    return false;
  }

  handleStopGeneration(): void {
    this.deps.getModelAgentManager()?.cancelContextHandoff?.();
    void this.deps.getMessageManager()?.cancelCurrentGeneration();
  }

  handleGenerationAborted(messageId: string): void {
    const messageBubble = this.deps.getMessageDisplay()?.findMessageBubble(messageId);
    if (messageBubble) {
      messageBubble.stopLoadingAnimation();
    }

    const containerEl = this.deps.getContainerEl();
    const streamingController = this.deps.getStreamingController();
    const messageElement = containerEl.querySelector(`[data-message-id="${messageId}"]`);
    if (messageElement && streamingController) {
      const contentElement = messageElement.querySelector('.message-bubble .message-content');
      if (contentElement) {
        streamingController.stopLoadingAnimation(contentElement);
      }
    }

    const currentConversation = this.deps.getConversationManager()?.getCurrentConversation();
    const message = currentConversation?.messages.find(candidate => candidate.id === messageId);
    const actualContent = message?.content || '';
    if (actualContent && streamingController) {
      streamingController.finalizeStreaming(messageId, actualContent);
    }
  }

  private async performContextCompaction(conversation: ConversationData, manual = false): Promise<boolean> {
    const originalMessages = [...conversation.messages];
    const modelAgentManager = this.deps.getModelAgentManager();
    if (!modelAgentManager) {
      return false;
    }

    const activeMessages = ContextCompactionService.getMessagesAfterBoundary(
      originalMessages, conversation.metadata
    );
    const compactedContext = this.compactionService.compact(conversation, {
      exchangesToKeep: 2,
      maxSummaryLength: 500,
      includeFileReferences: true,
      // Automatic compaction is invoked only after the actual prompt exceeds
      // its budget. A single oversized exchange must be eligible for summary.
      compactAllIfNoRemovableUnits: !manual
    });
    if (compactedContext.messagesRemoved <= 0) {
      new Notice('Nothing to compact — conversation is short enough', 2500);
      return false;
    }

    const removedMessages = activeMessages.slice(0, compactedContext.messagesRemoved);
    await this.deps.ensurePreservationService?.();
    const preservationService = this.deps.getPreservationService();
    let usedLLM = false;

    if (preservationService) {
      const savingNotice = new Notice('Saving context...', 0);

      try {
        const messageOptions = await modelAgentManager.getMessageOptions();
        if (!messageOptions.provider || !messageOptions.model) throw new Error('No model selected for context summary');
        const sourceContextWindow = modelAgentManager.getEffectiveContextWindow?.() || 128_000;
        const maxTokens = Math.max(128, Math.min(1000, Math.floor(sourceContextWindow * 0.08)));
        // Earlier summaries remain in the frontier. Summarize only the newly
        // removed active suffix so the next record does not duplicate history.
        compactedContext.summary = await preservationService.summarizeForHandoff(
          removedMessages,
          { provider: messageOptions.provider, model: messageOptions.model, maxTokens, sourceContextWindow }
        );
        usedLLM = true;
        // Keep the existing createState archival side effect, using the bounded
        // summary so a prior large transcript is never sent to the smaller model.
        await preservationService.forceStateSave(
          [{ ...removedMessages[0], content: compactedContext.summary }],
          { provider: messageOptions.provider, model: messageOptions.model },
          { workspaceId: modelAgentManager.getSelectedWorkspaceId() || GLOBAL_WORKSPACE_ID,
            sessionId: conversation.metadata?.chatSettings?.sessionId }
        );
      } catch (error) {
        console.error('[Compaction] Context preservation failed:', error);
        new Notice('Context could not be safely compacted. The current context was kept.', 5000);
        return false;
      } finally {
        savingNotice.hide();
      }
    }
    if (!usedLLM && compactedContext.messagesKept === 0) {
      new Notice('Context summarization is unavailable. The current context was kept.', 5000);
      return false;
    }

    // Compute transcript coverage from compaction boundary.
    // Messages before the boundary are "compacted" (summarized, not sent to LLM).
    const keptMessages = activeMessages.slice(compactedContext.messagesRemoved);
    compactedContext.transcriptCoverage = await this.buildCompactionTranscriptCoverage(
      conversation.id, activeMessages, keptMessages
    ) ?? undefined;

    if (this.deps.getConversationManager()?.getCurrentConversation()?.id !== conversation.id) return false;
    const nextMetadata = modelAgentManager.buildMetadataWithCompactionRecord(
      conversation.metadata,
      compactedContext
    );
    if (!nextMetadata) throw new Error('Context boundary metadata is unavailable');

    // Commit the boundary durably before changing live prompt state. A failed
    // write must leave the previous summary and active suffix usable.
    const chatService = this.deps.getChatService();
    const conversationService = chatService?.getConversationService();
    try {
      if (conversationService?.updateConversationMetadata) {
        await conversationService.updateConversationMetadata(conversation.id, nextMetadata);
      } else if (conversationService?.updateConversation) {
        await conversationService.updateConversation(conversation.id, { metadata: nextMetadata });
      } else if (chatService) {
        const result = await chatService.updateConversation({ ...conversation, metadata: nextMetadata });
        if (!result.success) throw new Error(result.error || 'Could not save context boundary');
      } else {
        throw new Error('Conversation storage is unavailable');
      }
    } catch (error) {
      console.error('[Compaction] Failed to persist context boundary:', error);
      new Notice('Context could not be saved. The current context was kept.', 5000);
      return false;
    }
    if (this.deps.getConversationManager()?.getCurrentConversation()?.id !== conversation.id) return false;
    conversation.metadata = nextMetadata;
    modelAgentManager.appendCompactionRecord(compactedContext);
    modelAgentManager.resetTokenTracker();

    this.deps.onUpdateContextProgress();

    const savedMsg = usedLLM
      ? `Context saved (${compactedContext.messagesRemoved} messages compacted)`
      : `Context compacted (${compactedContext.messagesRemoved} messages)`;
    new Notice(savedMsg, 2500);

    // Show the divider BEFORE auto-continue so it marks the compaction boundary.
    // Insert it synchronously, then send the auto-continue message.
    // reconcile() may reorder message bubbles but leaves non-bubble DOM elements
    // at their insertion point — placing it here ensures correct visual order.
    this.deps.getMessageDisplay()?.showCompactionDivider(compactedContext.messagesRemoved);
    return true;
  }

  private async runContextCompaction(conversation: ConversationData, manual = false): Promise<boolean> {
    if (this.compactionOperation) return this.compactionOperation;
    this.setPreSendCompactionState(true);
    const operation = this.performContextCompaction(conversation, manual);
    this.compactionOperation = operation;
    try {
      return await operation;
    } finally {
      if (this.compactionOperation === operation) this.compactionOperation = null;
      if (this.preparingHandoffs === 0) this.setPreSendCompactionState(false);
    }
  }

  private async buildCompactionTranscriptCoverage(
    conversationId: string,
    originalMessages: ConversationMessage[],
    keptMessages: ConversationMessage[]
  ) {
    const storageAdapter = this.deps.getStorageAdapter();
    if (!storageAdapter) {
      return null;
    }

    const keptIds = new Set(keptMessages.map(message => message.id));
    const compactedMessageIds = originalMessages
      .filter(message => !keptIds.has(message.id))
      .map(message => message.id);

    if (compactedMessageIds.length === 0) {
      return null;
    }

    const transcriptRecoveryService = new CompactionTranscriptRecoveryService(
      storageAdapter.messages,
      this.deps.app
    );
    return transcriptRecoveryService.buildCoverageRef(conversationId, compactedMessageIds);
  }

  private setPreSendCompactionState(compacting: boolean): void {
    this.deps.getChatInput()?.setPreSendCompacting(compacting);

    const messageDisplay = this.deps.getMessageDisplay();
    if (!messageDisplay) {
      return;
    }

    if (compacting) {
      messageDisplay.showTransientEventRow('Compacting');
    } else {
      messageDisplay.clearTransientEventRow();
    }
  }
}
