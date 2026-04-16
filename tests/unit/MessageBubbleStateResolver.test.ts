/**
 * MessageBubbleStateResolver unit tests
 *
 * Covers:
 *   1. getActiveBranchMessage — 4 silent-fallback branches
 *   2. shouldRenderTextBubble — all 5 clauses of the OR condition
 *   3. resolve() — wires content, toolCalls, reasoning, and shouldRenderTextBubble
 */

import {
  MessageBubbleStateResolver,
} from '../../src/ui/chat/components/helpers/MessageBubbleStateResolver';
import type { ConversationMessage } from '../../src/types/chat/ChatTypes';
import type { ConversationBranch } from '../../src/types/branch/BranchTypes';

// ---------------------------------------------------------------------------
// Minimal fixture builders
// ---------------------------------------------------------------------------

function makeMessage(overrides: Partial<ConversationMessage> = {}): ConversationMessage {
  return {
    id: 'msg-1',
    role: 'assistant',
    content: 'base content',
    timestamp: Date.now(),
    ...overrides,
  } as ConversationMessage;
}

function makeBranch(content: string, toolCalls?: ConversationMessage['toolCalls']): ConversationBranch {
  return {
    id: `branch-${Math.random()}`,
    inheritContext: true,
    messages: [makeMessage({ content, toolCalls })],
  } as ConversationBranch;
}

function makeEmptyBranch(): ConversationBranch {
  return {
    id: 'empty-branch',
    inheritContext: true,
    messages: [],
  } as ConversationBranch;
}

// ---------------------------------------------------------------------------
// getActiveBranchMessage — 4 silent-fallback branches
// ---------------------------------------------------------------------------

describe('MessageBubbleStateResolver — getActiveBranchMessage fallbacks', () => {
  it('returns null (uses base message) when activeAlternativeIndex is 0', () => {
    const msg = makeMessage({
      activeAlternativeIndex: 0,
      branches: [makeBranch('branch content')],
    });
    const { activeContent } = MessageBubbleStateResolver.resolve(msg);
    expect(activeContent).toBe('base content');
  });

  it('returns null (uses base message) when activeAlternativeIndex is undefined (falsy)', () => {
    const msg = makeMessage({
      activeAlternativeIndex: undefined,
      branches: [makeBranch('branch content')],
    });
    const { activeContent } = MessageBubbleStateResolver.resolve(msg);
    expect(activeContent).toBe('base content');
  });

  it('returns null (uses base message) when branches array is empty', () => {
    const msg = makeMessage({
      activeAlternativeIndex: 1,
      branches: [],
    });
    const { activeContent } = MessageBubbleStateResolver.resolve(msg);
    expect(activeContent).toBe('base content');
  });

  it('returns null (uses base message) when branches is undefined', () => {
    const msg = makeMessage({
      activeAlternativeIndex: 1,
      branches: undefined,
    });
    const { activeContent } = MessageBubbleStateResolver.resolve(msg);
    expect(activeContent).toBe('base content');
  });

  it('returns null (uses base message) when activeAlternativeIndex is out of range', () => {
    const msg = makeMessage({
      activeAlternativeIndex: 5, // branchIndex = 4, but only 1 branch exists
      branches: [makeBranch('branch content')],
    });
    const { activeContent } = MessageBubbleStateResolver.resolve(msg);
    expect(activeContent).toBe('base content');
  });

  it('returns null (uses base message) when the target branch has no messages', () => {
    const msg = makeMessage({
      activeAlternativeIndex: 1, // branchIndex = 0
      branches: [makeEmptyBranch()],
    });
    const { activeContent } = MessageBubbleStateResolver.resolve(msg);
    expect(activeContent).toBe('base content');
  });

  it('returns branch message content when activeAlternativeIndex points to a valid branch', () => {
    const msg = makeMessage({
      activeAlternativeIndex: 1, // branchIndex = 0
      branches: [makeBranch('branch content')],
    });
    const { activeContent } = MessageBubbleStateResolver.resolve(msg);
    expect(activeContent).toBe('branch content');
  });

  it('returns the LAST message in the branch (multi-message branch)', () => {
    const branch: ConversationBranch = {
      id: 'multi-msg-branch',
      inheritContext: true,
      messages: [
        makeMessage({ content: 'first' }),
        makeMessage({ content: 'second' }),
        makeMessage({ content: 'last' }),
      ],
    } as ConversationBranch;

    const msg = makeMessage({
      activeAlternativeIndex: 1,
      branches: [branch],
    });
    const { activeContent } = MessageBubbleStateResolver.resolve(msg);
    expect(activeContent).toBe('last');
  });
});

// ---------------------------------------------------------------------------
// getActiveToolCalls and getActiveReasoning — branch routing
// ---------------------------------------------------------------------------

describe('MessageBubbleStateResolver — toolCalls and reasoning routing', () => {
  it('returns base toolCalls when no active branch', () => {
    const toolCalls = [{ id: 'tc-1', type: 'function', function: { name: 'read', arguments: '{}' } }] as ConversationMessage['toolCalls'];
    const msg = makeMessage({ toolCalls });
    const { activeToolCalls } = MessageBubbleStateResolver.resolve(msg);
    expect(activeToolCalls).toBe(toolCalls);
  });

  it('returns branch toolCalls when active branch has them', () => {
    const branchToolCalls = [{ id: 'tc-2', type: 'function', function: { name: 'write', arguments: '{}' } }] as ConversationMessage['toolCalls'];
    const msg = makeMessage({
      toolCalls: [{ id: 'tc-base', type: 'function', function: { name: 'read', arguments: '{}' } }] as ConversationMessage['toolCalls'],
      activeAlternativeIndex: 1,
      branches: [makeBranch('branch', branchToolCalls)],
    });
    const { activeToolCalls } = MessageBubbleStateResolver.resolve(msg);
    expect(activeToolCalls).toBe(branchToolCalls);
  });

  it('returns base reasoning when no active branch', () => {
    const msg = makeMessage({ reasoning: 'base reasoning' });
    const { activeReasoning } = MessageBubbleStateResolver.resolve(msg);
    expect(activeReasoning).toBe('base reasoning');
  });

  it('returns branch reasoning when active branch has reasoning', () => {
    const branchMsg = makeMessage({ content: 'branch', reasoning: 'branch reasoning' });
    const branch: ConversationBranch = { id: 'b', inheritContext: true, messages: [branchMsg] } as ConversationBranch;
    const msg = makeMessage({ reasoning: 'base reasoning', activeAlternativeIndex: 1, branches: [branch] });
    const { activeReasoning } = MessageBubbleStateResolver.resolve(msg);
    expect(activeReasoning).toBe('branch reasoning');
  });
});

// ---------------------------------------------------------------------------
// shouldRenderTextBubble — all 5 OR clauses
// ---------------------------------------------------------------------------

describe('MessageBubbleStateResolver — shouldRenderTextBubble', () => {
  it('returns false for non-assistant role', () => {
    const msg = makeMessage({ role: 'user', content: 'hello' });
    const { shouldRenderTextBubble } = MessageBubbleStateResolver.resolve(msg);
    expect(shouldRenderTextBubble).toBe(false);
  });

  it('returns true when assistant has non-empty content (clause 1)', () => {
    const msg = makeMessage({ role: 'assistant', content: 'some text' });
    const { shouldRenderTextBubble } = MessageBubbleStateResolver.resolve(msg);
    expect(shouldRenderTextBubble).toBe(true);
  });

  it('returns false when assistant content is only whitespace', () => {
    const msg = makeMessage({ role: 'assistant', content: '   ' });
    const { shouldRenderTextBubble } = MessageBubbleStateResolver.resolve(msg);
    // No streaming, no loading, no toolCalls, no reasoning — all clauses false
    expect(shouldRenderTextBubble).toBe(false);
  });

  it('returns true when assistant is streaming (clause 2)', () => {
    const msg = makeMessage({ role: 'assistant', content: '', state: 'streaming' });
    const { shouldRenderTextBubble } = MessageBubbleStateResolver.resolve(msg);
    expect(shouldRenderTextBubble).toBe(true);
  });

  it('returns true when assistant isLoading (clause 3)', () => {
    const msg = makeMessage({ role: 'assistant', content: '', isLoading: true });
    const { shouldRenderTextBubble } = MessageBubbleStateResolver.resolve(msg);
    expect(shouldRenderTextBubble).toBe(true);
  });

  it('returns true when assistant has toolCalls (clause 4)', () => {
    const msg = makeMessage({
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'tc', type: 'function', function: { name: 'read', arguments: '{}' } }] as ConversationMessage['toolCalls'],
    });
    const { shouldRenderTextBubble } = MessageBubbleStateResolver.resolve(msg);
    expect(shouldRenderTextBubble).toBe(true);
  });

  it('returns true when assistant has reasoning (clause 5)', () => {
    const msg = makeMessage({ role: 'assistant', content: '', reasoning: 'I think therefore...' });
    const { shouldRenderTextBubble } = MessageBubbleStateResolver.resolve(msg);
    expect(shouldRenderTextBubble).toBe(true);
  });

  it('returns false when all clauses are false (empty, not streaming, no toolCalls, no reasoning)', () => {
    const msg = makeMessage({
      role: 'assistant',
      content: '',
      state: 'complete',
      isLoading: false,
      toolCalls: undefined,
      reasoning: undefined,
    });
    const { shouldRenderTextBubble } = MessageBubbleStateResolver.resolve(msg);
    expect(shouldRenderTextBubble).toBe(false);
  });
});
