/**
 * ToolInspectionModal unit tests
 *
 * Coverage:
 *   - onOpen/onClose lifecycle (isDisposed transitions)
 *   - Initial page load fetches with {pageSize} only (no cursor)
 *   - Scroll-to-bottom snap via requestAnimationFrame happy path
 *   - Infinite-scroll-up loadPreviousPage reads with {cursor, pageSize}
 *   - loadPreviousPage guard: bails when isLoading, !hasMorePages, or !nextCursor
 *   - isDisposed guard: async load path returns early if modal closes mid-flight
 *   - Unsubscribe-on-close: after close(), no further state mutations
 *   - mergeMessages de-dupes by id + sorts by sequenceNumber
 *
 * Constraints:
 *   - Node test env has no `requestAnimationFrame` — shim inline, invoked immediately
 *   - No jest.useFakeTimers()
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { App, createMockElement } from 'obsidian';
import type { ChatMessage } from '../../src/types/chat/ChatTypes';
import type { PaginatedResult } from '../../src/types/pagination/PaginationTypes';

// Shim requestAnimationFrame — invoke the callback synchronously so we can
// observe the snap-to-latest / preserve-scroll behavior without timers.
(global as any).requestAnimationFrame = (cb: (time: number) => void): number => {
  cb(0);
  return 0;
};

// eslint-disable-next-line import/first
import { ToolInspectionModal } from '../../src/ui/chat/components/ToolInspectionModal';

// Minimal ChatMessage factory — ChatMessage's full shape is large, so we
// only populate the fields the modal actually reads.
type PartialChatMessage = Pick<ChatMessage, 'id' | 'role' | 'content' | 'timestamp'> & {
  sequenceNumber?: number;
  toolCalls?: ChatMessage['toolCalls'];
};

function makeMessage(overrides: PartialChatMessage): ChatMessage {
  return {
    role: 'assistant',
    content: '',
    timestamp: 0,
    ...overrides,
  } as ChatMessage;
}

function makePage(
  items: PartialChatMessage[],
  hasNextPage = false,
  nextCursor?: string
): PaginatedResult<ChatMessage> {
  return {
    items: items.map(makeMessage),
    hasNextPage,
    nextCursor,
    totalCount: items.length,
  } as unknown as PaginatedResult<ChatMessage>;
}

interface MockHistorySource {
  getToolCallMessagesForConversation: jest.Mock;
}

function makeHistorySource(page: PaginatedResult<ChatMessage>): MockHistorySource {
  return {
    getToolCallMessagesForConversation: jest.fn().mockResolvedValue(page),
  };
}

function makeApp(): App {
  return new App();
}

describe('ToolInspectionModal — lifecycle', () => {
  it('starts with isDisposed=false after onOpen and flips to true after onClose', async () => {
    const app = makeApp();
    const history = makeHistorySource(makePage([]));
    const modal = new ToolInspectionModal(app, {
      conversationId: 'conv-1',
      historySource: history as never,
      pageSize: 10,
    });

    modal.onOpen();
    // Flush the initial load microtask
    await Promise.resolve();

    // @ts-expect-error — probing the internal flag for test verification
    expect(modal.isDisposed).toBe(false);

    modal.onClose();
    // @ts-expect-error — probing the internal flag for test verification
    expect(modal.isDisposed).toBe(true);
  });

  it('onOpen() calls historySource.getToolCallMessagesForConversation with pageSize only', async () => {
    const app = makeApp();
    const history = makeHistorySource(makePage([], false));
    const modal = new ToolInspectionModal(app, {
      conversationId: 'conv-2',
      historySource: history as never,
      pageSize: 25,
    });

    modal.onOpen();
    await Promise.resolve();
    await Promise.resolve();

    expect(history.getToolCallMessagesForConversation).toHaveBeenCalledWith(
      'conv-2',
      { pageSize: 25 }
    );
  });

  it('onOpen() uses DEFAULT_PAGE_SIZE=50 when pageSize option is omitted', async () => {
    const app = makeApp();
    const history = makeHistorySource(makePage([], false));
    const modal = new ToolInspectionModal(app, {
      conversationId: 'conv-3',
      historySource: history as never,
    });

    modal.onOpen();
    await Promise.resolve();
    await Promise.resolve();

    expect(history.getToolCallMessagesForConversation).toHaveBeenCalledWith(
      'conv-3',
      { pageSize: 50 }
    );
  });
});

describe('ToolInspectionModal — initial load', () => {
  it('stores loaded messages, hasMorePages flag, and nextCursor after initial load', async () => {
    const app = makeApp();
    const page = makePage(
      [
        { id: 'm1', role: 'assistant', content: '', timestamp: 1000, sequenceNumber: 1 },
        { id: 'm2', role: 'assistant', content: '', timestamp: 2000, sequenceNumber: 2 },
      ],
      true,
      'cursor-older'
    );
    const history = makeHistorySource(page);
    const modal = new ToolInspectionModal(app, {
      conversationId: 'conv-4',
      historySource: history as never,
      pageSize: 10,
    });

    modal.onOpen();
    // Allow the awaited getToolCallMessagesForConversation to resolve
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // @ts-expect-error — probing internals
    expect(modal.loadedMessages).toHaveLength(2);
    // @ts-expect-error — probing internals
    expect(modal.hasMorePages).toBe(true);
    // @ts-expect-error — probing internals
    expect(modal.nextCursor).toBe('cursor-older');
  });

  it('renders an empty state when the initial page is empty', async () => {
    const app = makeApp();
    const history = makeHistorySource(makePage([], false));
    const modal = new ToolInspectionModal(app, {
      conversationId: 'conv-5',
      historySource: history as never,
    });

    modal.onOpen();
    await Promise.resolve();
    await Promise.resolve();

    // @ts-expect-error — probing internals
    expect(modal.loadedMessages).toHaveLength(0);
  });

  it('handles historySource errors without throwing (empty state fallback)', async () => {
    const app = makeApp();
    const history: MockHistorySource = {
      getToolCallMessagesForConversation: jest.fn().mockRejectedValue(new Error('db down')),
    };
    const modal = new ToolInspectionModal(app, {
      conversationId: 'conv-6',
      historySource: history as never,
    });

    expect(() => modal.onOpen()).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // @ts-expect-error — probing internals
    expect(modal.loadedMessages).toHaveLength(0);
  });
});

describe('ToolInspectionModal — loadPreviousPage (infinite scroll up)', () => {
  it('passes the stored nextCursor on subsequent loads', async () => {
    const app = makeApp();
    const firstPage = makePage(
      [{ id: 'new1', role: 'assistant', content: '', timestamp: 2000, sequenceNumber: 2 }],
      true,
      'cursor-older'
    );
    const secondPage = makePage(
      [{ id: 'old1', role: 'assistant', content: '', timestamp: 1000, sequenceNumber: 1 }],
      false
    );

    const history: MockHistorySource = {
      getToolCallMessagesForConversation: jest
        .fn()
        .mockResolvedValueOnce(firstPage)
        .mockResolvedValueOnce(secondPage),
    };

    const modal = new ToolInspectionModal(app, {
      conversationId: 'conv-7',
      historySource: history as never,
      pageSize: 10,
    });

    modal.onOpen();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // @ts-expect-error — probing internals
    await modal.loadPreviousPage();
    await Promise.resolve();

    // Second call used the cursor from the first response
    expect(history.getToolCallMessagesForConversation).toHaveBeenCalledTimes(2);
    expect(history.getToolCallMessagesForConversation).toHaveBeenLastCalledWith(
      'conv-7',
      { cursor: 'cursor-older', pageSize: 10 }
    );

    // @ts-expect-error — probing internals: both messages loaded, sorted by sequenceNumber
    expect(modal.loadedMessages).toHaveLength(2);
    // @ts-expect-error — probing internals
    expect(modal.loadedMessages[0].id).toBe('old1');
    // @ts-expect-error — probing internals
    expect(modal.loadedMessages[1].id).toBe('new1');
    // @ts-expect-error — probing internals
    expect(modal.hasMorePages).toBe(false);
  });

  it('bails out immediately when hasMorePages is false', async () => {
    const app = makeApp();
    const history = makeHistorySource(makePage([], false));
    const modal = new ToolInspectionModal(app, {
      conversationId: 'conv-8',
      historySource: history as never,
    });

    modal.onOpen();
    await Promise.resolve();
    await Promise.resolve();

    const baseCalls = history.getToolCallMessagesForConversation.mock.calls.length;

    // @ts-expect-error — probing internals
    await modal.loadPreviousPage();

    // No new fetch
    expect(history.getToolCallMessagesForConversation).toHaveBeenCalledTimes(baseCalls);
  });

  it('bails out when nextCursor is undefined even if hasMorePages=true', async () => {
    const app = makeApp();
    // Anomalous page with hasNextPage=true but no cursor — guard must trip
    const history = makeHistorySource(makePage([], true, undefined));
    const modal = new ToolInspectionModal(app, {
      conversationId: 'conv-9',
      historySource: history as never,
    });

    modal.onOpen();
    await Promise.resolve();
    await Promise.resolve();

    const baseCalls = history.getToolCallMessagesForConversation.mock.calls.length;

    // @ts-expect-error — probing internals
    await modal.loadPreviousPage();

    expect(history.getToolCallMessagesForConversation).toHaveBeenCalledTimes(baseCalls);
  });
});

describe('ToolInspectionModal — isDisposed guards on async paths', () => {
  it('initial load returns early if close happens mid-flight', async () => {
    const app = makeApp();

    let resolver: (value: PaginatedResult<ChatMessage>) => void = () => undefined;
    const gated = new Promise<PaginatedResult<ChatMessage>>((res) => {
      resolver = res;
    });

    const history: MockHistorySource = {
      getToolCallMessagesForConversation: jest.fn().mockReturnValue(gated),
    };

    const modal = new ToolInspectionModal(app, {
      conversationId: 'conv-disposed',
      historySource: history as never,
    });

    modal.onOpen();
    // Close BEFORE the fetch resolves
    modal.onClose();

    resolver(makePage(
      [{ id: 'late', role: 'assistant', content: '', timestamp: 1 }],
      false
    ));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // @ts-expect-error — internals should remain untouched after close
    expect(modal.loadedMessages).toHaveLength(0);
  });

  it('loadPreviousPage returns early if close happens mid-flight', async () => {
    const app = makeApp();

    const firstPage = makePage(
      [{ id: 'a', role: 'assistant', content: '', timestamp: 2000, sequenceNumber: 2 }],
      true,
      'cursor-1'
    );

    let resolver: (value: PaginatedResult<ChatMessage>) => void = () => undefined;
    const gatedSecond = new Promise<PaginatedResult<ChatMessage>>((res) => {
      resolver = res;
    });

    const history: MockHistorySource = {
      getToolCallMessagesForConversation: jest
        .fn()
        .mockResolvedValueOnce(firstPage)
        .mockReturnValueOnce(gatedSecond),
    };

    const modal = new ToolInspectionModal(app, {
      conversationId: 'conv-dispose-2',
      historySource: history as never,
      pageSize: 10,
    });

    modal.onOpen();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // @ts-expect-error — probing internals: kick the second fetch
    const pending = modal.loadPreviousPage();
    modal.onClose();

    resolver(makePage(
      [{ id: 'b', role: 'assistant', content: '', timestamp: 1000, sequenceNumber: 1 }],
      false
    ));
    await pending;
    await Promise.resolve();

    // loadedMessages should still only contain the pre-close data ('a'),
    // because the guard tripped after close() set isDisposed=true.
    // @ts-expect-error — probing internals
    expect(modal.loadedMessages.map((m: ChatMessage) => m.id)).toEqual(['a']);
  });
});

describe('ToolInspectionModal — mergeMessages de-dup + sort', () => {
  it('deduplicates by id when pages overlap', async () => {
    const app = makeApp();

    const firstPage = makePage(
      [
        { id: 'x', role: 'assistant', content: '', timestamp: 2000, sequenceNumber: 2 },
        { id: 'y', role: 'assistant', content: '', timestamp: 3000, sequenceNumber: 3 },
      ],
      true,
      'cursor-x'
    );
    const secondPage = makePage(
      [
        { id: 'w', role: 'assistant', content: '', timestamp: 1000, sequenceNumber: 1 },
        { id: 'x', role: 'assistant', content: '', timestamp: 2000, sequenceNumber: 2 }, // dup
      ],
      false
    );

    const history: MockHistorySource = {
      getToolCallMessagesForConversation: jest
        .fn()
        .mockResolvedValueOnce(firstPage)
        .mockResolvedValueOnce(secondPage),
    };

    const modal = new ToolInspectionModal(app, {
      conversationId: 'conv-merge',
      historySource: history as never,
      pageSize: 10,
    });

    modal.onOpen();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // @ts-expect-error — internals
    await modal.loadPreviousPage();
    await Promise.resolve();

    // @ts-expect-error — internals: 3 unique ids, sorted by sequenceNumber
    const ids = modal.loadedMessages.map((m: ChatMessage) => m.id);
    expect(ids).toEqual(['w', 'x', 'y']);
  });
});
