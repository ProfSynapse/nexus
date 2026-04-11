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

export interface MessageExecutionOptions {
  provider?: string;
  model?: string;
  systemPrompt?: string;
  workspaceId?: string;
  sessionId?: string;
  enableThinking?: boolean;
  thinkingEffort?: 'low' | 'medium' | 'high';
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
  setMessageEnhancement(enhancement: MessageEnhancement): void;
  clearMessageEnhancement(): void;
  getMessageOptions(): Promise<MessageExecutionOptions>;
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
  chatService: ChatService;
  getContainerEl: () => HTMLElement;
  getConversationManager: () => ConversationManagerLike | null;
  getMessageManager: () => MessageManagerLike | null;
  getModelAgentManager: () => ModelAgentManagerLike | null;
  getChatInput: () => ChatInputLike | null;
  getMessageDisplay: () => MessageDisplayLike | null;
  getStreamingController: () => StreamingControllerLike | null;
  getPreservationService: () => ContextPreservationService | null;
  getStorageAdapter: () => StorageAdapterLike | null;
  onUpdateContextProgress: () => void;
  compactionService?: {
    compact(conversation: ConversationData, options?: CompactionOptions): CompactedContext;
  };
}

export class ChatSendCoordinator {
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
  ): Promise<void> {
    const messageManager = this.deps.getMessageManager();
    const conversationManager = this.deps.getConversationManager();
    const modelAgentManager = this.deps.getModelAgentManager();
    const chatInput = this.deps.getChatInput();
    if (!messageManager || !conversationManager || !modelAgentManager) {
      return;
    }

    try {
      if (messageManager.getIsLoading()) {
        await messageManager.interruptCurrentGeneration();
      }

      const currentConversation = conversationManager.getCurrentConversation();
      if (!currentConversation) {
        return;
      }

      if (enhancement) {
        modelAgentManager.setMessageEnhancement(enhancement);
      }

      let messageOptions = await modelAgentManager.getMessageOptions();

      if (modelAgentManager.shouldCompactBeforeSending(
        currentConversation,
        message,
        messageOptions.systemPrompt || null,
        messageOptions.provider
      )) {
        await this.runContextCompaction(currentConversation);
        messageOptions = await modelAgentManager.getMessageOptions();
      }

      await messageManager.sendMessage(
        currentConversation,
        message,
        messageOptions,
        metadata
      );
    } finally {
      this.setPreSendCompactionState(false);
      modelAgentManager.clearMessageEnhancement();
      chatInput?.clearMessageEnhancer();
    }
  }

  async compactCurrentConversation(): Promise<void> {
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

    await this.runContextCompaction(currentConversation);
  }

  async handleRetryMessage(messageId: string): Promise<void> {
    const currentConversation = this.deps.getConversationManager()?.getCurrentConversation();
    const messageManager = this.deps.getMessageManager();
    const modelAgentManager = this.deps.getModelAgentManager();
    if (!currentConversation || !messageManager || !modelAgentManager) {
      return;
    }

    const messageOptions = await modelAgentManager.getMessageOptions();
    await messageManager.handleRetryMessage(currentConversation, messageId, messageOptions);
  }

  async handleEditMessage(messageId: string, newContent: string): Promise<void> {
    const currentConversation = this.deps.getConversationManager()?.getCurrentConversation();
    const messageManager = this.deps.getMessageManager();
    const modelAgentManager = this.deps.getModelAgentManager();
    if (!currentConversation || !messageManager || !modelAgentManager) {
      return;
    }

    const messageOptions = await modelAgentManager.getMessageOptions();
    await messageManager.handleEditMessage(
      currentConversation,
      messageId,
      newContent,
      messageOptions
    );
  }

  handleStopGeneration(): void {
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

  private async performContextCompaction(conversation: ConversationData): Promise<void> {
    const originalMessages = [...conversation.messages];
    const preservationService = this.deps.getPreservationService();
    const modelAgentManager = this.deps.getModelAgentManager();
    if (!modelAgentManager) {
      return;
    }

    let stateContent: string | undefined;
    let usedLLM = false;

    if (preservationService) {
      const savingNotice = new Notice('Saving context...', 0);

      try {
        const messageOptions = await modelAgentManager.getMessageOptions();
        const result = await preservationService.forceStateSave(
          conversation.messages,
          {
            provider: messageOptions.provider,
            model: messageOptions.model,
          },
          {
            workspaceId: modelAgentManager.getSelectedWorkspaceId() || undefined,
            sessionId: conversation.metadata?.chatSettings?.sessionId,
          }
        );

        if (result.success && result.stateContent) {
          stateContent = result.stateContent;
          usedLLM = true;
        }
      } catch (error) {
        console.error('[ChatSendCoordinator] LLM-driven saveState failed, using programmatic fallback:', error);
      } finally {
        savingNotice.hide();
      }
    }

    const compactedContext = this.compactionService.compact(conversation, {
      exchangesToKeep: 2,
      maxSummaryLength: 500,
      includeFileReferences: true
    });

    if (compactedContext.messagesRemoved <= 0) {
      return;
    }

    if (stateContent) {
      compactedContext.summary = stateContent;
    }

    compactedContext.transcriptCoverage = await this.buildCompactionTranscriptCoverage(
      conversation.id,
      originalMessages,
      conversation.messages
    ) ?? undefined;

    modelAgentManager.appendCompactionRecord(compactedContext);
    conversation.metadata = modelAgentManager.buildMetadataWithCompactionRecord(
      conversation.metadata,
      compactedContext
    );
    modelAgentManager.resetTokenTracker();

    const conversationService = this.deps.chatService.getConversationService();
    if (conversationService?.updateConversation) {
      await conversationService.updateConversation(conversation.id, {
        title: conversation.title,
        messages: conversation.messages,
        metadata: conversation.metadata
      });
    } else {
      await this.deps.chatService.updateConversation(conversation);
    }

    this.deps.onUpdateContextProgress();

    const savedMsg = usedLLM
      ? `Context saved (${compactedContext.messagesRemoved} messages compacted)`
      : `Context compacted (${compactedContext.messagesRemoved} messages)`;
    new Notice(savedMsg, 2500);
  }

  private async runContextCompaction(conversation: ConversationData): Promise<void> {
    this.setPreSendCompactionState(true);
    try {
      await this.performContextCompaction(conversation);
    } finally {
      this.setPreSendCompactionState(false);
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
      messageDisplay.showTransientEventRow('Compacting context before sending...');
    } else {
      messageDisplay.clearTransientEventRow();
    }
  }
}
