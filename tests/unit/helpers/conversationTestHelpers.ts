/**
 * Shared test factories for conversation-related tests.
 *
 * Used by ConversationManager.test.ts and ConversationList.test.ts
 * to avoid duplicating factory functions across test files.
 */

import { ConversationData } from '../../../src/types/chat/ChatTypes';
import type { PaginatedResult } from '../../../src/types/pagination/PaginationTypes';

/**
 * Create a single ConversationData object with sensible defaults.
 */
export function createConversationData(overrides: Partial<ConversationData> = {}): ConversationData {
  const id = overrides.id ?? `conv_${Math.random().toString(36).slice(2, 8)}`;
  return {
    id,
    title: overrides.title ?? `Conversation ${id}`,
    messages: overrides.messages ?? [],
    created: overrides.created ?? Date.now(),
    updated: overrides.updated ?? Date.now(),
    ...overrides,
  };
}

/**
 * Create a batch of ConversationData items with sequential IDs.
 * @param count Number of conversations to create
 * @param startIndex Offset for sequential IDs (default 0)
 */
export function createConversationBatch(count: number, startIndex = 0): ConversationData[] {
  return Array.from({ length: count }, (_, i) =>
    createConversationData({
      id: `conv_${startIndex + i}`,
      title: `Conversation ${startIndex + i}`,
      created: Date.now() - (startIndex + i) * 1000,
      updated: Date.now() - (startIndex + i) * 1000,
    })
  );
}

/**
 * Create a PaginatedResult wrapping conversation items.
 */
export function createPaginatedResult(
  items: ConversationData[],
  hasNextPage: boolean,
  page = 0,
  pageSize = 20,
  totalItems?: number
): PaginatedResult<ConversationData> {
  const total = totalItems ?? (hasNextPage ? (page + 2) * pageSize : (page * pageSize) + items.length);
  return {
    items,
    page,
    pageSize,
    totalItems: total,
    totalPages: Math.ceil(total / pageSize),
    hasNextPage,
    hasPreviousPage: page > 0,
  };
}
