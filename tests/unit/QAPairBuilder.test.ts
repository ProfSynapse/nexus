/**
 * QAPairBuilder Unit Tests
 *
 * Tests the pure buildQAPairs and hashContent functions that convert
 * conversation messages into QA pairs for embedding. No mocks needed.
 */

import { buildQAPairs, hashContent, QAPair } from '../../src/services/embeddings/QAPairBuilder';
import {
  SIMPLE_CONVERSATION,
  TOOL_CONVERSATION,
  MIXED_STATE_CONVERSATION,
  ORPHAN_CONVERSATION,
  NULL_CONTENT_MESSAGES,
  UNSORTED_CONVERSATION,
  SYSTEM_MESSAGE,
  CONVERSATION_IDS,
  WORKSPACE_IDS,
  SESSION_IDS,
  createMessage,
  resetMessageIdCounter,
  TOOL_CALLS,
} from '../fixtures/conversationSearch';

beforeEach(() => {
  resetMessageIdCounter();
});

describe('QAPairBuilder', () => {
  // ==========================================================================
  // hashContent
  // ==========================================================================

  describe('hashContent', () => {
    it('should return a deterministic hex string for the same input', () => {
      const hash1 = hashContent('Hello, world!');
      const hash2 = hashContent('Hello, world!');
      expect(hash1).toBe(hash2);
    });

    it('should return different hashes for different inputs', () => {
      const hash1 = hashContent('Hello');
      const hash2 = hashContent('World');
      expect(hash1).not.toBe(hash2);
    });

    it('should return a hex string', () => {
      const hash = hashContent('test content');
      expect(hash).toMatch(/^[0-9a-f]+$/);
    });

    it('should handle empty string', () => {
      const hash = hashContent('');
      expect(typeof hash).toBe('string');
      expect(hash.length).toBeGreaterThan(0);
    });

    it('should handle very long strings', () => {
      const hash = hashContent('A'.repeat(100000));
      expect(typeof hash).toBe('string');
      expect(hash).toMatch(/^[0-9a-f]+$/);
    });
  });

  // ==========================================================================
  // Conversation Turns (user + assistant)
  // ==========================================================================

  describe('conversation turns', () => {
    it('should pair user messages with following assistant messages', () => {
      const pairs = buildQAPairs(SIMPLE_CONVERSATION, CONVERSATION_IDS.simple);

      expect(pairs).toHaveLength(2);

      // First pair: msg-s1 (user) + msg-s2 (assistant)
      expect(pairs[0].pairType).toBe('conversation_turn');
      expect(pairs[0].question).toBe('How do I create a new note in Obsidian using the API?');
      expect(pairs[0].answer).toContain('app.vault.create');
      expect(pairs[0].startSequenceNumber).toBe(0);
      expect(pairs[0].endSequenceNumber).toBe(1);

      // Second pair: msg-s3 (user) + msg-s4 (assistant)
      expect(pairs[1].pairType).toBe('conversation_turn');
      expect(pairs[1].question).toBe('What about creating a note in a specific folder?');
      expect(pairs[1].startSequenceNumber).toBe(2);
      expect(pairs[1].endSequenceNumber).toBe(3);
    });

    it('should use correct pairId format for conversation turns', () => {
      const pairs = buildQAPairs(SIMPLE_CONVERSATION, CONVERSATION_IDS.simple);

      // Format: ${conversationId}:${startSequenceNumber}
      expect(pairs[0].pairId).toBe(`${CONVERSATION_IDS.simple}:0`);
      expect(pairs[1].pairId).toBe(`${CONVERSATION_IDS.simple}:2`);
    });

    it('should set sourceId to the user message id', () => {
      const pairs = buildQAPairs(SIMPLE_CONVERSATION, CONVERSATION_IDS.simple);

      expect(pairs[0].sourceId).toBe('msg-s1');
      expect(pairs[1].sourceId).toBe('msg-s3');
    });

    it('should set conversationId on all pairs', () => {
      const pairs = buildQAPairs(SIMPLE_CONVERSATION, CONVERSATION_IDS.simple);

      for (const pair of pairs) {
        expect(pair.conversationId).toBe(CONVERSATION_IDS.simple);
      }
    });
  });

  // ==========================================================================
  // Tool Traces (tool call + tool result)
  // ==========================================================================

  describe('tool traces', () => {
    it('should create trace pairs for tool calls with matching results', () => {
      const pairs = buildQAPairs(TOOL_CONVERSATION, CONVERSATION_IDS.withTools);

      // Should have: 1 conversation turn (user->first assistant) + 2 trace pairs + 1 conversation turn (user->second assistant)
      const tracePairs = pairs.filter(p => p.pairType === 'trace_pair');
      expect(tracePairs).toHaveLength(2);
    });

    it('should format tool call question correctly', () => {
      const pairs = buildQAPairs(TOOL_CONVERSATION, CONVERSATION_IDS.withTools);
      const tracePairs = pairs.filter(p => p.pairType === 'trace_pair');

      expect(tracePairs[0].question).toBe('Tool: searchContent({"query":"vault API","limit":5})');
      expect(tracePairs[1].question).toBe('Tool: readContent({"path":"docs/api-reference.md"})');
    });

    it('should use tool result content as the answer', () => {
      const pairs = buildQAPairs(TOOL_CONVERSATION, CONVERSATION_IDS.withTools);
      const tracePairs = pairs.filter(p => p.pairType === 'trace_pair');

      expect(tracePairs[0].answer).toContain('results');
      expect(tracePairs[1].answer).toContain('Vault API Reference');
    });

    it('should use correct pairId format for trace pairs', () => {
      const pairs = buildQAPairs(TOOL_CONVERSATION, CONVERSATION_IDS.withTools);
      const tracePairs = pairs.filter(p => p.pairType === 'trace_pair');

      // Format: ${conversationId}:${assistantSequenceNumber}:${toolCallId}
      expect(tracePairs[0].pairId).toBe(`${CONVERSATION_IDS.withTools}:1:tc-001`);
      expect(tracePairs[1].pairId).toBe(`${CONVERSATION_IDS.withTools}:1:tc-002`);
    });

    it('should set sourceId to the assistant message id for trace pairs', () => {
      const pairs = buildQAPairs(TOOL_CONVERSATION, CONVERSATION_IDS.withTools);
      const tracePairs = pairs.filter(p => p.pairType === 'trace_pair');

      // sourceId is the assistant message that made the tool calls
      expect(tracePairs[0].sourceId).toBe('msg-t2');
      expect(tracePairs[1].sourceId).toBe('msg-t2');
    });
  });

  // ==========================================================================
  // Filtering: state='complete' only
  // ==========================================================================

  describe('message state filtering', () => {
    it('should only process messages with state complete', () => {
      const pairs = buildQAPairs(MIXED_STATE_CONVERSATION, 'conv-mixed-001');

      // msg-m2 is streaming state, so user msg-m1 should be orphaned (no complete assistant follows before next user)
      // msg-m3 (user, complete) + msg-m4 (assistant, complete) should pair
      expect(pairs).toHaveLength(1);
      expect(pairs[0].question).toContain('plugin lifecycle');
      expect(pairs[0].answer).toContain('onload()');
    });

    it('should skip messages without a state field (treated as complete)', () => {
      const messages = [
        createMessage({
          id: 'msg-ns1',
          role: 'user',
          content: 'Question without state',
          sequenceNumber: 0,
          state: undefined as unknown as 'complete',
        }),
        createMessage({
          id: 'msg-ns2',
          role: 'assistant',
          content: 'Answer without state',
          sequenceNumber: 1,
          state: undefined as unknown as 'complete',
        }),
      ];

      // isProcessableMessage returns true when state is falsy (no state field)
      const pairs = buildQAPairs(messages, 'conv-no-state');
      expect(pairs).toHaveLength(1);
    });
  });

  // ==========================================================================
  // Orphan Messages
  // ==========================================================================

  describe('orphan messages', () => {
    it('should skip user messages without a following assistant response', () => {
      const pairs = buildQAPairs(ORPHAN_CONVERSATION, 'conv-orphan-001');
      expect(pairs).toHaveLength(0);
    });

    it('should skip user messages when next message is another user message', () => {
      const messages = [
        createMessage({ role: 'user', content: 'First question', sequenceNumber: 0 }),
        createMessage({ role: 'user', content: 'Second question', sequenceNumber: 1 }),
        createMessage({ role: 'assistant', content: 'Answer to second', sequenceNumber: 2 }),
      ];

      const pairs = buildQAPairs(messages, 'conv-double-user');

      // First user message is orphaned because next message is another user
      // Second user message pairs with assistant
      expect(pairs).toHaveLength(1);
      expect(pairs[0].question).toBe('Second question');
    });
  });

  // ==========================================================================
  // System Messages
  // ==========================================================================

  describe('system messages', () => {
    it('should skip system messages', () => {
      const messages = [
        SYSTEM_MESSAGE,
        ...SIMPLE_CONVERSATION,
      ];

      const pairs = buildQAPairs(messages, CONVERSATION_IDS.simple);

      // System message should not affect pairing
      expect(pairs).toHaveLength(2);
      // No pair should have system content
      for (const pair of pairs) {
        expect(pair.question).not.toContain('helpful assistant');
        expect(pair.answer).not.toContain('helpful assistant');
      }
    });
  });

  // ==========================================================================
  // Empty / Null Input
  // ==========================================================================

  describe('empty and null input', () => {
    it('should return empty array for empty messages', () => {
      const pairs = buildQAPairs([], 'conv-empty');
      expect(pairs).toEqual([]);
    });

    it('should return empty array for null messages', () => {
      const pairs = buildQAPairs(null as unknown as any[], 'conv-null');
      expect(pairs).toEqual([]);
    });

    it('should return empty array for undefined messages', () => {
      const pairs = buildQAPairs(undefined as unknown as any[], 'conv-undef');
      expect(pairs).toEqual([]);
    });
  });

  // ==========================================================================
  // Sorting
  // ==========================================================================

  describe('message sorting', () => {
    it('should sort messages by sequenceNumber before processing', () => {
      const pairs = buildQAPairs(UNSORTED_CONVERSATION, 'conv-unsorted-001');

      expect(pairs).toHaveLength(1);
      expect(pairs[0].question).toContain('settings');
      expect(pairs[0].answer).toContain('answer to your question');
      expect(pairs[0].startSequenceNumber).toBe(0);
      expect(pairs[0].endSequenceNumber).toBe(1);
    });
  });

  // ==========================================================================
  // Metadata Passthrough
  // ==========================================================================

  describe('metadata passthrough', () => {
    it('should include workspaceId when provided', () => {
      const pairs = buildQAPairs(
        SIMPLE_CONVERSATION,
        CONVERSATION_IDS.simple,
        WORKSPACE_IDS.default
      );

      for (const pair of pairs) {
        expect(pair.workspaceId).toBe(WORKSPACE_IDS.default);
      }
    });

    it('should include sessionId when provided', () => {
      const pairs = buildQAPairs(
        SIMPLE_CONVERSATION,
        CONVERSATION_IDS.simple,
        WORKSPACE_IDS.default,
        SESSION_IDS.current
      );

      for (const pair of pairs) {
        expect(pair.sessionId).toBe(SESSION_IDS.current);
      }
    });

    it('should leave workspaceId undefined when not provided', () => {
      const pairs = buildQAPairs(SIMPLE_CONVERSATION, CONVERSATION_IDS.simple);

      for (const pair of pairs) {
        expect(pair.workspaceId).toBeUndefined();
      }
    });

    it('should leave sessionId undefined when not provided', () => {
      const pairs = buildQAPairs(SIMPLE_CONVERSATION, CONVERSATION_IDS.simple);

      for (const pair of pairs) {
        expect(pair.sessionId).toBeUndefined();
      }
    });
  });

  // ==========================================================================
  // Content Hash Determinism
  // ==========================================================================

  describe('contentHash', () => {
    it('should produce deterministic hash for same question+answer', () => {
      const pairs1 = buildQAPairs(SIMPLE_CONVERSATION, CONVERSATION_IDS.simple);
      const pairs2 = buildQAPairs(SIMPLE_CONVERSATION, CONVERSATION_IDS.simple);

      expect(pairs1[0].contentHash).toBe(pairs2[0].contentHash);
    });

    it('should produce different hashes for different question+answer combinations', () => {
      const pairs = buildQAPairs(SIMPLE_CONVERSATION, CONVERSATION_IDS.simple);

      expect(pairs[0].contentHash).not.toBe(pairs[1].contentHash);
    });

    it('should use hash of question + answer concatenation', () => {
      const pairs = buildQAPairs(SIMPLE_CONVERSATION, CONVERSATION_IDS.simple);
      const expectedHash = hashContent(pairs[0].question + pairs[0].answer);

      expect(pairs[0].contentHash).toBe(expectedHash);
    });
  });

  // ==========================================================================
  // Tool Messages Between User and Assistant
  // ==========================================================================

  describe('tool messages between user and assistant', () => {
    it('should skip tool messages when finding assistant response for user message', () => {
      const pairs = buildQAPairs(TOOL_CONVERSATION, CONVERSATION_IDS.withTools);
      const turnPairs = pairs.filter(p => p.pairType === 'conversation_turn');

      // user msg-t1 should pair with assistant msg-t2 (skipping tool messages)
      expect(turnPairs.length).toBeGreaterThanOrEqual(1);
      expect(turnPairs[0].question).toContain('Search for information');
      expect(turnPairs[0].answer).toContain('search for vault API information');
    });

    it('should format tool call using parameters when function.arguments is absent', () => {
      const messages = [
        createMessage({ role: 'user', content: 'Use a tool', sequenceNumber: 0 }),
        createMessage({
          role: 'assistant',
          content: 'Running tool.',
          sequenceNumber: 1,
          toolCalls: [{
            id: 'tc-params',
            type: 'function' as const,
            function: { name: 'myTool', arguments: '' },
            parameters: { key: 'value', count: 42 },
          }],
        }),
        createMessage({
          role: 'tool',
          content: 'Tool result here',
          sequenceNumber: 2,
          toolCallId: 'tc-params',
        }),
      ];

      const pairs = buildQAPairs(messages, 'conv-params');
      const tracePairs = pairs.filter(p => p.pairType === 'trace_pair');

      expect(tracePairs).toHaveLength(1);
      expect(tracePairs[0].question).toBe('Tool: myTool({"key":"value","count":42})');
    });

    it('should use empty object fallback when no arguments or parameters', () => {
      const messages = [
        createMessage({ role: 'user', content: 'Use a tool', sequenceNumber: 0 }),
        createMessage({
          role: 'assistant',
          content: 'Running tool.',
          sequenceNumber: 1,
          toolCalls: [{
            id: 'tc-no-args',
            type: 'function' as const,
            function: { name: 'noArgTool', arguments: '' },
          }],
        }),
        createMessage({
          role: 'tool',
          content: 'Done',
          sequenceNumber: 2,
          toolCallId: 'tc-no-args',
        }),
      ];

      const pairs = buildQAPairs(messages, 'conv-no-args');
      const tracePairs = pairs.filter(p => p.pairType === 'trace_pair');

      expect(tracePairs).toHaveLength(1);
      expect(tracePairs[0].question).toBe('Tool: noArgTool({})');
    });

    it('should use toolCall.name when function.name is absent', () => {
      const messages = [
        createMessage({ role: 'user', content: 'Use a tool', sequenceNumber: 0 }),
        createMessage({
          role: 'assistant',
          content: 'Running tool.',
          sequenceNumber: 1,
          toolCalls: [{
            id: 'tc-name-fallback',
            type: 'function' as const,
            function: { name: '', arguments: '{"a":1}' },
            name: 'fallbackName',
          }],
        }),
        createMessage({
          role: 'tool',
          content: 'Result',
          sequenceNumber: 2,
          toolCallId: 'tc-name-fallback',
        }),
      ];

      const pairs = buildQAPairs(messages, 'conv-name-fallback');
      const tracePairs = pairs.filter(p => p.pairType === 'trace_pair');

      expect(tracePairs).toHaveLength(1);
      expect(tracePairs[0].question).toBe('Tool: fallbackName({"a":1})');
    });

    it('should handle tool calls with no matching tool result', () => {
      const messages = [
        createMessage({
          role: 'user',
          content: 'Do something',
          sequenceNumber: 0,
        }),
        createMessage({
          role: 'assistant',
          content: 'Let me try.',
          sequenceNumber: 1,
          toolCalls: [{
            id: 'tc-orphan',
            type: 'function' as const,
            function: { name: 'someFunc', arguments: '{}' },
          }],
        }),
        // No tool result message for tc-orphan
      ];

      const pairs = buildQAPairs(messages, 'conv-orphan-tool');
      const tracePairs = pairs.filter(p => p.pairType === 'trace_pair');

      // No trace pair should be created for the orphan tool call
      expect(tracePairs).toHaveLength(0);
    });
  });

  // ==========================================================================
  // Null Content Handling
  // ==========================================================================

  describe('null content handling', () => {
    it('should use empty string for null user content', () => {
      const messages = [
        createMessage({ role: 'user', content: null, sequenceNumber: 0 }),
        createMessage({ role: 'assistant', content: 'Some response', sequenceNumber: 1 }),
      ];

      const pairs = buildQAPairs(messages, 'conv-null-content');
      expect(pairs).toHaveLength(1);
      expect(pairs[0].question).toBe('');
    });

    it('should use empty string for null assistant content in conversation turn', () => {
      const messages = [
        createMessage({ role: 'user', content: 'A question', sequenceNumber: 0 }),
        createMessage({ role: 'assistant', content: null, sequenceNumber: 1 }),
      ];

      const pairs = buildQAPairs(messages, 'conv-null-asst');
      expect(pairs).toHaveLength(1);
      expect(pairs[0].answer).toBe('');
    });

    it('should use fallback text for tool result with no content', () => {
      const messages = [
        createMessage({ role: 'user', content: 'Run a tool', sequenceNumber: 0 }),
        createMessage({
          role: 'assistant',
          content: 'Running tool.',
          sequenceNumber: 1,
          toolCalls: [{ id: 'tc-no-content', type: 'function' as const, function: { name: 'myTool', arguments: '{}' } }],
        }),
        createMessage({
          role: 'tool',
          content: null,
          sequenceNumber: 2,
          toolCallId: 'tc-no-content',
        }),
      ];

      const pairs = buildQAPairs(messages, 'conv-no-tool-content');
      const tracePairs = pairs.filter(p => p.pairType === 'trace_pair');

      expect(tracePairs).toHaveLength(1);
      expect(tracePairs[0].answer).toBe('[No tool result content]');
    });
  });
});
