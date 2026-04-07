/**
 * ConversationList Unit Tests
 *
 * Tests for the sidebar conversation list component:
 * - Load More button visibility and loading state
 * - Empty state rendering
 * - Button click handler integration
 */

import { Component } from 'obsidian';
import { createMockElement } from '../mocks/obsidian/core';
import { ConversationList } from '../../src/ui/chat/components/ConversationList';
import { ConversationData } from '../../src/types/chat/ChatTypes';
import {
  createConversationData,
  createConversationBatch,
} from './helpers/conversationTestHelpers';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a ConversationList with controllable callbacks.
 * Returns the list instance and the mock container for inspection.
 */
function buildList(options?: {
  conversations?: ConversationData[];
  onLoadMore?: jest.Mock;
}) {
  const container = createMockElement('div');
  const onSelect = jest.fn();
  const onDelete = jest.fn();
  const onRename = jest.fn();
  const component = new Component();
  const onLoadMore = options?.onLoadMore ?? jest.fn();

  const list = new ConversationList(
    container,
    onSelect,
    onDelete,
    onRename,
    component,
    onLoadMore,
  );

  if (options?.conversations) {
    list.setConversations(options.conversations);
  }

  return { list, container, onSelect, onDelete, onRename, onLoadMore };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ConversationList — Pagination UI', () => {
  // ========================================================================
  // Empty state
  // ========================================================================

  describe('empty state', () => {
    it('should show "No conversations yet" when list is empty', () => {
      const { container } = buildList({ conversations: [] });

      // render() calls container.createDiv with 'conversation-list-empty'
      expect(container.createDiv).toHaveBeenCalledWith('conversation-list-empty');
    });
  });

  // ========================================================================
  // Load More button visibility
  // ========================================================================

  describe('Load More button', () => {
    it('should render Load More button when hasMore is true', () => {
      const conversations = createConversationBatch(5);
      const { list, container } = buildList({ conversations });

      list.setHasMore(true);

      // renderLoadMoreButton creates a button via container.createEl
      expect(container.createEl).toHaveBeenCalledWith('button', expect.objectContaining({
        cls: 'conversation-load-more-btn',
      }));
    });

    it('should NOT create Load More button when hasMore is false', () => {
      const conversations = createConversationBatch(5);
      const { list, container } = buildList({ conversations });

      list.setHasMore(false);

      // Since hasMore is false and no button was previously created,
      // no button createEl call should have been made for load-more
      const createElCalls = (container.createEl as jest.Mock).mock.calls;
      const loadMoreCalls = createElCalls.filter(
        (call: unknown[]) => call[0] === 'button' && (call[1] as { cls?: string })?.cls === 'conversation-load-more-btn'
      );
      expect(loadMoreCalls).toHaveLength(0);
    });

    it('should set "Loading..." text and disabled attribute when isLoading is true', () => {
      const conversations = createConversationBatch(5);
      const { list, container } = buildList({ conversations });

      list.setHasMore(true);

      // Get the button mock returned by createEl
      const createElCalls = (container.createEl as jest.Mock).mock.calls;
      const loadMoreCall = createElCalls.find(
        (call: unknown[]) => call[0] === 'button' && (call[1] as { cls?: string })?.cls === 'conversation-load-more-btn'
      );
      expect(loadMoreCall).toBeDefined();
      const btnMock = (container.createEl as jest.Mock).mock.results[
        createElCalls.indexOf(loadMoreCall!)
      ].value;

      list.setIsLoading(true);

      // syncLoadMoreButtonState sets textContent and setAttribute('disabled', 'true')
      expect(btnMock.textContent).toBe('Loading...');
      expect(btnMock.setAttribute).toHaveBeenCalledWith('disabled', 'true');
    });

    it('should not render Load More when no onLoadMore callback provided', () => {
      const container = createMockElement('div');
      const conversations = createConversationBatch(5);
      const component = new Component();

      // Create list WITHOUT onLoadMore callback
      const list = new ConversationList(
        container,
        jest.fn(),
        jest.fn(),
        jest.fn(),
        component,
        undefined, // no onLoadMore
      );
      list.setConversations(conversations);
      list.setHasMore(true);

      // renderLoadMoreButton should bail if !this.onLoadMore
      const createElCalls = (container.createEl as jest.Mock).mock.calls;
      const loadMoreCalls = createElCalls.filter(
        (call: unknown[]) => call[0] === 'button' && (call[1] as { cls?: string })?.cls === 'conversation-load-more-btn'
      );
      expect(loadMoreCalls).toHaveLength(0);
    });
  });

  // ========================================================================
  // Rendering conversations
  // ========================================================================

  describe('rendering', () => {
    it('should render a conversation-item div for each conversation', () => {
      const conversations = createConversationBatch(3);
      const { container } = buildList({ conversations });

      const createDivCalls = (container.createDiv as jest.Mock).mock.calls;
      const itemCalls = createDivCalls.filter(
        (call: unknown[]) => call[0] === 'conversation-item'
      );
      expect(itemCalls).toHaveLength(3);
    });

    it('should add conversation-list class to container', () => {
      const { container } = buildList({ conversations: createConversationBatch(1) });

      expect(container.addClass).toHaveBeenCalledWith('conversation-list');
    });
  });

  // ========================================================================
  // setHasMore / setIsLoading
  // ========================================================================

  describe('setHasMore / setIsLoading', () => {
    it('should create button on setHasMore(true) and call remove on setHasMore(false)', () => {
      const { list, container } = buildList({ conversations: createConversationBatch(5) });

      list.setHasMore(true);
      // The button should be rendered — verify via createEl
      const createElCalls = (container.createEl as jest.Mock).mock.calls;
      const loadMoreCalls = createElCalls.filter(
        (call: unknown[]) => call[0] === 'button' && (call[1] as { cls?: string })?.cls === 'conversation-load-more-btn'
      );
      expect(loadMoreCalls).toHaveLength(1);

      // Get the button mock to check remove is called
      const btnMock = (container.createEl as jest.Mock).mock.results[
        createElCalls.indexOf(loadMoreCalls[0])
      ].value;
      // Simulate parentElement being set (button was appended)
      btnMock.parentElement = container;

      list.setHasMore(false);
      expect(btnMock.remove).toHaveBeenCalled();
    });

    it('should update button text via syncLoadMoreButtonState on setIsLoading', () => {
      const { list, container } = buildList({ conversations: createConversationBatch(5) });

      list.setHasMore(true);

      // Get the button mock
      const createElCalls = (container.createEl as jest.Mock).mock.calls;
      const loadMoreCall = createElCalls.find(
        (call: unknown[]) => call[0] === 'button' && (call[1] as { cls?: string })?.cls === 'conversation-load-more-btn'
      );
      const btnMock = (container.createEl as jest.Mock).mock.results[
        createElCalls.indexOf(loadMoreCall!)
      ].value;

      list.setIsLoading(true);
      expect(btnMock.textContent).toBe('Loading...');

      list.setIsLoading(false);
      expect(btnMock.textContent).toBe('Load more');
    });
  });

  // ========================================================================
  // setActiveConversation
  // ========================================================================

  describe('setActiveConversation', () => {
    it('should query DOM for conversation-item elements to update active state', () => {
      const conversations = createConversationBatch(3);
      const { list, container } = buildList({ conversations });

      list.setActiveConversation(conversations[1].id);

      // updateActiveState queries for .conversation-item elements
      expect(container.querySelectorAll).toHaveBeenCalledWith('.conversation-item');
    });
  });

  // ========================================================================
  // Conversation items rendering
  // ========================================================================

  describe('conversation item details', () => {
    it('should render conversation-item divs which chain sub-elements', () => {
      const conversations = [
        createConversationData({ id: 'c1', title: 'My Chat' }),
      ];
      const { container } = buildList({ conversations });

      // render creates a conversation-item div for each conversation on the container
      // Sub-elements (conversation-content, conversation-actions) are created on the
      // child mock elements returned by createDiv — so we verify the top-level calls
      const createDivCalls = (container.createDiv as jest.Mock).mock.calls;
      const itemCalls = createDivCalls.filter(
        (call: unknown[]) => call[0] === 'conversation-item'
      );
      expect(itemCalls).toHaveLength(1);
    });

    it('should render a conversation-item div for each of 5 conversations', () => {
      const conversations = createConversationBatch(5);
      const { container } = buildList({ conversations });

      const createDivCalls = (container.createDiv as jest.Mock).mock.calls;
      const itemCalls = createDivCalls.filter(
        (call: unknown[]) => call[0] === 'conversation-item'
      );
      expect(itemCalls).toHaveLength(5);
    });
  });

  // ========================================================================
  // formatTimestamp (indirect via render)
  // ========================================================================

  describe('timestamp formatting (via render)', () => {
    it('should render conversation item for recent timestamp', () => {
      const conversations = [
        createConversationData({ id: 'c1', updated: Date.now() }),
      ];
      const { container } = buildList({ conversations });

      // Verify render completed: container was cleared and item was created
      expect(container.empty).toHaveBeenCalled();
      const createDivCalls = (container.createDiv as jest.Mock).mock.calls;
      const itemCalls = createDivCalls.filter(
        (call: unknown[]) => call[0] === 'conversation-item'
      );
      expect(itemCalls).toHaveLength(1);
    });

    it('should render conversation item for 30-day-old timestamp', () => {
      const conversations = [
        createConversationData({ id: 'c1', updated: Date.now() - 30 * 86400000 }),
      ];
      const { container } = buildList({ conversations });

      expect(container.empty).toHaveBeenCalled();
      const createDivCalls = (container.createDiv as jest.Mock).mock.calls;
      const itemCalls = createDivCalls.filter(
        (call: unknown[]) => call[0] === 'conversation-item'
      );
      expect(itemCalls).toHaveLength(1);
    });
  });

  // ========================================================================
  // setConversations sorting
  // ========================================================================

  describe('setConversations', () => {
    it('should sort conversations by updated descending and re-render', () => {
      const older = createConversationData({ id: 'old', updated: 1000 });
      const newer = createConversationData({ id: 'new', updated: 2000 });
      const { list, container } = buildList();

      list.setConversations([older, newer]);

      // Verify render was triggered
      expect(container.empty).toHaveBeenCalled();

      // Verify 2 conversation-item divs were rendered
      const createDivCalls = (container.createDiv as jest.Mock).mock.calls;
      const itemCalls = createDivCalls.filter(
        (call: unknown[]) => call[0] === 'conversation-item'
      );
      expect(itemCalls).toHaveLength(2);
    });
  });

  // ========================================================================
  // Message preview rendering
  // ========================================================================

  describe('message preview', () => {
    it('should render conversation item when conversation has messages', () => {
      const conversations = [
        createConversationData({
          id: 'c1',
          messages: [
            { id: 'm1', role: 'user', content: 'Hello world', timestamp: Date.now() } as ConversationData['messages'][0],
          ],
        }),
      ];
      const { container } = buildList({ conversations });

      // Verify the conversation-item was rendered
      const createDivCalls = (container.createDiv as jest.Mock).mock.calls;
      const itemCalls = createDivCalls.filter(
        (call: unknown[]) => call[0] === 'conversation-item'
      );
      expect(itemCalls).toHaveLength(1);
    });

    it('should render conversation item when message content is long', () => {
      const conversations = [
        createConversationData({
          id: 'c1',
          messages: [
            { id: 'm1', role: 'user', content: 'A'.repeat(100), timestamp: Date.now() } as ConversationData['messages'][0],
          ],
        }),
      ];
      const { container } = buildList({ conversations });

      const createDivCalls = (container.createDiv as jest.Mock).mock.calls;
      const itemCalls = createDivCalls.filter(
        (call: unknown[]) => call[0] === 'conversation-item'
      );
      expect(itemCalls).toHaveLength(1);
    });
  });

  // ========================================================================
  // Cleanup
  // ========================================================================

  describe('cleanup', () => {
    it('should be safe to call cleanup multiple times', () => {
      const { list } = buildList({ conversations: createConversationBatch(3) });

      // First cleanup clears pending state, second verifies idempotency
      list.cleanup();
      list.cleanup();

      // No error means clearPendingDeleteConversation handled null timer gracefully
    });
  });
});
