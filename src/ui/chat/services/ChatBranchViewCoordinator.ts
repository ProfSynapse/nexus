import type { Component } from 'obsidian';
import { isSubagentMetadata } from '../../../types/branch/BranchTypes';
import type { ConversationData, ConversationMessage } from '../../../types/chat/ChatTypes';
import { BranchHeader, type BranchHeaderCallbacks, type BranchViewContext } from '../components/BranchHeader';
import type { SubagentContextProvider } from '../controllers/SubagentController';

interface BranchManagerLike {
  switchToBranchByIndex(
    conversation: ConversationData,
    messageId: string,
    alternativeIndex: number
  ): Promise<boolean>;
}

interface ConversationManagerLike {
  getCurrentConversation(): ConversationData | null;
  setCurrentConversation(conversation: ConversationData | null): void;
}

interface MessageDisplayLike {
  setConversation(conversation: ConversationData): void;
  updateMessage(messageId: string, updatedMessage: ConversationMessage): void;
  getScrollPosition(): number;
  setScrollPosition(position: number): void;
}

interface StreamingControllerLike {
  startStreaming(messageId: string): void;
}

interface BranchHeaderLike {
  show(context: BranchViewContext): void;
  hide(): void;
  update(context: Partial<BranchViewContext>): void;
  cleanup(): void;
}

interface SubagentControllerLike {
  getStreamingBranchMessages(branchId: string): ConversationMessage[] | null;
  setCurrentBranchContext(context: BranchViewContext | null): void;
  cancelSubagent(subagentId: string): boolean;
  openStatusModal(
    contextProvider: SubagentContextProvider,
    callbacks: {
      onViewBranch: (branchId: string) => void;
      onContinueAgent: (branchId: string) => void;
    }
  ): void;
  isInitialized(): boolean;
}

interface ChatBranchViewCoordinatorDependencies {
  component: Component;
  getConversation: (conversationId: string) => Promise<ConversationData | null>;
  getConversationManager: () => ConversationManagerLike | null;
  getBranchManager: () => BranchManagerLike | null;
  getMessageDisplay: () => MessageDisplayLike | null;
  getStreamingController: () => StreamingControllerLike | null;
  getSubagentController: () => SubagentControllerLike | null;
  getBranchHeaderContainer: () => HTMLElement | null;
  getSubagentContextProvider: () => SubagentContextProvider;
  requestAnimationFrame?: (callback: FrameRequestCallback) => number;
  branchHeaderFactory?: (
    container: HTMLElement,
    callbacks: BranchHeaderCallbacks,
    component: Component
  ) => BranchHeaderLike;
}

export class ChatBranchViewCoordinator {
  private branchHeader: BranchHeaderLike | null = null;
  private currentBranchContext: BranchViewContext | null = null;
  private parentConversationId: string | null = null;
  private parentScrollPosition = 0;

  constructor(private readonly deps: ChatBranchViewCoordinatorDependencies) {}

  handleBranchCreated(_messageId: string, _branchId: string): void {
    const currentConversation = this.deps.getConversationManager()?.getCurrentConversation();
    if (currentConversation) {
      this.deps.getMessageDisplay()?.setConversation(currentConversation);
    }
  }

  handleBranchSwitched(_messageId: string, _branchId: string): void {
    // Intentional no-op. The caller that switches alternatives by index already
    // performs a targeted updateMessage call on success. Re-rendering the full
    // conversation here reintroduces the double-update race that corrupts
    // branch output.
  }

  async handleBranchSwitchedByIndex(messageId: string, alternativeIndex: number): Promise<void> {
    const conversationManager = this.deps.getConversationManager();
    const branchManager = this.deps.getBranchManager();
    const messageDisplay = this.deps.getMessageDisplay();
    const currentConversation = conversationManager?.getCurrentConversation();

    if (!currentConversation || !branchManager || !messageDisplay) {
      return;
    }

    const success = await branchManager.switchToBranchByIndex(
      currentConversation,
      messageId,
      alternativeIndex
    );

    if (!success) {
      return;
    }

    const updatedMessage = currentConversation.messages.find(msg => msg.id === messageId);
    if (updatedMessage) {
      messageDisplay.updateMessage(messageId, updatedMessage);
    }
  }

  async navigateToBranch(branchId: string): Promise<void> {
    const conversationManager = this.deps.getConversationManager();
    const messageDisplay = this.deps.getMessageDisplay();
    if (!conversationManager || !messageDisplay) {
      return;
    }

    const currentConversation = conversationManager.getCurrentConversation();
    if (!currentConversation) {
      return;
    }

    try {
      const inMemoryCurrent = conversationManager.getCurrentConversation();
      const branchConversation = (inMemoryCurrent && inMemoryCurrent.id === branchId)
        ? inMemoryCurrent
        : await this.deps.getConversation(branchId);

      if (!branchConversation) {
        console.error('[ChatBranchViewCoordinator] Branch conversation not found:', branchId);
        return;
      }

      if (!this.parentConversationId) {
        this.parentConversationId = currentConversation.id;
        this.parentScrollPosition = messageDisplay.getScrollPosition();
      }

      const subagentController = this.deps.getSubagentController();
      const inMemoryMessages = subagentController?.getStreamingBranchMessages(branchId);
      const isStreaming = inMemoryMessages !== null;

      const branchType = branchConversation.metadata?.branchType || 'human';
      const parentMessageId = branchConversation.metadata?.parentMessageId || '';

      this.currentBranchContext = {
        conversationId: branchConversation.metadata?.parentConversationId || currentConversation.id,
        branchId,
        parentMessageId,
        branchType: branchType as 'human' | 'subagent',
        metadata: branchConversation.metadata?.subagent || { description: branchConversation.title },
      };

      subagentController?.setCurrentBranchContext(this.currentBranchContext);
      conversationManager.setCurrentConversation(branchConversation);

      if (isStreaming && inMemoryMessages) {
        const streamingView: ConversationData = {
          ...branchConversation,
          messages: inMemoryMessages,
        };
        messageDisplay.setConversation(streamingView);
      } else {
        messageDisplay.setConversation(branchConversation);
      }

      if (isStreaming && inMemoryMessages && inMemoryMessages.length > 0) {
        const lastMessage = inMemoryMessages[inMemoryMessages.length - 1];
        if (lastMessage.state === 'streaming') {
          this.deps.getStreamingController()?.startStreaming(lastMessage.id);
        }
      }

      this.getOrCreateBranchHeader().show(this.currentBranchContext);
    } catch (error) {
      console.error('[ChatBranchViewCoordinator] Failed to navigate to branch:', error);
    }
  }

  async navigateToParent(): Promise<void> {
    this.branchHeader?.hide();
    this.currentBranchContext = null;
    this.deps.getSubagentController()?.setCurrentBranchContext(null);

    const parentId = this.parentConversationId;
    const scrollPosition = this.parentScrollPosition;
    this.parentConversationId = null;
    this.parentScrollPosition = 0;

    const conversationManager = this.deps.getConversationManager();
    const messageDisplay = this.deps.getMessageDisplay();
    if (!conversationManager || !messageDisplay) {
      return;
    }

    if (parentId) {
      const parentConversation = await this.deps.getConversation(parentId);
      if (parentConversation) {
        conversationManager.setCurrentConversation(parentConversation);
        messageDisplay.setConversation(parentConversation);
        const raf = this.deps.requestAnimationFrame ?? requestAnimationFrame;
        raf(() => {
          messageDisplay.setScrollPosition(scrollPosition);
        });
        return;
      }
    }

    const currentConversation = conversationManager.getCurrentConversation();
    if (currentConversation) {
      const updated = await this.deps.getConversation(currentConversation.id);
      if (updated) {
        conversationManager.setCurrentConversation(updated);
        messageDisplay.setConversation(updated);
      }
    }
  }

  cancelSubagent(subagentId: string): void {
    const cancelled = this.deps.getSubagentController()?.cancelSubagent(subagentId);
    if (!cancelled) {
      return;
    }

    const contextMetadata = this.currentBranchContext?.metadata;
    if (isSubagentMetadata(contextMetadata) && contextMetadata.subagentId === subagentId) {
      this.branchHeader?.update({
        metadata: { ...contextMetadata, state: 'cancelled' },
      });
    }
  }

  async continueSubagent(_branchId: string): Promise<void> {
    await this.navigateToParent();
  }

  openAgentStatusModal(): void {
    const subagentController = this.deps.getSubagentController();
    if (!subagentController?.isInitialized()) {
      console.warn('[ChatBranchViewCoordinator] SubagentController not initialized - cannot open modal');
      return;
    }

    subagentController.openStatusModal(this.deps.getSubagentContextProvider(), {
      onViewBranch: (branchId) => {
        void this.navigateToBranch(branchId);
      },
      onContinueAgent: (branchId) => {
        void this.continueSubagent(branchId);
      },
    });
  }

  isViewingBranch(): boolean {
    return this.currentBranchContext !== null;
  }

  getCurrentBranchContext(): BranchViewContext | null {
    return this.currentBranchContext;
  }

  cleanup(): void {
    this.branchHeader?.cleanup();
  }

  private getOrCreateBranchHeader(): BranchHeaderLike {
    if (this.branchHeader) {
      return this.branchHeader;
    }

    const container = this.deps.getBranchHeaderContainer();
    if (!container) {
      throw new Error('Branch header container is not available');
    }

    const createBranchHeader = this.deps.branchHeaderFactory
      ?? ((headerContainer: HTMLElement, callbacks: BranchHeaderCallbacks, component: Component) =>
        new BranchHeader(headerContainer, callbacks, component));

    this.branchHeader = createBranchHeader(
      container,
      {
        onNavigateToParent: () => {
          void this.navigateToParent();
        },
        onCancel: (subagentId) => {
          this.cancelSubagent(subagentId);
        },
        onContinue: (branchId) => {
          void this.continueSubagent(branchId);
        },
      },
      this.deps.component
    );

    return this.branchHeader;
  }
}
