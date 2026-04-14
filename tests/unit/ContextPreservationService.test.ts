/**
 * ContextPreservationService Unit Tests
 *
 * Coverage:
 *   - serializeMessagesToTranscript: converts messages to [User]/[Assistant] text format
 *     - Skips tool-role messages
 *     - Skips messages with empty/whitespace-only content
 *     - Labels user and assistant messages correctly
 *     - Joins with double newlines
 *   - attemptStateSave wraps transcript in a single user message
 *     (integration-level, tested via mock LLM)
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import type { ConversationMessage } from '../../src/types/chat/ChatTypes';
import { ContextPreservationService } from '../../src/services/chat/ContextPreservationService';

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

/**
 * Access the private serializeMessagesToTranscript method via type cast.
 * The method is a pure function operating on an array of messages, so
 * testing it directly gives precise coverage of the serialization logic.
 */
function callSerialize(svc: ContextPreservationService, messages: ConversationMessage[]): string {
  return (svc as any).serializeMessagesToTranscript(messages);
}

// Create a minimal ContextPreservationService with mock dependencies.
// We only need the instance for accessing serializeMessagesToTranscript.
function createService(): ContextPreservationService {
  const mockDeps = {
    llmService: {
      generateResponseStream: jest.fn(),
    },
    getAgent: jest.fn().mockReturnValue(null),
    executeToolCalls: jest.fn().mockResolvedValue([]),
  };
  return new ContextPreservationService(mockDeps as any);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ContextPreservationService — serializeMessagesToTranscript', () => {
  let svc: ContextPreservationService;

  beforeEach(() => {
    svc = createService();
  });

  it('serializes user and assistant messages with correct labels', () => {
    const messages = [
      makeMsg({ id: 'u1', role: 'user', content: 'Hello world' }),
      makeMsg({ id: 'a1', role: 'assistant', content: 'Hi there' }),
    ];

    const result = callSerialize(svc, messages);

    expect(result).toBe('[User]: Hello world\n\n[Assistant]: Hi there');
  });

  it('skips tool-role messages', () => {
    const messages = [
      makeMsg({ id: 'u1', role: 'user', content: 'Search for files' }),
      makeMsg({ id: 'a1', role: 'assistant', content: 'Searching...' }),
      makeMsg({ id: 't1', role: 'tool', content: 'Found 3 files' }),
      makeMsg({ id: 'u2', role: 'user', content: 'Thanks' }),
    ];

    const result = callSerialize(svc, messages);

    expect(result).not.toContain('Found 3 files');
    expect(result).toContain('[User]: Search for files');
    expect(result).toContain('[Assistant]: Searching...');
    expect(result).toContain('[User]: Thanks');
  });

  it('skips messages with empty content', () => {
    const messages = [
      makeMsg({ id: 'u1', role: 'user', content: 'Hello' }),
      makeMsg({ id: 'a1', role: 'assistant', content: '' }),
      makeMsg({ id: 'u2', role: 'user', content: 'Are you there?' }),
    ];

    const result = callSerialize(svc, messages);

    expect(result).toBe('[User]: Hello\n\n[User]: Are you there?');
  });

  it('skips messages with whitespace-only content', () => {
    const messages = [
      makeMsg({ id: 'u1', role: 'user', content: 'Hello' }),
      makeMsg({ id: 'a1', role: 'assistant', content: '   \n  \t  ' }),
      makeMsg({ id: 'u2', role: 'user', content: 'Still here' }),
    ];

    const result = callSerialize(svc, messages);

    expect(result).toBe('[User]: Hello\n\n[User]: Still here');
  });

  it('returns empty string for no valid messages', () => {
    const messages = [
      makeMsg({ id: 't1', role: 'tool', content: 'Tool result' }),
      makeMsg({ id: 'a1', role: 'assistant', content: '' }),
    ];

    const result = callSerialize(svc, messages);

    expect(result).toBe('');
  });

  it('returns empty string for empty array', () => {
    const result = callSerialize(svc, []);

    expect(result).toBe('');
  });

  it('handles system messages as assistant-labeled', () => {
    const messages = [
      makeMsg({ id: 's1', role: 'system', content: 'You are helpful' }),
      makeMsg({ id: 'u1', role: 'user', content: 'Hello' }),
    ];

    const result = callSerialize(svc, messages);

    // system role is not 'user' so it gets the Assistant label
    expect(result).toContain('[Assistant]: You are helpful');
    expect(result).toContain('[User]: Hello');
  });

  it('preserves multi-line content within messages', () => {
    const messages = [
      makeMsg({ id: 'u1', role: 'user', content: 'Line one\nLine two\nLine three' }),
    ];

    const result = callSerialize(svc, messages);

    expect(result).toBe('[User]: Line one\nLine two\nLine three');
  });

  it('handles multiple consecutive user messages', () => {
    const messages = [
      makeMsg({ id: 'u1', role: 'user', content: 'First message' }),
      makeMsg({ id: 'u2', role: 'user', content: 'Second message' }),
    ];

    const result = callSerialize(svc, messages);

    expect(result).toBe('[User]: First message\n\n[User]: Second message');
  });
});

describe('ContextPreservationService — attemptStateSave transcript wrapping', () => {
  it('wraps conversation into a single user-role message for the LLM', async () => {
    let capturedMessages: ConversationMessage[] = [];

    const mockDeps = {
      llmService: {
        generateResponseStream: jest.fn().mockImplementation(function* (msgs: ConversationMessage[]) {
          capturedMessages = msgs;
          yield {
            chunk: '',
            complete: true,
            toolCalls: [{
              id: 'tc1',
              function: { name: 'createState', arguments: JSON.stringify({ id: 'state1', content: 'saved' }) },
            }],
          };
        }),
      },
      getAgent: jest.fn().mockReturnValue({
        getTool: jest.fn().mockReturnValue({
          description: 'Create state',
          getParameterSchema: jest.fn().mockReturnValue({ type: 'object' }),
        }),
      }),
      executeToolCalls: jest.fn().mockResolvedValue([{ success: true }]),
    };

    const svc = new ContextPreservationService(mockDeps as any);

    const messages = [
      makeMsg({ id: 'u1', role: 'user', content: 'Question' }),
      makeMsg({ id: 'a1', role: 'assistant', content: 'Answer' }),
    ];

    await svc.forceStateSave(messages, {}, {});

    // The LLM should receive a single wrapped user message
    expect(capturedMessages.length).toBe(1);
    expect(capturedMessages[0].role).toBe('user');
    expect(capturedMessages[0].content).toContain('[User]: Question');
    expect(capturedMessages[0].content).toContain('[Assistant]: Answer');
  });
});
