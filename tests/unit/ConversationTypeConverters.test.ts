/**
 * Unit tests for ConversationTypeConverters
 *
 * Tests edge cases in type conversion between HybridStorageTypes and legacy StorageTypes.
 * Focus areas: malformed JSON in toolCall arguments, missing tc.function, cost fallback
 * chain, empty messages, branch population.
 */

import {
  convertToLegacyMetadata,
  convertToLegacyConversation,
  convertToConversationBranch,
  populateMessageBranches,
} from '../../src/services/helpers/ConversationTypeConverters';
import type { ConversationMetadata, MessageData } from '../../src/types/storage/HybridStorageTypes';
import type { IndividualConversation, ConversationMessage } from '../../src/types/storage/StorageTypes';

// ============================================================================
// Helpers
// ============================================================================

function makeMetadata(overrides: Partial<ConversationMetadata> = {}): ConversationMetadata {
  return {
    id: 'conv-1',
    title: 'Test Conversation',
    created: 1000,
    updated: 2000,
    vaultName: 'test-vault',
    messageCount: 0,
    ...overrides,
  };
}

function makeMessage(overrides: Partial<MessageData> = {}): MessageData {
  return {
    id: 'msg-1',
    conversationId: 'conv-1',
    role: 'user',
    content: 'Hello',
    timestamp: 1000,
    state: 'complete',
    sequenceNumber: 1,
    ...overrides,
  };
}

// ============================================================================
// convertToLegacyMetadata
// ============================================================================

describe('convertToLegacyMetadata', () => {
  it('maps all required fields correctly', () => {
    const metadata = makeMetadata({
      id: 'conv-abc',
      title: 'My Chat',
      created: 100,
      updated: 200,
      vaultName: 'vault-x',
      messageCount: 42,
    });
    const result = convertToLegacyMetadata(metadata);

    expect(result).toEqual({
      id: 'conv-abc',
      title: 'My Chat',
      created: 100,
      updated: 200,
      vault_name: 'vault-x',
      message_count: 42,
    });
  });

  it('handles empty string fields', () => {
    const result = convertToLegacyMetadata(makeMetadata({
      id: '',
      title: '',
      vaultName: '',
    }));
    expect(result.id).toBe('');
    expect(result.title).toBe('');
    expect(result.vault_name).toBe('');
  });

  it('handles zero messageCount', () => {
    const result = convertToLegacyMetadata(makeMetadata({ messageCount: 0 }));
    expect(result.message_count).toBe(0);
  });
});

// ============================================================================
// convertToLegacyConversation
// ============================================================================

describe('convertToLegacyConversation', () => {
  it('converts empty messages array', () => {
    const result = convertToLegacyConversation(makeMetadata(), []);
    expect(result.messages).toEqual([]);
    expect(result.id).toBe('conv-1');
  });

  it('converts messages with null content to empty string', () => {
    const result = convertToLegacyConversation(makeMetadata(), [
      makeMessage({ content: null }),
    ]);
    expect(result.messages[0].content).toBe('');
  });

  it('preserves message state and reasoning', () => {
    const result = convertToLegacyConversation(makeMetadata(), [
      makeMessage({
        state: 'streaming',
        reasoning: 'Let me think...',
      }),
    ]);
    expect(result.messages[0].state).toBe('streaming');
    expect(result.messages[0].reasoning).toBe('Let me think...');
  });

  describe('toolCall conversion', () => {
    it('handles standard OpenAI format with valid JSON arguments', () => {
      const result = convertToLegacyConversation(makeMetadata(), [
        makeMessage({
          role: 'assistant',
          toolCalls: [{
            id: 'tc-1',
            type: 'function',
            function: { name: 'search', arguments: '{"query":"test"}' },
          }],
        }),
      ]);
      const tc = result.messages[0].toolCalls![0];
      expect(tc.name).toBe('search');
      expect(tc.parameters).toEqual({ query: 'test' });
    });

    it('handles malformed JSON in function.arguments — preserves raw string', () => {
      const result = convertToLegacyConversation(makeMetadata(), [
        makeMessage({
          role: 'assistant',
          toolCalls: [{
            id: 'tc-1',
            type: 'function',
            function: { name: 'search', arguments: '{broken json' },
          }],
        }),
      ]);
      const tc = result.messages[0].toolCalls![0];
      expect(tc.name).toBe('search');
      // Malformed JSON preserved as raw string
      expect(tc.parameters).toBe('{broken json');
    });

    it('handles function.arguments as object (already parsed)', () => {
      const result = convertToLegacyConversation(makeMetadata(), [
        makeMessage({
          role: 'assistant',
          toolCalls: [{
            id: 'tc-1',
            type: 'function',
            function: { name: 'tool', arguments: { key: 'value' } as unknown as string },
          }],
        }),
      ]);
      const tc = result.messages[0].toolCalls![0];
      expect(tc.parameters).toEqual({ key: 'value' });
    });

    it('handles missing tc.function — uses tc.name and tc.parameters', () => {
      const result = convertToLegacyConversation(makeMetadata(), [
        makeMessage({
          role: 'assistant',
          toolCalls: [{
            id: 'tc-2',
            type: 'function',
            function: undefined as any,
            name: 'legacy_tool',
            parameters: { arg: 1 },
          }],
        }),
      ]);
      const tc = result.messages[0].toolCalls![0];
      expect(tc.name).toBe('legacy_tool');
      expect(tc.parameters).toEqual({ arg: 1 });
    });

    it('defaults to "unknown_tool" when neither function.name nor name exists', () => {
      const result = convertToLegacyConversation(makeMetadata(), [
        makeMessage({
          role: 'assistant',
          toolCalls: [{
            id: 'tc-3',
            type: 'function',
            function: { name: '', arguments: '{}' },
          }],
        }),
      ]);
      const tc = result.messages[0].toolCalls![0];
      expect(tc.name).toBe('unknown_tool');
    });

    it('preserves result, success, and error fields', () => {
      const result = convertToLegacyConversation(makeMetadata(), [
        makeMessage({
          role: 'assistant',
          toolCalls: [{
            id: 'tc-4',
            type: 'function',
            function: { name: 'tool', arguments: '{}' },
            result: 'tool output',
            success: true,
            error: undefined,
          }],
        }),
      ]);
      const tc = result.messages[0].toolCalls![0];
      expect(tc.result).toBe('tool output');
      expect(tc.success).toBe(true);
    });

    it('defaults type to "function" when not provided', () => {
      const result = convertToLegacyConversation(makeMetadata(), [
        makeMessage({
          role: 'assistant',
          toolCalls: [{
            id: 'tc-5',
            type: undefined as any,
            function: { name: 'tool', arguments: '{}' },
          }],
        }),
      ]);
      expect(result.messages[0].toolCalls![0].type).toBe('function');
    });

    it('handles empty function.arguments string', () => {
      const result = convertToLegacyConversation(makeMetadata(), [
        makeMessage({
          role: 'assistant',
          toolCalls: [{
            id: 'tc-6',
            type: 'function',
            function: { name: 'tool', arguments: '' },
          }],
        }),
      ]);
      const tc = result.messages[0].toolCalls![0];
      // Empty string is falsy, so it goes to else branch using tc.parameters
      expect(tc.parameters).toEqual({});
    });
  });

  describe('cost fallback chain', () => {
    it('uses metadata.cost when present', () => {
      const result = convertToLegacyConversation(
        makeMetadata({
          metadata: {
            cost: { totalCost: 0.05, currency: 'USD' },
          },
        }),
        []
      );
      expect(result.cost).toEqual({ totalCost: 0.05, currency: 'USD' });
      expect(result.metadata?.cost).toEqual({ totalCost: 0.05, currency: 'USD' });
    });

    it('constructs cost from totalCost when cost object missing', () => {
      const result = convertToLegacyConversation(
        makeMetadata({
          metadata: {
            totalCost: 0.10,
            currency: 'EUR',
          },
        }),
        []
      );
      expect(result.cost).toEqual({ totalCost: 0.10, currency: 'EUR' });
    });

    it('defaults currency to USD when totalCost present but currency missing', () => {
      const result = convertToLegacyConversation(
        makeMetadata({
          metadata: {
            totalCost: 0.03,
          },
        }),
        []
      );
      expect(result.cost).toEqual({ totalCost: 0.03, currency: 'USD' });
    });

    it('returns undefined cost when no cost data present', () => {
      const result = convertToLegacyConversation(
        makeMetadata({ metadata: {} }),
        []
      );
      expect(result.cost).toBeUndefined();
    });

    it('returns undefined cost when metadata is undefined', () => {
      const result = convertToLegacyConversation(
        makeMetadata({ metadata: undefined }),
        []
      );
      expect(result.cost).toBeUndefined();
    });
  });

  describe('metadata preservation', () => {
    it('preserves chatSettings with workspaceId and sessionId from top-level', () => {
      const result = convertToLegacyConversation(
        makeMetadata({
          workspaceId: 'ws-1',
          sessionId: 'sess-1',
          metadata: {
            chatSettings: { providerId: 'openai', modelId: 'gpt-5' },
          },
        }),
        []
      );
      expect(result.metadata?.chatSettings?.workspaceId).toBe('ws-1');
      expect(result.metadata?.chatSettings?.sessionId).toBe('sess-1');
    });

    it('preserves promptId from chatSettings over meta.promptId', () => {
      const result = convertToLegacyConversation(
        makeMetadata({
          metadata: {
            chatSettings: { promptId: 'prompt-from-settings' },
            promptId: 'prompt-from-meta',
          },
        }),
        []
      );
      expect(result.metadata?.chatSettings?.promptId).toBe('prompt-from-settings');
    });

    it('falls back to meta.promptId when chatSettings.promptId missing', () => {
      const result = convertToLegacyConversation(
        makeMetadata({
          metadata: {
            chatSettings: {},
            promptId: 'prompt-fallback',
          },
        }),
        []
      );
      expect(result.metadata?.chatSettings?.promptId).toBe('prompt-fallback');
    });

    it('preserves workflow metadata from top-level ConversationMetadata', () => {
      const result = convertToLegacyConversation(
        makeMetadata({
          workflowId: 'wf-1',
          runTrigger: 'scheduled',
          scheduledFor: 9999,
          runKey: 'key-abc',
        }),
        []
      );
      expect(result.metadata?.workflowId).toBe('wf-1');
      expect(result.metadata?.runTrigger).toBe('scheduled');
      expect(result.metadata?.scheduledFor).toBe(9999);
      expect(result.metadata?.runKey).toBe('key-abc');
    });

    it('preserves parentConversationId and branchType from stored metadata', () => {
      const result = convertToLegacyConversation(
        makeMetadata({
          metadata: {
            parentConversationId: 'parent-1',
            branchType: 'subagent',
          },
        }),
        []
      );
      expect(result.metadata?.parentConversationId).toBe('parent-1');
      expect(result.metadata?.branchType).toBe('subagent');
    });
  });
});

// ============================================================================
// convertToConversationBranch
// ============================================================================

describe('convertToConversationBranch', () => {
  it('converts a human branch conversation', () => {
    const branchConv: IndividualConversation = {
      id: 'branch-1',
      title: 'Branch title',
      created: 100,
      updated: 200,
      vault_name: 'vault',
      message_count: 1,
      messages: [
        { id: 'msg-1', role: 'user', content: 'hello', timestamp: 100, state: 'complete' },
      ],
      metadata: { branchType: 'alternative' },
    };
    const result = convertToConversationBranch(branchConv);

    expect(result.id).toBe('branch-1');
    expect(result.type).toBe('human');
    expect(result.inheritContext).toBe(true); // default for human
    expect(result.messages).toHaveLength(1);
    expect(result.metadata).toEqual({ description: 'Branch title' });
  });

  it('converts a subagent branch conversation with metadata', () => {
    const branchConv: IndividualConversation = {
      id: 'branch-2',
      title: 'Subagent Branch',
      created: 100,
      updated: 200,
      vault_name: 'vault',
      message_count: 0,
      messages: [],
      metadata: {
        branchType: 'subagent',
        subagent: {
          agentName: 'TestAgent',
          model: 'gpt-5-nano',
        },
      },
    };
    const result = convertToConversationBranch(branchConv);

    expect(result.type).toBe('subagent');
    expect(result.inheritContext).toBe(false); // explicit false for subagent not setting inheritContext
    expect(result.metadata).toEqual({ agentName: 'TestAgent', model: 'gpt-5-nano' });
  });

  it('defaults inheritContext to true for human when not set', () => {
    const branchConv: IndividualConversation = {
      id: 'branch-3',
      title: 'No inherit set',
      created: 100,
      updated: 200,
      vault_name: 'vault',
      message_count: 0,
      messages: [],
      metadata: {},
    };
    const result = convertToConversationBranch(branchConv);

    expect(result.type).toBe('human');
    expect(result.inheritContext).toBe(true);
  });

  it('respects explicit inheritContext from metadata', () => {
    const branchConv: IndividualConversation = {
      id: 'branch-4',
      title: 'Explicit inherit',
      created: 100,
      updated: 200,
      vault_name: 'vault',
      message_count: 0,
      messages: [],
      metadata: { inheritContext: false },
    };
    const result = convertToConversationBranch(branchConv);

    expect(result.inheritContext).toBe(false);
  });

  it('handles missing metadata gracefully', () => {
    const branchConv: IndividualConversation = {
      id: 'branch-5',
      title: 'No metadata',
      created: 100,
      updated: 200,
      vault_name: 'vault',
      message_count: 0,
      messages: [],
    };
    const result = convertToConversationBranch(branchConv);

    expect(result.type).toBe('human');
    expect(result.metadata).toEqual({ description: 'No metadata' });
  });
});

// ============================================================================
// populateMessageBranches
// ============================================================================

describe('populateMessageBranches', () => {
  it('returns immediately when no branch conversations', () => {
    const messages: ConversationMessage[] = [
      { id: 'msg-1', role: 'user', content: 'Hello', timestamp: 100, state: 'complete' },
    ];
    populateMessageBranches([], messages);
    expect(messages[0].branches).toBeUndefined();
  });

  it('attaches branches to matching parent messages', () => {
    const messages: ConversationMessage[] = [
      { id: 'msg-1', role: 'user', content: 'Hello', timestamp: 100, state: 'complete' },
      { id: 'msg-2', role: 'assistant', content: 'Hi', timestamp: 200, state: 'complete' },
    ];
    const branchConvs: IndividualConversation[] = [
      {
        id: 'branch-1',
        title: 'Branch',
        created: 300,
        updated: 300,
        vault_name: 'vault',
        message_count: 1,
        messages: [{ id: 'b-msg-1', role: 'assistant', content: 'Alt hi', timestamp: 300, state: 'complete' }],
        metadata: { parentMessageId: 'msg-2' },
      },
    ];

    populateMessageBranches(branchConvs, messages);

    expect(messages[0].branches).toBeUndefined();
    expect(messages[1].branches).toHaveLength(1);
    expect(messages[1].branches![0].id).toBe('branch-1');
    expect(messages[1].activeAlternativeIndex).toBe(0);
  });

  it('does not attach branches when parentMessageId is missing', () => {
    const messages: ConversationMessage[] = [
      { id: 'msg-1', role: 'user', content: 'Hello', timestamp: 100, state: 'complete' },
    ];
    const branchConvs: IndividualConversation[] = [
      {
        id: 'branch-1',
        title: 'Orphan',
        created: 300,
        updated: 300,
        vault_name: 'vault',
        message_count: 0,
        messages: [],
        metadata: {},
      },
    ];

    populateMessageBranches(branchConvs, messages);
    expect(messages[0].branches).toBeUndefined();
  });

  it('preserves existing activeAlternativeIndex', () => {
    const messages: ConversationMessage[] = [
      { id: 'msg-1', role: 'user', content: 'Hello', timestamp: 100, state: 'complete', activeAlternativeIndex: 2 },
    ];
    const branchConvs: IndividualConversation[] = [
      {
        id: 'branch-1',
        title: 'Branch',
        created: 300,
        updated: 300,
        vault_name: 'vault',
        message_count: 0,
        messages: [],
        metadata: { parentMessageId: 'msg-1' },
      },
    ];

    populateMessageBranches(branchConvs, messages);
    expect(messages[0].activeAlternativeIndex).toBe(2);
  });

  it('groups multiple branches to the same parent message', () => {
    const messages: ConversationMessage[] = [
      { id: 'msg-1', role: 'assistant', content: 'Original', timestamp: 100, state: 'complete' },
    ];
    const branchConvs: IndividualConversation[] = [
      {
        id: 'branch-1',
        title: 'Alt 1',
        created: 200,
        updated: 200,
        vault_name: 'vault',
        message_count: 0,
        messages: [],
        metadata: { parentMessageId: 'msg-1' },
      },
      {
        id: 'branch-2',
        title: 'Alt 2',
        created: 300,
        updated: 300,
        vault_name: 'vault',
        message_count: 0,
        messages: [],
        metadata: { parentMessageId: 'msg-1' },
      },
    ];

    populateMessageBranches(branchConvs, messages);
    expect(messages[0].branches).toHaveLength(2);
  });

  it('handles empty messages array', () => {
    const messages: ConversationMessage[] = [];
    const branchConvs: IndividualConversation[] = [
      {
        id: 'branch-1',
        title: 'Branch',
        created: 200,
        updated: 200,
        vault_name: 'vault',
        message_count: 0,
        messages: [],
        metadata: { parentMessageId: 'msg-1' },
      },
    ];

    // Should not throw
    populateMessageBranches(branchConvs, messages);
  });
});
