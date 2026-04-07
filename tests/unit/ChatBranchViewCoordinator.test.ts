import { Component } from 'obsidian';
import { ChatBranchViewCoordinator } from '../../src/ui/chat/services/ChatBranchViewCoordinator';
import type { ConversationData, ConversationMessage } from '../../src/types/chat/ChatTypes';
import type { SubagentContextProvider } from '../../src/ui/chat/controllers/SubagentController';

function createConversationMessage(id: string, role: ConversationMessage['role'], content: string): ConversationMessage {
  return {
    id,
    role,
    content,
    timestamp: 1000,
    conversationId: 'parent-1',
  };
}

function createConversation(
  id: string,
  title: string,
  metadata?: ConversationData['metadata']
): ConversationData {
  return {
    id,
    title,
    created: 1000,
    updated: 2000,
    messages: [createConversationMessage('msg-1', 'assistant', 'Message')],
    metadata,
  };
}

function createHarness() {
  const parentConversation = createConversation('parent-1', 'Parent');
  const branchConversation = createConversation('branch-1', 'Branch', {
    parentConversationId: 'parent-1',
    parentMessageId: 'msg-1',
    branchType: 'subagent',
    subagentTask: 'Do work',
    subagent: {
      subagentId: 'sub-1',
      task: 'Do work',
      state: 'running',
      iterations: 1,
      maxIterations: 3,
      startedAt: 1000,
    },
  } as ConversationData['metadata'] & { subagent: Record<string, unknown> });

  let currentConversation: ConversationData | null = parentConversation;

  const conversationManager = {
    getCurrentConversation: jest.fn(() => currentConversation),
    setCurrentConversation: jest.fn((conversation: ConversationData | null) => {
      currentConversation = conversation;
    }),
  };

  const branchManager = {
    switchToBranchByIndex: jest.fn().mockResolvedValue(true),
  };

  const messageDisplay = {
    setConversation: jest.fn(),
    updateMessage: jest.fn(),
    getScrollPosition: jest.fn().mockReturnValue(42),
    setScrollPosition: jest.fn(),
  };

  const streamingController = {
    startStreaming: jest.fn(),
  };

  const subagentController = {
    getStreamingBranchMessages: jest.fn().mockReturnValue(null),
    setCurrentBranchContext: jest.fn(),
    cancelSubagent: jest.fn().mockReturnValue(true),
    isInitialized: jest.fn().mockReturnValue(true),
    openStatusModal: jest.fn(),
  };

  const branchHeader = {
    show: jest.fn(),
    hide: jest.fn(),
    update: jest.fn(),
    cleanup: jest.fn(),
  };
  const branchHeaderFactory = jest.fn(() => branchHeader);

  const contextProvider: SubagentContextProvider = {
    getCurrentConversation: () => currentConversation,
    getSelectedModel: () => null,
    getSelectedPrompt: () => null,
    getLoadedWorkspaceData: () => null,
    getContextNotes: () => [],
    getThinkingSettings: () => null,
    getSelectedWorkspaceId: () => null,
  };

  const coordinator = new ChatBranchViewCoordinator({
    component: {} as Component,
    getConversation: jest.fn(async (conversationId: string) => {
      if (conversationId === 'branch-1') {
        return branchConversation;
      }
      if (conversationId === 'parent-1') {
        return parentConversation;
      }
      return null;
    }),
    getConversationManager: () => conversationManager,
    getBranchManager: () => branchManager,
    getMessageDisplay: () => messageDisplay,
    getStreamingController: () => streamingController,
    getSubagentController: () => subagentController,
    getSubagentContextProvider: () => contextProvider,
    getBranchHeaderContainer: () => ({}) as HTMLElement,
    branchHeaderFactory,
  });

  return {
    coordinator,
    parentConversation,
    branchConversation,
    conversationManager,
    branchManager,
    messageDisplay,
    subagentController,
    branchHeader,
    branchHeaderFactory,
  };
}

describe('ChatBranchViewCoordinator', () => {
  it('navigates to a branch and back to the parent conversation', async () => {
    const harness = createHarness();
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const originalRequestAnimationFrame = global.requestAnimationFrame;
    global.requestAnimationFrame = ((callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    }) as typeof requestAnimationFrame;

    try {
      await harness.coordinator.navigateToBranch('branch-1');

      expect(harness.conversationManager.setCurrentConversation).toHaveBeenCalledWith(harness.branchConversation);
      expect(harness.messageDisplay.setConversation).toHaveBeenCalledWith(harness.branchConversation);
      expect(harness.subagentController.setCurrentBranchContext).toHaveBeenCalledWith(
        expect.objectContaining({
          branchId: 'branch-1',
          conversationId: 'parent-1',
        })
      );
      expect(harness.branchHeaderFactory).toHaveBeenCalledTimes(1);
      expect(harness.branchHeader.show).toHaveBeenCalledWith(
        expect.objectContaining({ branchId: 'branch-1' })
      );
      expect(harness.coordinator.isViewingBranch()).toBe(true);

      await harness.coordinator.navigateToParent();

      expect(harness.branchHeader.hide).toHaveBeenCalledTimes(1);
      expect(harness.conversationManager.setCurrentConversation).toHaveBeenLastCalledWith(harness.parentConversation);
      expect(harness.messageDisplay.setConversation).toHaveBeenLastCalledWith(harness.parentConversation);
      expect(harness.messageDisplay.setScrollPosition).toHaveBeenCalledWith(42);
      expect(harness.subagentController.setCurrentBranchContext).toHaveBeenLastCalledWith(null);
      expect(harness.coordinator.isViewingBranch()).toBe(false);
      expect(harness.coordinator.getCurrentBranchContext()).toBeNull();
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    } finally {
      global.requestAnimationFrame = originalRequestAnimationFrame;
      consoleErrorSpy.mockRestore();
    }
  });

  it('updates branch header metadata when cancelling the active subagent', async () => {
    const harness = createHarness();

    await harness.coordinator.navigateToBranch('branch-1');
    harness.coordinator.cancelSubagent('sub-1');

    expect(harness.subagentController.cancelSubagent).toHaveBeenCalledWith('sub-1');
    expect(harness.branchHeader.update).toHaveBeenCalledWith({
      metadata: expect.objectContaining({
        subagentId: 'sub-1',
        state: 'cancelled',
      }),
    });
  });

  it('does not rerender the full conversation when branch manager emits a switch event', async () => {
    const harness = createHarness();

    await harness.coordinator.handleBranchSwitchedByIndex('msg-1', 1);

    expect(harness.branchManager.switchToBranchByIndex).toHaveBeenCalledWith(
      harness.parentConversation,
      'msg-1',
      1
    );
    expect(harness.messageDisplay.updateMessage).toHaveBeenCalledTimes(1);
    expect(harness.messageDisplay.setConversation).not.toHaveBeenCalled();
  });
});
