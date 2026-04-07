/**
 * ConversationManager (UI) Unit Tests
 *
 * Tests for pagination state management, search, race condition guards,
 * and error handling in the chat sidebar conversation manager.
 */

import { ConversationManager, ConversationManagerEvents } from '../../src/ui/chat/services/ConversationManager';
import { ConversationData } from '../../src/types/chat/ChatTypes';
import type { PaginatedResult } from '../../src/types/pagination/PaginationTypes';
import { App } from 'obsidian';
import {
  createConversationData,
  createConversationBatch,
  createPaginatedResult,
} from './helpers/conversationTestHelpers';

// ---------------------------------------------------------------------------
// Mock ChatService
// ---------------------------------------------------------------------------

interface MockChatService {
  listConversations: jest.Mock;
  searchConversations: jest.Mock;
  getConversation: jest.Mock;
  createConversation: jest.Mock;
  deleteConversation: jest.Mock;
  updateConversationTitle: jest.Mock;
}

function createMockChatService(defaults?: {
  page0Items?: ConversationData[];
  page1Items?: ConversationData[];
  hasPage1?: boolean;
}): MockChatService {
  const page0 = defaults?.page0Items ?? createConversationBatch(20);
  const page1 = defaults?.page1Items ?? createConversationBatch(5, 20);
  const hasPage1 = defaults?.hasPage1 ?? true;

  return {
    listConversations: jest.fn().mockImplementation(({ page }: { page?: number }) => {
      if (page === 0 || page === undefined) {
        return Promise.resolve(createPaginatedResult(page0, hasPage1, 0));
      }
      if (page === 1) {
        return Promise.resolve(createPaginatedResult(page1, false, 1));
      }
      return Promise.resolve(createPaginatedResult([], false, page ?? 0));
    }),
    searchConversations: jest.fn().mockResolvedValue([]),
    getConversation: jest.fn().mockResolvedValue(null),
    createConversation: jest.fn().mockResolvedValue({ success: true, conversationId: 'new_conv' }),
    deleteConversation: jest.fn().mockResolvedValue(true),
    updateConversationTitle: jest.fn().mockResolvedValue(true),
  };
}

function createMockEvents(): ConversationManagerEvents & {
  onConversationSelected: jest.Mock;
  onConversationsChanged: jest.Mock;
  onError: jest.Mock;
} {
  return {
    onConversationSelected: jest.fn(),
    onConversationsChanged: jest.fn(),
    onError: jest.fn(),
  };
}

// Minimal mock BranchManager — ConversationManager only passes it through
function createMockBranchManager() {
  return {} as never;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ConversationManager — Pagination & Search', () => {
  let manager: ConversationManager;
  let mockService: MockChatService;
  let events: ReturnType<typeof createMockEvents>;
  const mockApp = new App();

  beforeEach(() => {
    mockService = createMockChatService();
    events = createMockEvents();
    manager = new ConversationManager(
      mockApp,
      mockService as unknown as ConstructorParameters<typeof ConversationManager>[1],
      createMockBranchManager(),
      events
    );
  });

  // ========================================================================
  // Initial load
  // ========================================================================

  describe('loadConversations', () => {
    it('should load page 0 and populate conversations', async () => {
      await manager.loadConversations();

      expect(mockService.listConversations).toHaveBeenCalledWith({ limit: 20, page: 0 });
      expect(manager.getConversations()).toHaveLength(20);
      expect(manager.hasMore).toBe(true);
      expect(manager.isLoading).toBe(false);
      expect(manager.isSearchActive).toBe(false);
      expect(events.onConversationsChanged).toHaveBeenCalledTimes(1);
    });

    it('should auto-select first conversation when none is selected', async () => {
      const page0 = createConversationBatch(3);
      mockService.listConversations.mockResolvedValue(createPaginatedResult(page0, false, 0));
      mockService.getConversation.mockResolvedValue(page0[0]);

      await manager.loadConversations();

      expect(mockService.getConversation).toHaveBeenCalledWith(page0[0].id);
      expect(events.onConversationSelected).toHaveBeenCalled();
    });

    it('should NOT auto-select when a conversation is already selected', async () => {
      const page0 = createConversationBatch(3);
      mockService.listConversations.mockResolvedValue(createPaginatedResult(page0, false, 0));
      mockService.getConversation.mockResolvedValue(page0[1]);

      // Pre-select a conversation
      manager.setCurrentConversation(page0[1]);

      await manager.loadConversations();

      // getConversation should not be called for auto-select
      expect(mockService.getConversation).not.toHaveBeenCalled();
    });

    it('should handle empty result (no conversations)', async () => {
      mockService.listConversations.mockResolvedValue(createPaginatedResult([], false, 0, 20, 0));

      await manager.loadConversations();

      expect(manager.getConversations()).toHaveLength(0);
      expect(manager.hasMore).toBe(false);
      expect(events.onConversationsChanged).toHaveBeenCalled();
    });

    it('should call onError on failure', async () => {
      mockService.listConversations.mockRejectedValue(new Error('DB error'));

      await manager.loadConversations();

      expect(events.onError).toHaveBeenCalledWith('Failed to load conversations');
      expect(manager.isLoading).toBe(false);
    });
  });

  // ========================================================================
  // Load More
  // ========================================================================

  describe('loadMoreConversations', () => {
    it('should append next page to existing conversations', async () => {
      await manager.loadConversations();
      const countAfterPage0 = manager.getConversations().length;

      await manager.loadMoreConversations();

      expect(mockService.listConversations).toHaveBeenLastCalledWith({ limit: 20, page: 1 });
      expect(manager.getConversations().length).toBe(countAfterPage0 + 5);
      // Page 1 has no next page
      expect(manager.hasMore).toBe(false);
      expect(events.onConversationsChanged).toHaveBeenCalledTimes(2);
    });

    it('should preserve existing conversations on append', async () => {
      const page0Items = createConversationBatch(3);
      const page1Items = createConversationBatch(2, 3);
      mockService = createMockChatService({ page0Items, page1Items, hasPage1: true });
      events = createMockEvents();
      manager = new ConversationManager(
        mockApp,
        mockService as unknown as ConstructorParameters<typeof ConversationManager>[1],
        createMockBranchManager(),
        events
      );

      await manager.loadConversations();
      const page0Ids = manager.getConversations().map(c => c.id);

      await manager.loadMoreConversations();
      const allIds = manager.getConversations().map(c => c.id);

      // Page 0 items should still be present
      page0Ids.forEach(id => expect(allIds).toContain(id));
      // Page 1 items should also be present
      page1Items.forEach(item => expect(allIds).toContain(item.id));
    });

    it('should be a no-op when hasMore is false', async () => {
      mockService.listConversations.mockResolvedValue(
        createPaginatedResult(createConversationBatch(5), false, 0, 20, 5)
      );

      await manager.loadConversations();
      expect(manager.hasMore).toBe(false);

      mockService.listConversations.mockClear();
      await manager.loadMoreConversations();

      expect(mockService.listConversations).not.toHaveBeenCalled();
    });

    it('should be a no-op when search is active', async () => {
      await manager.loadConversations();

      // Activate search
      mockService.searchConversations.mockResolvedValue([
        { id: 'sr1', title: 'Result', summary: '', relevanceScore: 0, created: Date.now() - 60000, lastUpdated: Date.now() }
      ]);
      await manager.searchConversations('test');
      expect(manager.isSearchActive).toBe(true);

      mockService.listConversations.mockClear();
      await manager.loadMoreConversations();

      // Should not have called listConversations for load more
      expect(mockService.listConversations).not.toHaveBeenCalled();
    });

    it('should be a no-op when already loading (double-click guard)', async () => {
      await manager.loadConversations();

      // Create a slow response to keep isLoading=true
      let resolveSlowCall!: (value: PaginatedResult<ConversationData>) => void;
      mockService.listConversations.mockReturnValueOnce(
        new Promise<PaginatedResult<ConversationData>>(resolve => {
          resolveSlowCall = resolve;
        })
      );

      const firstCall = manager.loadMoreConversations();

      // Second call while first is in-flight
      await manager.loadMoreConversations();

      // Resolve the slow call
      resolveSlowCall(createPaginatedResult(createConversationBatch(3, 20), false, 1));
      await firstCall;

      // listConversations should only be called once for load more
      // (page 0 from loadConversations + page 1 from first loadMore)
      const page1Calls = mockService.listConversations.mock.calls.filter(
        (call: Array<{ page?: number }>) => call[0]?.page === 1
      );
      expect(page1Calls).toHaveLength(1);
    });

    it('should call onError on failure', async () => {
      await manager.loadConversations();

      mockService.listConversations.mockRejectedValue(new Error('Network error'));

      await manager.loadMoreConversations();

      expect(events.onError).toHaveBeenCalledWith('Failed to load more conversations');
      expect(manager.isLoading).toBe(false);
    });
  });

  // ========================================================================
  // Search
  // ========================================================================

  describe('searchConversations', () => {
    it('should replace paginated list with search results', async () => {
      await manager.loadConversations();
      expect(manager.getConversations().length).toBe(20);

      mockService.searchConversations.mockResolvedValue([
        { id: 'sr1', title: 'Meeting Notes', summary: '', relevanceScore: 0.8, created: Date.now() - 60000, lastUpdated: Date.now() },
        { id: 'sr2', title: 'Meeting Agenda', summary: '', relevanceScore: 0.7, created: Date.now() - 60000, lastUpdated: Date.now() },
      ]);

      await manager.searchConversations('meeting');

      expect(manager.getConversations()).toHaveLength(2);
      expect(manager.isSearchActive).toBe(true);
      expect(manager.hasMore).toBe(false); // Search results are not paginated in MVP
      expect(events.onConversationsChanged).toHaveBeenCalled();
    });

    it('should map ConversationListItem to ConversationData with empty messages', async () => {
      const lastUpdated = Date.now();
      const created = lastUpdated - 60000;
      mockService.searchConversations.mockResolvedValue([
        { id: 'sr1', title: 'Result One', summary: '', relevanceScore: 0.9, created, lastUpdated },
      ]);

      await manager.searchConversations('result');

      const results = manager.getConversations();
      expect(results[0]).toMatchObject({
        id: 'sr1',
        title: 'Result One',
        messages: [],
        created,
        updated: lastUpdated,
      });
    });

    it('should delegate to clearSearch when query is empty', async () => {
      await manager.loadConversations();

      mockService.searchConversations.mockResolvedValue([
        { id: 'sr1', title: 'Result', summary: '', relevanceScore: 0.8, created: Date.now() - 60000, lastUpdated: Date.now() },
      ]);
      await manager.searchConversations('test');
      expect(manager.isSearchActive).toBe(true);

      // Search with empty string
      await manager.searchConversations('');

      // Should have reloaded page 0 (clearSearch behavior)
      expect(manager.isSearchActive).toBe(false);
      expect(manager.getConversations().length).toBeGreaterThan(0);
    });

    it('should delegate to clearSearch when query is whitespace-only', async () => {
      await manager.loadConversations();

      mockService.searchConversations.mockResolvedValue([
        { id: 'sr1', title: 'Result', summary: '', relevanceScore: 0.8, created: Date.now() - 60000, lastUpdated: Date.now() },
      ]);
      await manager.searchConversations('test');

      await manager.searchConversations('   ');

      expect(manager.isSearchActive).toBe(false);
    });

    it('should handle zero search results', async () => {
      await manager.loadConversations();

      mockService.searchConversations.mockResolvedValue([]);
      await manager.searchConversations('nonexistent');

      expect(manager.getConversations()).toHaveLength(0);
      expect(manager.isSearchActive).toBe(true);
      expect(manager.hasMore).toBe(false);
    });

    it('should handle special characters in search query', async () => {
      mockService.searchConversations.mockResolvedValue([]);

      await manager.searchConversations('test "AND" OR NOT*');

      expect(mockService.searchConversations).toHaveBeenCalledWith('test "AND" OR NOT*');
    });

    it('should call onError on search failure', async () => {
      mockService.searchConversations.mockRejectedValue(new Error('FTS error'));

      await manager.searchConversations('failing query');

      expect(events.onError).toHaveBeenCalledWith('Failed to search conversations');
      expect(manager.isLoading).toBe(false);
    });
  });

  // ========================================================================
  // Clear Search
  // ========================================================================

  describe('clearSearch', () => {
    it('should restore paginated list at page 0', async () => {
      await manager.loadConversations();

      mockService.searchConversations.mockResolvedValue([
        { id: 'sr1', title: 'Result', summary: '', relevanceScore: 0.8, created: Date.now() - 60000, lastUpdated: Date.now() },
      ]);
      await manager.searchConversations('test');
      expect(manager.isSearchActive).toBe(true);

      await manager.clearSearch();

      expect(manager.isSearchActive).toBe(false);
      // Should have called listConversations again for page 0
      const lastCall = mockService.listConversations.mock.calls[mockService.listConversations.mock.calls.length - 1];
      expect(lastCall[0]).toMatchObject({ page: 0 });
    });

    it('should be a no-op when search is not active', async () => {
      await manager.loadConversations();
      const callCount = mockService.listConversations.mock.calls.length;

      await manager.clearSearch();

      // No additional calls
      expect(mockService.listConversations.mock.calls.length).toBe(callCount);
    });
  });

  // ========================================================================
  // Race condition guard (generation counter)
  // ========================================================================

  describe('race condition guard', () => {
    it('should discard stale load response when search starts during load', async () => {
      // Set up a slow listConversations
      let resolveSlowList!: (value: PaginatedResult<ConversationData>) => void;
      mockService.listConversations.mockReturnValueOnce(
        new Promise<PaginatedResult<ConversationData>>(resolve => {
          resolveSlowList = resolve;
        })
      );

      const loadPromise = manager.loadConversations();

      // Start search while load is still in-flight
      mockService.searchConversations.mockResolvedValue([
        { id: 'sr1', title: 'Search Result', summary: '', relevanceScore: 0.9, created: Date.now() - 60000, lastUpdated: Date.now() },
      ]);
      const searchPromise = manager.searchConversations('query');

      // Resolve the stale load
      resolveSlowList(createPaginatedResult(createConversationBatch(20), true, 0));
      await loadPromise;
      await searchPromise;

      // Search result should win — stale load response discarded
      expect(manager.getConversations()).toHaveLength(1);
      expect(manager.getConversations()[0].id).toBe('sr1');
      expect(manager.isSearchActive).toBe(true);
    });

    it('should discard stale search response when new search starts', async () => {
      let resolveSlowSearch!: (value: Array<{ id: string; title: string; summary: string; relevanceScore: number; created: number; lastUpdated: number }>) => void;
      mockService.searchConversations.mockReturnValueOnce(
        new Promise(resolve => {
          resolveSlowSearch = resolve;
        })
      );

      const search1 = manager.searchConversations('old query');

      mockService.searchConversations.mockResolvedValueOnce([
        { id: 'new1', title: 'New Result', summary: '', relevanceScore: 0.9, created: Date.now() - 60000, lastUpdated: Date.now() },
      ]);
      const search2 = manager.searchConversations('new query');

      // Resolve the old search
      resolveSlowSearch([
        { id: 'old1', title: 'Old Result', summary: '', relevanceScore: 0.5, created: Date.now() - 60000, lastUpdated: Date.now() },
      ]);
      await search1;
      await search2;

      // New search result should win
      expect(manager.getConversations()).toHaveLength(1);
      expect(manager.getConversations()[0].id).toBe('new1');
    });
  });

  // ========================================================================
  // Active conversation preserved across load-more
  // ========================================================================

  describe('active conversation preservation', () => {
    it('should preserve currentConversation across loadMore', async () => {
      const page0 = createConversationBatch(3);
      const selectedConv = page0[1];
      mockService = createMockChatService({ page0Items: page0, page1Items: createConversationBatch(2, 3), hasPage1: true });
      events = createMockEvents();
      manager = new ConversationManager(
        mockApp,
        mockService as unknown as ConstructorParameters<typeof ConversationManager>[1],
        createMockBranchManager(),
        events
      );

      await manager.loadConversations();
      // Manually set current conversation
      manager.setCurrentConversation(selectedConv);
      expect(manager.getCurrentConversation()?.id).toBe(selectedConv.id);

      await manager.loadMoreConversations();

      // Current conversation should be unchanged
      expect(manager.getCurrentConversation()?.id).toBe(selectedConv.id);
    });
  });

  // ========================================================================
  // Select conversation
  // ========================================================================

  describe('selectConversation', () => {
    it('should load full conversation and fire onConversationSelected', async () => {
      const conv = createConversationData({ id: 'c1' });
      const fullConv = createConversationData({ id: 'c1', title: 'Full Title', messages: [] });
      mockService.getConversation.mockResolvedValue(fullConv);

      await manager.selectConversation(conv);

      expect(mockService.getConversation).toHaveBeenCalledWith('c1');
      expect(events.onConversationSelected).toHaveBeenCalledWith(fullConv);
      expect(manager.getCurrentConversation()?.id).toBe('c1');
    });

    it('should set currentConversation immediately even before full load', async () => {
      const conv = createConversationData({ id: 'c1' });
      mockService.getConversation.mockResolvedValue(null);

      await manager.selectConversation(conv);

      // Should still be set (optimistic) even though full load returned null
      expect(manager.getCurrentConversation()?.id).toBe('c1');
      // onConversationSelected not called because fullConversation was null
      expect(events.onConversationSelected).not.toHaveBeenCalled();
    });

    it('should call onError on failure', async () => {
      const conv = createConversationData({ id: 'c1' });
      mockService.getConversation.mockRejectedValue(new Error('DB error'));

      await manager.selectConversation(conv);

      expect(events.onError).toHaveBeenCalledWith('Failed to load conversation');
    });
  });

  // ========================================================================
  // Delete conversation
  // ========================================================================

  describe('deleteConversation', () => {
    it('should remove conversation from local list on success', async () => {
      const items = createConversationBatch(3);
      mockService.listConversations.mockResolvedValue(createPaginatedResult(items, false, 0, 20, 3));
      await manager.loadConversations();

      const toDelete = items[1].id;
      await manager.deleteConversation(toDelete);

      expect(mockService.deleteConversation).toHaveBeenCalledWith(toDelete);
      expect(manager.getConversations().find(c => c.id === toDelete)).toBeUndefined();
      expect(manager.getConversations()).toHaveLength(2);
      expect(events.onConversationsChanged).toHaveBeenCalled();
    });

    it('should clear currentConversation when deleting the active one', async () => {
      const items = createConversationBatch(3);
      mockService.listConversations.mockResolvedValue(createPaginatedResult(items, false, 0, 20, 3));
      await manager.loadConversations();

      manager.setCurrentConversation(items[0]);
      expect(manager.getCurrentConversation()?.id).toBe(items[0].id);

      await manager.deleteConversation(items[0].id);

      expect(manager.getCurrentConversation()).toBeNull();
    });

    it('should NOT clear currentConversation when deleting a different one', async () => {
      const items = createConversationBatch(3);
      mockService.listConversations.mockResolvedValue(createPaginatedResult(items, false, 0, 20, 3));
      await manager.loadConversations();

      manager.setCurrentConversation(items[0]);
      await manager.deleteConversation(items[2].id);

      expect(manager.getCurrentConversation()?.id).toBe(items[0].id);
    });

    it('should call onError when delete fails', async () => {
      mockService.deleteConversation.mockResolvedValue(false);
      await manager.deleteConversation('missing');
      expect(events.onError).toHaveBeenCalledWith('Failed to delete conversation');
    });

    it('should call onError on exception', async () => {
      mockService.deleteConversation.mockRejectedValue(new Error('Network error'));
      await manager.deleteConversation('c1');
      expect(events.onError).toHaveBeenCalledWith('Failed to delete conversation');
    });
  });

  // ========================================================================
  // Rename conversation
  // ========================================================================

  describe('renameConversation', () => {
    it('should update title in local list and current conversation', async () => {
      const items = createConversationBatch(3);
      mockService.listConversations.mockResolvedValue(createPaginatedResult(items, false, 0, 20, 3));
      await manager.loadConversations();

      manager.setCurrentConversation(items[1]);

      await manager.renameConversation(items[1].id, 'New Title');

      expect(mockService.updateConversationTitle).toHaveBeenCalledWith(items[1].id, 'New Title');
      expect(manager.getCurrentConversation()?.title).toBe('New Title');
      expect(manager.getConversations().find(c => c.id === items[1].id)?.title).toBe('New Title');
      expect(events.onConversationsChanged).toHaveBeenCalled();
    });

    it('should update list title even when not the active conversation', async () => {
      const items = createConversationBatch(3);
      mockService.listConversations.mockResolvedValue(createPaginatedResult(items, false, 0, 20, 3));
      await manager.loadConversations();

      manager.setCurrentConversation(items[0]);
      await manager.renameConversation(items[2].id, 'Renamed');

      expect(manager.getConversations().find(c => c.id === items[2].id)?.title).toBe('Renamed');
      // Active conversation title unchanged
      expect(manager.getCurrentConversation()?.title).toBe(items[0].title);
    });

    it('should call onError when rename fails', async () => {
      mockService.updateConversationTitle.mockResolvedValue(false);
      await manager.renameConversation('c1', 'New Title');
      expect(events.onError).toHaveBeenCalledWith('Failed to rename conversation');
    });

    it('should call onError on exception', async () => {
      mockService.updateConversationTitle.mockRejectedValue(new Error('DB error'));
      await manager.renameConversation('c1', 'New Title');
      expect(events.onError).toHaveBeenCalledWith('Failed to rename conversation');
    });
  });

  // ========================================================================
  // Create new conversation
  // ========================================================================

  describe('createNewConversation', () => {
    it('should create conversation with provided title', async () => {
      const newConv = createConversationData({ id: 'new_conv', title: 'My Chat' });
      mockService.createConversation.mockResolvedValue({ success: true, conversationId: 'new_conv' });
      mockService.getConversation.mockResolvedValue(newConv);

      await manager.createNewConversation('My Chat');

      expect(mockService.createConversation).toHaveBeenCalledWith('My Chat');
      expect(mockService.getConversation).toHaveBeenCalledWith('new_conv');
    });

    it('should call onError when creation fails', async () => {
      mockService.createConversation.mockResolvedValue({ success: false, error: 'Quota exceeded' });

      await manager.createNewConversation('Title');

      expect(events.onError).toHaveBeenCalledWith('Quota exceeded');
    });

    it('should call onError on exception', async () => {
      mockService.createConversation.mockRejectedValue(new Error('Crash'));

      await manager.createNewConversation('Title');

      expect(events.onError).toHaveBeenCalledWith('Failed to create conversation');
    });
  });

  // ========================================================================
  // Create new conversation with message
  // ========================================================================

  describe('createNewConversationWithMessage', () => {
    it('should create conversation and select it (with sessionId)', async () => {
      const newConv = createConversationData({ id: 'new1' });
      mockService.createConversation.mockResolvedValue({
        success: true,
        conversationId: 'new1',
        sessionId: 'sess1',
      });
      mockService.getConversation.mockResolvedValue(newConv);

      await manager.createNewConversationWithMessage('Hello world');

      expect(mockService.createConversation).toHaveBeenCalledWith(
        'Hello world',
        'Hello world',
        expect.objectContaining({})
      );
    });

    it('should truncate long messages for the title', async () => {
      const longMsg = 'A'.repeat(60);
      mockService.createConversation.mockResolvedValue({
        success: true,
        conversationId: 'new1',
        sessionId: 'sess1',
      });
      mockService.getConversation.mockResolvedValue(createConversationData({ id: 'new1' }));

      await manager.createNewConversationWithMessage(longMsg);

      const titleArg = mockService.createConversation.mock.calls[0][0] as string;
      expect(titleArg.length).toBeLessThanOrEqual(50);
      expect(titleArg.endsWith('...')).toBe(true);
    });

    it('should handle creation without sessionId (fallback path)', async () => {
      const newConv = createConversationData({ id: 'new1' });
      mockService.createConversation.mockResolvedValue({
        success: true,
        conversationId: 'new1',
        // no sessionId
      });
      mockService.getConversation.mockResolvedValue(newConv);

      await manager.createNewConversationWithMessage('Hello');

      // Should still work via the fallback branch
      expect(mockService.getConversation).toHaveBeenCalledWith('new1');
    });

    it('should call onError when creation fails', async () => {
      mockService.createConversation.mockResolvedValue({
        success: false,
        error: 'Failed',
      });

      await manager.createNewConversationWithMessage('Hello');

      expect(events.onError).toHaveBeenCalledWith('Failed');
    });

    it('should call onError on exception', async () => {
      mockService.createConversation.mockRejectedValue(new Error('Crash'));

      await manager.createNewConversationWithMessage('Hello');

      expect(events.onError).toHaveBeenCalledWith('Failed to create conversation');
    });
  });

  // ========================================================================
  // updateCurrentConversation / setCurrentConversation
  // ========================================================================

  describe('updateCurrentConversation', () => {
    it('should update the current conversation data', () => {
      const conv = createConversationData({ id: 'c1', title: 'Original' });
      manager.updateCurrentConversation(conv);
      expect(manager.getCurrentConversation()?.title).toBe('Original');

      const updated = createConversationData({ id: 'c1', title: 'Updated' });
      manager.updateCurrentConversation(updated);
      expect(manager.getCurrentConversation()?.title).toBe('Updated');
    });
  });

  // ========================================================================
  // State getters
  // ========================================================================

  describe('state getters', () => {
    it('should report correct initial state', () => {
      expect(manager.hasMore).toBe(false);
      expect(manager.isLoading).toBe(false);
      expect(manager.isSearchActive).toBe(false);
      expect(manager.getConversations()).toHaveLength(0);
      expect(manager.getCurrentConversation()).toBeNull();
    });
  });
});
