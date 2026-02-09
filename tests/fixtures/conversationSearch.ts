/**
 * Conversation Search Test Fixtures
 *
 * Provides test data for ContentChunker, QAPairBuilder,
 * ConversationWindowRetriever, and ConversationEmbeddingWatcher tests.
 *
 * Uses realistic conversation content reflecting actual Obsidian plugin usage.
 */

import type { MessageData, ToolCall } from '../../src/types/storage/HybridStorageTypes';

// ============================================================================
// Message Factory
// ============================================================================

let messageIdCounter = 0;

/**
 * Creates a MessageData object with sensible defaults.
 * Overrides can be passed to customize any field.
 */
export function createMessage(overrides: Partial<MessageData> = {}): MessageData {
  messageIdCounter++;
  return {
    id: `msg-${messageIdCounter}`,
    conversationId: 'conv-test-001',
    role: 'user',
    content: '',
    timestamp: Date.now(),
    state: 'complete',
    sequenceNumber: 0,
    ...overrides,
  };
}

/**
 * Resets the message ID counter between tests.
 */
export function resetMessageIdCounter(): void {
  messageIdCounter = 0;
}

// ============================================================================
// Conversation IDs
// ============================================================================

export const CONVERSATION_IDS = {
  simple: 'conv-simple-001',
  withTools: 'conv-tools-001',
  long: 'conv-long-001',
  branch: 'conv-branch-001',
  empty: 'conv-empty-001',
};

export const WORKSPACE_IDS = {
  default: 'ws-default-001',
  project: 'ws-project-alpha',
};

export const SESSION_IDS = {
  current: 'sess-current-001',
  previous: 'sess-previous-001',
};

// ============================================================================
// Simple Conversation (user + assistant turns)
// ============================================================================

export const SIMPLE_CONVERSATION: MessageData[] = [
  createMessage({
    id: 'msg-s1',
    conversationId: CONVERSATION_IDS.simple,
    role: 'user',
    content: 'How do I create a new note in Obsidian using the API?',
    sequenceNumber: 0,
    state: 'complete',
  }),
  createMessage({
    id: 'msg-s2',
    conversationId: CONVERSATION_IDS.simple,
    role: 'assistant',
    content: 'You can create a new note using `app.vault.create(path, content)`. This returns a TFile object representing the new file. Make sure the path includes the `.md` extension.',
    sequenceNumber: 1,
    state: 'complete',
  }),
  createMessage({
    id: 'msg-s3',
    conversationId: CONVERSATION_IDS.simple,
    role: 'user',
    content: 'What about creating a note in a specific folder?',
    sequenceNumber: 2,
    state: 'complete',
  }),
  createMessage({
    id: 'msg-s4',
    conversationId: CONVERSATION_IDS.simple,
    role: 'assistant',
    content: 'For a specific folder, use the full path like `app.vault.create("folder/subfolder/note.md", content)`. If the folder does not exist, you need to create it first with `app.vault.createFolder("folder/subfolder")`.',
    sequenceNumber: 3,
    state: 'complete',
  }),
];

// ============================================================================
// Conversation with Tool Calls
// ============================================================================

export const TOOL_CALLS: ToolCall[] = [
  {
    id: 'tc-001',
    type: 'function',
    function: {
      name: 'searchContent',
      arguments: '{"query":"vault API","limit":5}',
    },
  },
  {
    id: 'tc-002',
    type: 'function',
    function: {
      name: 'readContent',
      arguments: '{"path":"docs/api-reference.md"}',
    },
  },
];

export const TOOL_CONVERSATION: MessageData[] = [
  createMessage({
    id: 'msg-t1',
    conversationId: CONVERSATION_IDS.withTools,
    role: 'user',
    content: 'Search for information about the vault API and read the reference doc.',
    sequenceNumber: 0,
    state: 'complete',
  }),
  createMessage({
    id: 'msg-t2',
    conversationId: CONVERSATION_IDS.withTools,
    role: 'assistant',
    content: 'I will search for vault API information and read the reference documentation.',
    sequenceNumber: 1,
    state: 'complete',
    toolCalls: TOOL_CALLS,
  }),
  createMessage({
    id: 'msg-t3',
    conversationId: CONVERSATION_IDS.withTools,
    role: 'tool',
    content: '{"results":[{"path":"docs/vault-api.md","score":0.95}]}',
    sequenceNumber: 2,
    state: 'complete',
    toolCallId: 'tc-001',
  }),
  createMessage({
    id: 'msg-t4',
    conversationId: CONVERSATION_IDS.withTools,
    role: 'tool',
    content: '# Vault API Reference\n\nThe Vault class provides methods for reading and writing files...',
    sequenceNumber: 3,
    state: 'complete',
    toolCallId: 'tc-002',
  }),
  createMessage({
    id: 'msg-t5',
    conversationId: CONVERSATION_IDS.withTools,
    role: 'assistant',
    content: 'Based on the search results and the API reference, the Vault class provides several key methods for file operations including `read()`, `create()`, and `modify()`.',
    sequenceNumber: 4,
    state: 'complete',
  }),
];

// ============================================================================
// Conversation with Mixed States
// ============================================================================

export const MIXED_STATE_CONVERSATION: MessageData[] = [
  createMessage({
    id: 'msg-m1',
    conversationId: 'conv-mixed-001',
    role: 'user',
    content: 'What is the best way to handle settings?',
    sequenceNumber: 0,
    state: 'complete',
  }),
  createMessage({
    id: 'msg-m2',
    conversationId: 'conv-mixed-001',
    role: 'assistant',
    content: 'Still thinking about this...',
    sequenceNumber: 1,
    state: 'streaming',
  }),
  createMessage({
    id: 'msg-m3',
    conversationId: 'conv-mixed-001',
    role: 'user',
    content: 'Never mind, how about plugin lifecycle?',
    sequenceNumber: 2,
    state: 'complete',
  }),
  createMessage({
    id: 'msg-m4',
    conversationId: 'conv-mixed-001',
    role: 'assistant',
    content: 'The plugin lifecycle revolves around onload() and onunload() methods.',
    sequenceNumber: 3,
    state: 'complete',
  }),
];

// ============================================================================
// Long Conversation (for window retrieval testing)
// ============================================================================

/**
 * Creates a long conversation with N user-assistant turn pairs.
 * Sequence numbers go from 0 to (turns * 2 - 1).
 */
export function createLongConversation(
  turns: number,
  conversationId: string = CONVERSATION_IDS.long
): MessageData[] {
  const messages: MessageData[] = [];
  for (let i = 0; i < turns; i++) {
    messages.push(
      createMessage({
        id: `msg-long-user-${i}`,
        conversationId,
        role: 'user',
        content: `Question ${i + 1}: How do I implement feature ${i + 1}?`,
        sequenceNumber: i * 2,
        state: 'complete',
      }),
      createMessage({
        id: `msg-long-asst-${i}`,
        conversationId,
        role: 'assistant',
        content: `To implement feature ${i + 1}, you should follow these steps: first set up the configuration, then implement the core logic, and finally add tests.`,
        sequenceNumber: i * 2 + 1,
        state: 'complete',
      })
    );
  }
  return messages;
}

// ============================================================================
// Content Chunks for Chunker Testing
// ============================================================================

export const CHUNK_CONTENT = {
  /** Empty string */
  empty: '',

  /** Whitespace only */
  whitespace: '   \n\t  \n  ',

  /** Short content (under default 500 char limit) */
  short: 'This is a short piece of text that fits in a single chunk without any splitting needed.',

  /** Exactly 500 chars */
  exact500: 'A'.repeat(500),

  /** Just over 500 chars (needs 2 chunks) */
  just_over: 'A'.repeat(501),

  /** 1000 chars (needs multiple chunks with overlap) */
  medium: 'A'.repeat(1000),

  /** Content that produces a tiny trailing remainder */
  tiny_remainder: 'A'.repeat(850), // stride=400, first chunk at 0, second starts at 400, remainder from 800 = 50 chars

  /** Realistic markdown content */
  markdown: `# Obsidian Plugin Development Guide

## Getting Started

Obsidian plugins are built using TypeScript and the Obsidian API. The main entry point is a class that extends the Plugin base class. You must implement the onload() and onunload() lifecycle methods.

## File Operations

The Vault API provides methods for reading and writing files. Use vault.read() for reading file content and vault.create() for creating new files. For atomic modifications, use vault.process() which prevents race conditions.

## UI Components

Obsidian provides several UI primitives including Modal, Setting, and Notice. Modals are used for dialog boxes, Settings for configuration panels, and Notices for toast notifications. Always use CSS variables for theming compatibility.

## Event Handling

Register events using this.registerEvent() for Obsidian events and this.registerDomEvent() for DOM events. Both methods automatically clean up on plugin unload, preventing memory leaks.`,

  /** Very long content for stress testing */
  long: 'X'.repeat(3000),
};

// ============================================================================
// System Messages (should be skipped by QAPairBuilder)
// ============================================================================

export const SYSTEM_MESSAGE: MessageData = createMessage({
  id: 'msg-sys-1',
  conversationId: CONVERSATION_IDS.simple,
  role: 'system',
  content: 'You are a helpful assistant for Obsidian plugin development.',
  sequenceNumber: -1, // system messages often come first
  state: 'complete',
});

// ============================================================================
// Orphan User Message (no assistant response)
// ============================================================================

export const ORPHAN_CONVERSATION: MessageData[] = [
  createMessage({
    id: 'msg-o1',
    conversationId: 'conv-orphan-001',
    role: 'user',
    content: 'Can you help me with something?',
    sequenceNumber: 0,
    state: 'complete',
  }),
  // No assistant response follows
];

// ============================================================================
// Messages with Null Content
// ============================================================================

export const NULL_CONTENT_MESSAGES: MessageData[] = [
  createMessage({
    id: 'msg-nc1',
    conversationId: 'conv-null-001',
    role: 'user',
    content: 'Run a search for me',
    sequenceNumber: 0,
    state: 'complete',
  }),
  createMessage({
    id: 'msg-nc2',
    conversationId: 'conv-null-001',
    role: 'assistant',
    content: null, // pure tool-call message with no text
    sequenceNumber: 1,
    state: 'complete',
    toolCalls: [TOOL_CALLS[0]],
  }),
];

// ============================================================================
// Unsorted Messages (QAPairBuilder should sort)
// ============================================================================

export const UNSORTED_CONVERSATION: MessageData[] = [
  createMessage({
    id: 'msg-u2',
    conversationId: 'conv-unsorted-001',
    role: 'assistant',
    content: 'Here is the answer to your question about settings.',
    sequenceNumber: 1,
    state: 'complete',
  }),
  createMessage({
    id: 'msg-u1',
    conversationId: 'conv-unsorted-001',
    role: 'user',
    content: 'How do I save settings in an Obsidian plugin?',
    sequenceNumber: 0,
    state: 'complete',
  }),
];
