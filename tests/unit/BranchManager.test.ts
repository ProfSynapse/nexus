/**
 * BranchManager Unit Tests
 *
 * Tests for message-level branching operations.
 * Bug #10: getActiveMessageToolCalls was falling through to original message
 * data when a branch had no messages (e.g., still loading).
 *
 * Key behaviors verified:
 * - getActiveMessageToolCalls returns branch data when branch is active
 * - Returns undefined (not original data) when branch has no messages
 * - getActiveMessageContent returns empty string for empty branches
 */

import { BranchManager } from '../../src/ui/chat/services/BranchManager';
import {
  createAssistantMessage,
  createUserMessage,
  createBranch,
  createEmptyBranch,
  createConversation,
  createConversationWithBranches,
  createCompletedToolCall
} from '../fixtures/chatBugs';
import { createMockConversationRepo } from '../mocks/chatService';

describe('BranchManager', () => {
  let branchManager: BranchManager;
  let mockRepo: ReturnType<typeof createMockConversationRepo>;
  let mockEvents: {
    onBranchCreated: jest.Mock;
    onBranchSwitched: jest.Mock;
    onError: jest.Mock;
  };

  beforeEach(() => {
    mockRepo = createMockConversationRepo();
    mockEvents = {
      onBranchCreated: jest.fn(),
      onBranchSwitched: jest.fn(),
      onError: jest.fn()
    };
    branchManager = new BranchManager(mockRepo, mockEvents);
  });

  // ==========================================================================
  // getActiveBranch
  // ==========================================================================

  describe('getActiveBranch', () => {
    it('should return null when activeAlternativeIndex is 0 (original)', () => {
      const message = createAssistantMessage({
        branches: [createBranch()],
        activeAlternativeIndex: 0
      });

      const result = branchManager.getActiveBranch(message);
      expect(result).toBeNull();
    });

    it('should return null when message has no branches', () => {
      const message = createAssistantMessage({ branches: undefined });

      const result = branchManager.getActiveBranch(message);
      expect(result).toBeNull();
    });

    it('should return the correct branch for activeAlternativeIndex > 0', () => {
      const branch = createBranch({ id: 'branch_active' });
      const message = createAssistantMessage({
        branches: [branch],
        activeAlternativeIndex: 1
      });

      const result = branchManager.getActiveBranch(message);
      expect(result).not.toBeNull();
      expect(result!.id).toBe('branch_active');
    });

    it('should return null when activeAlternativeIndex is out of range', () => {
      const message = createAssistantMessage({
        branches: [createBranch()],
        activeAlternativeIndex: 5 // Only 1 branch, so index 5 is invalid
      });

      const result = branchManager.getActiveBranch(message);
      expect(result).toBeNull();
    });
  });

  // ==========================================================================
  // getActiveMessageContent (Bug #10 related)
  // ==========================================================================

  describe('getActiveMessageContent', () => {
    it('should return original content when no branch is active', () => {
      const message = createAssistantMessage({
        content: 'Original content',
        branches: [createBranch()],
        activeAlternativeIndex: 0
      });

      const result = branchManager.getActiveMessageContent(message);
      expect(result).toBe('Original content');
    });

    it('should return branch content when a branch is active', () => {
      const branch = createBranch({
        messages: [createAssistantMessage({ content: 'Branch content' })]
      });
      const message = createAssistantMessage({
        content: 'Original content',
        branches: [branch],
        activeAlternativeIndex: 1
      });

      const result = branchManager.getActiveMessageContent(message);
      expect(result).toBe('Branch content');
    });

    it('should return empty string when active branch has no messages', () => {
      const emptyBranch = createEmptyBranch();
      const message = createAssistantMessage({
        content: 'Original content',
        branches: [emptyBranch],
        activeAlternativeIndex: 1
      });

      const result = branchManager.getActiveMessageContent(message);
      // Bug fix: should return empty string, NOT fall through to original content
      expect(result).toBe('');
    });
  });

  // ==========================================================================
  // getActiveMessageToolCalls (Bug #10 core fix)
  // ==========================================================================

  describe('getActiveMessageToolCalls', () => {
    it('should return original tool calls when no branch is active', () => {
      const originalToolCalls = [createCompletedToolCall({ id: 'tc_original' })];
      const message = createAssistantMessage({
        toolCalls: originalToolCalls,
        branches: [createBranch()],
        activeAlternativeIndex: 0
      });

      const result = branchManager.getActiveMessageToolCalls(message);
      expect(result).toBeDefined();
      expect(result![0].id).toBe('tc_original');
    });

    it('should return branch tool calls when a branch is active', () => {
      const branchToolCalls = [createCompletedToolCall({ id: 'tc_branch' })];
      const branch = createBranch({
        messages: [createAssistantMessage({ toolCalls: branchToolCalls })]
      });
      const message = createAssistantMessage({
        toolCalls: [createCompletedToolCall({ id: 'tc_original' })],
        branches: [branch],
        activeAlternativeIndex: 1
      });

      const result = branchManager.getActiveMessageToolCalls(message);
      expect(result).toBeDefined();
      expect(result![0].id).toBe('tc_branch');
    });

    it('should return undefined (not original data) when active branch has no messages', () => {
      const emptyBranch = createEmptyBranch();
      const message = createAssistantMessage({
        toolCalls: [createCompletedToolCall({ id: 'tc_original' })],
        branches: [emptyBranch],
        activeAlternativeIndex: 1
      });

      const result = branchManager.getActiveMessageToolCalls(message);
      // Bug fix: should return undefined, NOT fall through to original tool calls
      expect(result).toBeUndefined();
    });

    it('should return undefined when message has no tool calls and no active branch', () => {
      const message = createAssistantMessage({
        toolCalls: undefined,
        activeAlternativeIndex: 0
      });

      const result = branchManager.getActiveMessageToolCalls(message);
      expect(result).toBeUndefined();
    });
  });

  // ==========================================================================
  // getActiveMessageReasoning
  // ==========================================================================

  describe('getActiveMessageReasoning', () => {
    it('should return undefined when active branch has no messages', () => {
      const emptyBranch = createEmptyBranch();
      const message = createAssistantMessage({
        reasoning: 'Original reasoning',
        branches: [emptyBranch],
        activeAlternativeIndex: 1
      });

      const result = branchManager.getActiveMessageReasoning(message);
      expect(result).toBeUndefined();
    });

    it('should return branch reasoning when active branch has messages', () => {
      const branch = createBranch({
        messages: [createAssistantMessage({ reasoning: 'Branch reasoning' })]
      });
      const message = createAssistantMessage({
        reasoning: 'Original reasoning',
        branches: [branch],
        activeAlternativeIndex: 1
      });

      const result = branchManager.getActiveMessageReasoning(message);
      expect(result).toBe('Branch reasoning');
    });
  });

  // ==========================================================================
  // createHumanBranch
  // ==========================================================================

  describe('createHumanBranch', () => {
    it('should create a branch and set activeAlternativeIndex', async () => {
      const conversation = createConversation();
      const aiMsg = conversation.messages[1];
      const altResponse = createAssistantMessage({
        id: 'alt_new',
        content: 'New alternative response'
      });

      const branchId = await branchManager.createHumanBranch(
        conversation, aiMsg.id, altResponse
      );

      expect(branchId).toBeDefined();
      expect(aiMsg.branches).toBeDefined();
      expect(aiMsg.branches!.length).toBe(1);
      expect(aiMsg.activeAlternativeIndex).toBe(1); // Points to new branch
    });

    it('should save to repository after creating branch', async () => {
      const conversation = createConversation();
      const aiMsg = conversation.messages[1];
      const altResponse = createAssistantMessage({ id: 'alt_new' });

      await branchManager.createHumanBranch(conversation, aiMsg.id, altResponse);

      expect(mockRepo.updateConversation).toHaveBeenCalledWith(
        conversation.id,
        expect.objectContaining({ messages: conversation.messages })
      );
    });

    it('should fire onBranchCreated event', async () => {
      const conversation = createConversation();
      const aiMsg = conversation.messages[1];
      const altResponse = createAssistantMessage({ id: 'alt_new' });

      const branchId = await branchManager.createHumanBranch(
        conversation, aiMsg.id, altResponse
      );

      expect(mockEvents.onBranchCreated).toHaveBeenCalledWith(aiMsg.id, branchId);
    });

    it('should return null if message is not found', async () => {
      const conversation = createConversation();
      const altResponse = createAssistantMessage({ id: 'alt_new' });

      const result = await branchManager.createHumanBranch(
        conversation, 'nonexistent', altResponse
      );

      expect(result).toBeNull();
    });
  });

  // ==========================================================================
  // switchToBranchByIndex
  // ==========================================================================

  describe('switchToBranchByIndex', () => {
    it('should switch to original when index is 0', async () => {
      const conversation = createConversationWithBranches();
      const aiMsg = conversation.messages[1];
      aiMsg.activeAlternativeIndex = 1;

      const result = await branchManager.switchToBranchByIndex(conversation, aiMsg.id, 0);

      expect(result).toBe(true);
      expect(aiMsg.activeAlternativeIndex).toBe(0);
    });

    it('should return false when branch index is out of range', async () => {
      const conversation = createConversationWithBranches();
      const aiMsg = conversation.messages[1];

      const result = await branchManager.switchToBranchByIndex(conversation, aiMsg.id, 10);

      expect(result).toBe(false);
    });

    it('should return false when message has no branches', async () => {
      const conversation = createConversation();
      const aiMsg = conversation.messages[1];

      const result = await branchManager.switchToBranchByIndex(conversation, aiMsg.id, 1);

      expect(result).toBe(false);
    });
  });

  // ==========================================================================
  // getBranchInfo
  // ==========================================================================

  describe('getBranchInfo', () => {
    it('should return correct info for message with branches', () => {
      const message = createAssistantMessage({
        branches: [createBranch({ id: 'b1' }), createBranch({ id: 'b2' })],
        activeAlternativeIndex: 1
      });

      const info = branchManager.getBranchInfo(message);

      expect(info.total).toBe(3); // 2 branches + 1 original
      expect(info.current).toBe(2); // 1-based display: index 1 => display 2
      expect(info.hasBranches).toBe(true);
      expect(info.activeBranchId).toBe('b1');
    });

    it('should return correct info for message without branches', () => {
      const message = createAssistantMessage({ branches: undefined });

      const info = branchManager.getBranchInfo(message);

      expect(info.total).toBe(1);
      expect(info.current).toBe(1);
      expect(info.hasBranches).toBe(false);
    });
  });

  // ==========================================================================
  // Navigation helpers
  // ==========================================================================

  describe('navigation', () => {
    it('getPreviousIndex should return null at index 0', () => {
      const message = createAssistantMessage({ activeAlternativeIndex: 0 });
      expect(branchManager.getPreviousIndex(message)).toBeNull();
    });

    it('getPreviousIndex should return current - 1', () => {
      const message = createAssistantMessage({
        branches: [createBranch()],
        activeAlternativeIndex: 1
      });
      expect(branchManager.getPreviousIndex(message)).toBe(0);
    });

    it('getNextIndex should return null at last index', () => {
      const message = createAssistantMessage({
        branches: [createBranch()],
        activeAlternativeIndex: 1
      });
      // total = 2 (1 branch + original), at index 1 which is last
      expect(branchManager.getNextIndex(message)).toBeNull();
    });

    it('getNextIndex should return current + 1', () => {
      const message = createAssistantMessage({
        branches: [createBranch(), createBranch({ id: 'b2' })],
        activeAlternativeIndex: 0
      });
      expect(branchManager.getNextIndex(message)).toBe(1);
    });
  });
});
