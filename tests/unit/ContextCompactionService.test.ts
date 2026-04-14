/**
 * ContextCompactionService unit tests
 *
 * Coverage:
 *   - compact() non-mutation guarantee: original conversation.messages stays intact
 *   - boundaryMessageId = first message in the "kept" window
 *   - messagesRemoved / messagesKept counts
 *   - Atomic unit identification (user, assistant+tool, system, standalone tool)
 *   - Summary extraction from removed messages
 *   - File reference extraction (wikilinks + file paths)
 *   - Topic extraction from user messages
 *   - Empty conversation → zero counts
 *   - Too few messages to compact → zero removal
 *   - shouldCompactByMessageCount threshold
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import type { ConversationData, ConversationMessage } from '../../src/types/chat/ChatTypes';
import { ContextCompactionService } from '../../src/services/chat/ContextCompactionService';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMsg(
  overrides: Partial<ConversationMessage> & { id: string; role: ConversationMessage['role'] }
): ConversationMessage {
  return {
    content: '',
    timestamp: Date.now(),
    conversationId: 'conv-test',
    ...overrides,
  } as ConversationMessage;
}

function makeConversation(messages: ConversationMessage[], id = 'conv-test'): ConversationData {
  return {
    id,
    title: 'Test Conversation',
    messages,
    created: Date.now(),
    updated: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ContextCompactionService — compact() non-mutation', () => {
  let svc: ContextCompactionService;

  beforeEach(() => {
    svc = new ContextCompactionService();
  });

  it('does NOT mutate conversation.messages — original array stays intact', () => {
    const msgs = [
      makeMsg({ id: 'u1', role: 'user', content: 'Hello' }),
      makeMsg({ id: 'a1', role: 'assistant', content: 'Hi there' }),
      makeMsg({ id: 'u2', role: 'user', content: 'Question' }),
      makeMsg({ id: 'a2', role: 'assistant', content: 'Answer' }),
      makeMsg({ id: 'u3', role: 'user', content: 'Follow-up' }),
      makeMsg({ id: 'a3', role: 'assistant', content: 'Sure thing' }),
    ];
    const conv = makeConversation(msgs);

    // Snapshot the original array reference and length
    const originalMessages = conv.messages;
    const originalLength = conv.messages.length;
    const originalIds = conv.messages.map(m => m.id);

    const result = svc.compact(conv, { exchangesToKeep: 2 });

    // Non-mutation guarantee: same array reference, same length, same IDs
    expect(conv.messages).toBe(originalMessages);
    expect(conv.messages.length).toBe(originalLength);
    expect(conv.messages.map(m => m.id)).toEqual(originalIds);

    // But compaction did happen — messages were conceptually removed
    expect(result.messagesRemoved).toBeGreaterThan(0);
  });

  it('returns boundaryMessageId = first kept message ID', () => {
    const msgs = [
      makeMsg({ id: 'u1', role: 'user', content: 'First question' }),
      makeMsg({ id: 'a1', role: 'assistant', content: 'First answer' }),
      makeMsg({ id: 'u2', role: 'user', content: 'Second question' }),
      makeMsg({ id: 'a2', role: 'assistant', content: 'Second answer' }),
      makeMsg({ id: 'u3', role: 'user', content: 'Third question' }),
      makeMsg({ id: 'a3', role: 'assistant', content: 'Third answer' }),
    ];
    const conv = makeConversation(msgs);

    const result = svc.compact(conv, { exchangesToKeep: 2 });

    // With 6 messages (3 exchanges) and exchangesToKeep=2, the first exchange
    // is removed. The boundary should be the first message of the kept window.
    expect(result.boundaryMessageId).toBe('u2');
  });

  it('returns correct messagesRemoved and messagesKept counts', () => {
    const msgs = [
      makeMsg({ id: 'u1', role: 'user', content: 'Q1' }),
      makeMsg({ id: 'a1', role: 'assistant', content: 'A1' }),
      makeMsg({ id: 'u2', role: 'user', content: 'Q2' }),
      makeMsg({ id: 'a2', role: 'assistant', content: 'A2' }),
      makeMsg({ id: 'u3', role: 'user', content: 'Q3' }),
      makeMsg({ id: 'a3', role: 'assistant', content: 'A3' }),
    ];
    const conv = makeConversation(msgs);

    const result = svc.compact(conv, { exchangesToKeep: 2 });

    expect(result.messagesRemoved).toBe(2); // u1, a1
    expect(result.messagesKept).toBe(4);   // u2, a2, u3, a3
    expect(result.messagesRemoved + result.messagesKept).toBe(msgs.length);
  });
});

describe('ContextCompactionService — empty / too-few messages', () => {
  let svc: ContextCompactionService;

  beforeEach(() => {
    svc = new ContextCompactionService();
  });

  it('returns zero counts for empty conversation', () => {
    const conv = makeConversation([]);

    const result = svc.compact(conv);

    expect(result.messagesRemoved).toBe(0);
    expect(result.messagesKept).toBe(0);
    expect(result.summary).toBe('');
    expect(result.boundaryMessageId).toBeUndefined();
  });

  it('returns zero removal when message count <= exchangesToKeep * 2', () => {
    const msgs = [
      makeMsg({ id: 'u1', role: 'user', content: 'Hello' }),
      makeMsg({ id: 'a1', role: 'assistant', content: 'Hi' }),
    ];
    const conv = makeConversation(msgs);

    // Default exchangesToKeep=2 → keeps 4 units, only 2 present → no removal
    const result = svc.compact(conv);

    expect(result.messagesRemoved).toBe(0);
    expect(result.messagesKept).toBe(2);
    expect(result.boundaryMessageId).toBeUndefined();
  });
});

describe('ContextCompactionService — atomic unit identification', () => {
  let svc: ContextCompactionService;

  beforeEach(() => {
    svc = new ContextCompactionService();
  });

  it('groups assistant + tool messages as a single atomic unit', () => {
    const msgs = [
      makeMsg({ id: 'u1', role: 'user', content: 'Search for files' }),
      makeMsg({
        id: 'a1',
        role: 'assistant',
        content: 'Searching...',
        toolCalls: [{ id: 'tc1', type: 'function', function: { name: 'search', arguments: '{}' } }],
      }),
      makeMsg({ id: 't1', role: 'tool', content: 'Found 3 files' }),
      makeMsg({ id: 't2', role: 'tool', content: 'Additional result' }),
      makeMsg({ id: 'u2', role: 'user', content: 'Thanks' }),
      makeMsg({ id: 'a2', role: 'assistant', content: 'You are welcome' }),
      makeMsg({ id: 'u3', role: 'user', content: 'Another question' }),
      makeMsg({ id: 'a3', role: 'assistant', content: 'Another answer' }),
    ];
    const conv = makeConversation(msgs);

    // 4 atomic units: [u1], [a1+t1+t2], [u2], [a2], [u3], [a3] → 6 units
    // exchangesToKeep=2 → keep 4 units → remove 2 units → [u1] + [a1+t1+t2] = 4 messages
    const result = svc.compact(conv, { exchangesToKeep: 2 });

    expect(result.messagesRemoved).toBe(4); // u1, a1, t1, t2
    expect(result.messagesKept).toBe(4);    // u2, a2, u3, a3
    expect(result.boundaryMessageId).toBe('u2');
  });

  it('handles system messages as separate atomic units', () => {
    const msgs = [
      makeMsg({ id: 's1', role: 'system', content: 'System message' }),
      makeMsg({ id: 'u1', role: 'user', content: 'Hello' }),
      makeMsg({ id: 'a1', role: 'assistant', content: 'Hi' }),
      makeMsg({ id: 'u2', role: 'user', content: 'Next' }),
      makeMsg({ id: 'a2', role: 'assistant', content: 'Sure' }),
      makeMsg({ id: 'u3', role: 'user', content: 'More' }),
      makeMsg({ id: 'a3', role: 'assistant', content: 'Done' }),
    ];
    const conv = makeConversation(msgs);

    // 7 units: [s1], [u1], [a1], [u2], [a2], [u3], [a3]
    // exchangesToKeep=2 → keep 4 → remove 3 → s1, u1, a1
    const result = svc.compact(conv, { exchangesToKeep: 2 });

    expect(result.messagesRemoved).toBe(3);
    expect(result.messagesKept).toBe(4);
  });

  it('handles standalone tool messages as individual units', () => {
    const msgs = [
      makeMsg({ id: 't1', role: 'tool', content: 'Standalone tool result' }),
      makeMsg({ id: 'u1', role: 'user', content: 'What happened?' }),
      makeMsg({ id: 'a1', role: 'assistant', content: 'A tool ran' }),
      makeMsg({ id: 'u2', role: 'user', content: 'OK' }),
      makeMsg({ id: 'a2', role: 'assistant', content: 'Done' }),
    ];
    const conv = makeConversation(msgs);

    // 5 units, exchangesToKeep=1 → keep 2 → remove 3
    const result = svc.compact(conv, { exchangesToKeep: 1 });

    expect(result.messagesRemoved).toBe(3); // t1, u1, a1
    expect(result.messagesKept).toBe(2);    // u2, a2
  });
});

describe('ContextCompactionService — summary extraction', () => {
  let svc: ContextCompactionService;

  beforeEach(() => {
    svc = new ContextCompactionService();
  });

  it('includes initial user request in summary', () => {
    const msgs = [
      makeMsg({ id: 'u1', role: 'user', content: 'Help me refactor this module' }),
      makeMsg({ id: 'a1', role: 'assistant', content: 'OK I will help' }),
      makeMsg({ id: 'u2', role: 'user', content: 'Next step' }),
      makeMsg({ id: 'a2', role: 'assistant', content: 'Done' }),
      makeMsg({ id: 'u3', role: 'user', content: 'Final' }),
      makeMsg({ id: 'a3', role: 'assistant', content: 'Complete' }),
    ];
    const conv = makeConversation(msgs);

    const result = svc.compact(conv, { exchangesToKeep: 2 });

    expect(result.summary).toContain('Help me refactor this module');
  });

  it('includes tool names in summary when assistant uses tools', () => {
    const msgs = [
      makeMsg({ id: 'u1', role: 'user', content: 'Search for notes' }),
      makeMsg({
        id: 'a1',
        role: 'assistant',
        content: 'Searching...',
        toolCalls: [
          { id: 'tc1', type: 'function', function: { name: 'searchContent', arguments: '{}' }, name: 'searchContent' },
        ],
      }),
      makeMsg({ id: 'u2', role: 'user', content: 'Good' }),
      makeMsg({ id: 'a2', role: 'assistant', content: 'Found them' }),
      makeMsg({ id: 'u3', role: 'user', content: 'More' }),
      makeMsg({ id: 'a3', role: 'assistant', content: 'Done' }),
    ];
    const conv = makeConversation(msgs);

    const result = svc.compact(conv, { exchangesToKeep: 2 });

    expect(result.summary).toContain('searchContent');
  });

  it('respects maxSummaryLength option', () => {
    const msgs = [
      makeMsg({ id: 'u1', role: 'user', content: 'A'.repeat(300) }),
      makeMsg({ id: 'a1', role: 'assistant', content: 'B'.repeat(300) }),
      makeMsg({ id: 'u2', role: 'user', content: 'Short' }),
      makeMsg({ id: 'a2', role: 'assistant', content: 'Done' }),
      makeMsg({ id: 'u3', role: 'user', content: 'End' }),
      makeMsg({ id: 'a3', role: 'assistant', content: 'Fin' }),
    ];
    const conv = makeConversation(msgs);

    const result = svc.compact(conv, { exchangesToKeep: 2, maxSummaryLength: 100 });

    expect(result.summary.length).toBeLessThanOrEqual(100);
  });
});

describe('ContextCompactionService — file references', () => {
  let svc: ContextCompactionService;

  beforeEach(() => {
    svc = new ContextCompactionService();
  });

  it('extracts wikilinks from removed messages', () => {
    const msgs = [
      makeMsg({ id: 'u1', role: 'user', content: 'Look at [[My Note]] and [[Other Note|alias]]' }),
      makeMsg({ id: 'a1', role: 'assistant', content: 'Done' }),
      makeMsg({ id: 'u2', role: 'user', content: 'Next' }),
      makeMsg({ id: 'a2', role: 'assistant', content: 'OK' }),
      makeMsg({ id: 'u3', role: 'user', content: 'More' }),
      makeMsg({ id: 'a3', role: 'assistant', content: 'End' }),
    ];
    const conv = makeConversation(msgs);

    const result = svc.compact(conv, { exchangesToKeep: 2 });

    expect(result.filesReferenced).toContain('My Note');
    expect(result.filesReferenced).toContain('Other Note');
  });

  it('extracts file paths from removed messages', () => {
    const msgs = [
      makeMsg({ id: 'u1', role: 'user', content: 'Check src/main.ts and notes/test.md' }),
      makeMsg({ id: 'a1', role: 'assistant', content: 'Checked' }),
      makeMsg({ id: 'u2', role: 'user', content: 'Next' }),
      makeMsg({ id: 'a2', role: 'assistant', content: 'OK' }),
      makeMsg({ id: 'u3', role: 'user', content: 'More' }),
      makeMsg({ id: 'a3', role: 'assistant', content: 'End' }),
    ];
    const conv = makeConversation(msgs);

    const result = svc.compact(conv, { exchangesToKeep: 2 });

    expect(result.filesReferenced.some(f => f.includes('main.ts'))).toBe(true);
    expect(result.filesReferenced.some(f => f.includes('test.md'))).toBe(true);
  });

  it('skips file references when includeFileReferences=false', () => {
    const msgs = [
      makeMsg({ id: 'u1', role: 'user', content: 'Look at [[SomeNote]]' }),
      makeMsg({ id: 'a1', role: 'assistant', content: 'Done' }),
      makeMsg({ id: 'u2', role: 'user', content: 'Next' }),
      makeMsg({ id: 'a2', role: 'assistant', content: 'OK' }),
      makeMsg({ id: 'u3', role: 'user', content: 'More' }),
      makeMsg({ id: 'a3', role: 'assistant', content: 'End' }),
    ];
    const conv = makeConversation(msgs);

    const result = svc.compact(conv, { exchangesToKeep: 2, includeFileReferences: false });

    expect(result.filesReferenced).toEqual([]);
  });
});

describe('ContextCompactionService — topic extraction', () => {
  let svc: ContextCompactionService;

  beforeEach(() => {
    svc = new ContextCompactionService();
  });

  it('extracts topics based on task verbs in user messages', () => {
    const msgs = [
      makeMsg({ id: 'u1', role: 'user', content: 'Create a new dashboard component' }),
      makeMsg({ id: 'a1', role: 'assistant', content: 'Creating...' }),
      makeMsg({ id: 'u2', role: 'user', content: 'OK next' }),
      makeMsg({ id: 'a2', role: 'assistant', content: 'Done' }),
      makeMsg({ id: 'u3', role: 'user', content: 'Thanks' }),
      makeMsg({ id: 'a3', role: 'assistant', content: 'Welcome' }),
    ];
    const conv = makeConversation(msgs);

    const result = svc.compact(conv, { exchangesToKeep: 2 });

    expect(result.topics.length).toBeGreaterThan(0);
    expect(result.topics.some(t => t.toLowerCase().includes('create'))).toBe(true);
  });
});

describe('ContextCompactionService — shouldCompactByMessageCount', () => {
  let svc: ContextCompactionService;

  beforeEach(() => {
    svc = new ContextCompactionService();
  });

  it('returns true when message count exceeds threshold', () => {
    const msgs = Array.from({ length: 25 }, (_, i) =>
      makeMsg({ id: `m${i}`, role: i % 2 === 0 ? 'user' : 'assistant', content: `msg ${i}` })
    );
    const conv = makeConversation(msgs);

    expect(svc.shouldCompactByMessageCount(conv, 20)).toBe(true);
  });

  it('returns false when message count is within threshold', () => {
    const msgs = Array.from({ length: 15 }, (_, i) =>
      makeMsg({ id: `m${i}`, role: i % 2 === 0 ? 'user' : 'assistant', content: `msg ${i}` })
    );
    const conv = makeConversation(msgs);

    expect(svc.shouldCompactByMessageCount(conv, 20)).toBe(false);
  });

  it('uses default threshold of 20 when not specified', () => {
    const msgs = Array.from({ length: 21 }, (_, i) =>
      makeMsg({ id: `m${i}`, role: i % 2 === 0 ? 'user' : 'assistant', content: `msg ${i}` })
    );
    const conv = makeConversation(msgs);

    expect(svc.shouldCompactByMessageCount(conv)).toBe(true);
  });
});

describe('ContextCompactionService — compactedAt timestamp', () => {
  let svc: ContextCompactionService;

  beforeEach(() => {
    svc = new ContextCompactionService();
  });

  it('sets compactedAt to a recent timestamp', () => {
    const before = Date.now();
    const msgs = [
      makeMsg({ id: 'u1', role: 'user', content: 'Q' }),
      makeMsg({ id: 'a1', role: 'assistant', content: 'A' }),
      makeMsg({ id: 'u2', role: 'user', content: 'Q2' }),
      makeMsg({ id: 'a2', role: 'assistant', content: 'A2' }),
      makeMsg({ id: 'u3', role: 'user', content: 'Q3' }),
      makeMsg({ id: 'a3', role: 'assistant', content: 'A3' }),
    ];
    const conv = makeConversation(msgs);

    const result = svc.compact(conv, { exchangesToKeep: 2 });
    const after = Date.now();

    expect(result.compactedAt).toBeGreaterThanOrEqual(before);
    expect(result.compactedAt).toBeLessThanOrEqual(after);
  });
});
