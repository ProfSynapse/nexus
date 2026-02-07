/**
 * Location: src/services/embeddings/QAPairBuilder.ts
 * Purpose: Pure function that converts conversation messages into QA pairs for embedding.
 *
 * Produces two types of QA pairs:
 * 1. Conversation turns: user message (Q) paired with assistant response (A)
 * 2. Trace pairs: tool invocation (Q) paired with tool result (A)
 *
 * Each QA pair has a unique pairId and contentHash for change detection.
 * The pairs are the unit of embedding -- Q and A are chunked independently by
 * ContentChunker, but all chunks share the same pairId. On search match,
 * the full Q + full A are returned to the LLM.
 *
 * Used by:
 * - ConversationEmbeddingWatcher: real-time embedding of completed messages
 * - IndexingQueue: backfill embedding of existing conversations
 * - EmbeddingService: conversation embedding pipeline
 *
 * Relationships:
 * - Consumes MessageData from src/types/storage/HybridStorageTypes.ts
 * - Output QAPairs are consumed by ContentChunker and EmbeddingService
 */

import type { MessageData, ToolCall } from '../../types/storage/HybridStorageTypes';

/**
 * A question-answer pair extracted from a conversation.
 *
 * Represents either a user-assistant turn or a tool invocation-result pair.
 * The pair is the atomic unit for conversation embedding and retrieval.
 */
export interface QAPair {
  /** Unique identifier: `${conversationId}:${startSequenceNumber}` */
  pairId: string;
  /** ID of the conversation this pair belongs to */
  conversationId: string;
  /** Sequence number of the first message in this pair (the question) */
  startSequenceNumber: number;
  /** Sequence number of the last message in this pair (the answer) */
  endSequenceNumber: number;
  /** Whether this is a conversation turn or tool trace */
  pairType: 'conversation_turn' | 'trace_pair';
  /** Source message ID (user messageId for turns, assistant messageId for traces) */
  sourceId: string;
  /** Full question text: user message content or tool invocation description */
  question: string;
  /** Full answer text: assistant response or tool result content */
  answer: string;
  /** Hash of question + answer for change detection */
  contentHash: string;
  /** Workspace this conversation belongs to (if known) */
  workspaceId?: string;
  /** Session this conversation belongs to (if known) */
  sessionId?: string;
}

/**
 * DJB2 hash function for string content.
 *
 * A fast, deterministic, non-cryptographic hash suitable for change detection.
 * Produces a hex string from the hash value. Collisions are acceptable since
 * this is only used to detect when content has changed, not for security.
 *
 * @param input - The string to hash
 * @returns Hex string representation of the hash
 */
export function hashContent(input: string): string {
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    // hash * 33 + charCode (using bit shift for multiplication)
    hash = ((hash << 5) + hash + input.charCodeAt(i)) | 0;
  }
  // Convert to unsigned 32-bit integer, then to hex string
  return (hash >>> 0).toString(16);
}

/**
 * Formats a tool call invocation as a human-readable question string.
 *
 * The format matches the plan specification:
 * `Tool: ${toolName}(${JSON.stringify(args)})`
 *
 * @param toolCall - The tool call to format
 * @returns Formatted tool invocation string
 */
function formatToolCallQuestion(toolCall: ToolCall): string {
  const toolName = toolCall.function?.name || toolCall.name || 'unknown';

  let args: string;
  if (toolCall.function?.arguments) {
    // function.arguments is a JSON string per OpenAI format
    args = toolCall.function.arguments;
  } else if (toolCall.parameters) {
    args = JSON.stringify(toolCall.parameters);
  } else {
    args = '{}';
  }

  return `Tool: ${toolName}(${args})`;
}

/**
 * Extracts the content string from a tool result message.
 *
 * Tool result messages store their content as a string. If content is null
 * or empty, a fallback description is returned.
 *
 * @param message - The tool result message (role='tool')
 * @returns The tool result content string
 */
function extractToolResultContent(message: MessageData): string {
  if (message.content) {
    return message.content;
  }
  return '[No tool result content]';
}

/**
 * Converts an array of conversation messages into QA pairs.
 *
 * Processing rules:
 * 1. Messages are sorted by sequenceNumber before processing.
 * 2. System messages (role='system') are always skipped.
 * 3. Conversation turns: Each user message is paired with the next assistant message.
 *    Intermediate tool messages between user and assistant are skipped when looking
 *    for the assistant response.
 * 4. Tool traces: When an assistant message contains toolCalls, each tool call is
 *    paired with its corresponding tool result message (matched by toolCallId).
 * 5. Orphan messages (user without a following assistant) are skipped.
 * 6. Only messages with state='complete' are processed (others are in-progress or failed).
 *
 * @param messages - Array of MessageData from a conversation
 * @param conversationId - The conversation these messages belong to
 * @param workspaceId - Optional workspace ID for metadata
 * @param sessionId - Optional session ID for metadata
 * @returns Array of QAPair objects
 */
export function buildQAPairs(
  messages: MessageData[],
  conversationId: string,
  workspaceId?: string,
  sessionId?: string
): QAPair[] {
  if (!messages || messages.length === 0) {
    return [];
  }

  // Sort by sequence number to ensure correct ordering
  const sorted = [...messages]
    .filter(isProcessableMessage)
    .sort((a, b) => a.sequenceNumber - b.sequenceNumber);

  const pairs: QAPair[] = [];

  // Build a lookup map for tool result messages: toolCallId -> message
  const toolResultsByCallId = new Map<string, MessageData>();
  for (const msg of sorted) {
    if (msg.role === 'tool' && msg.toolCallId) {
      toolResultsByCallId.set(msg.toolCallId, msg);
    }
  }

  for (let i = 0; i < sorted.length; i++) {
    const message = sorted[i];

    // Skip system and tool messages at the top level
    if (message.role === 'system' || message.role === 'tool') {
      continue;
    }

    // Conversation turn: user message paired with next assistant message
    if (message.role === 'user') {
      const assistantMessage = findNextAssistantMessage(sorted, i);
      if (assistantMessage) {
        const question = message.content || '';
        const answer = assistantMessage.content || '';

        pairs.push({
          pairId: `${conversationId}:${message.sequenceNumber}`,
          conversationId,
          startSequenceNumber: message.sequenceNumber,
          endSequenceNumber: assistantMessage.sequenceNumber,
          pairType: 'conversation_turn',
          sourceId: message.id,
          question,
          answer,
          contentHash: hashContent(question + answer),
          workspaceId,
          sessionId,
        });
      }
      continue;
    }

    // Tool traces: assistant message with tool calls
    if (message.role === 'assistant' && message.toolCalls && message.toolCalls.length > 0) {
      for (const toolCall of message.toolCalls) {
        const toolResult = toolResultsByCallId.get(toolCall.id);
        if (toolResult) {
          const question = formatToolCallQuestion(toolCall);
          const answer = extractToolResultContent(toolResult);

          pairs.push({
            pairId: `${conversationId}:${message.sequenceNumber}:${toolCall.id}`,
            conversationId,
            startSequenceNumber: message.sequenceNumber,
            endSequenceNumber: toolResult.sequenceNumber,
            pairType: 'trace_pair',
            sourceId: message.id,
            question,
            answer,
            contentHash: hashContent(question + answer),
            workspaceId,
            sessionId,
          });
        }
      }
    }
  }

  return pairs;
}

/**
 * Checks whether a message should be included in QA pair processing.
 *
 * Filters out messages that are still streaming, have been aborted,
 * or are otherwise incomplete.
 *
 * @param message - The message to check
 * @returns true if the message should be processed
 */
function isProcessableMessage(message: MessageData): boolean {
  // Only process complete messages
  if (message.state && message.state !== 'complete') {
    return false;
  }
  return true;
}

/**
 * Finds the next assistant message after the given index, skipping tool messages.
 *
 * Scans forward from index + 1 looking for the first message with role='assistant'.
 * Stops at the next user message to avoid pairing across conversation turns.
 *
 * @param messages - Sorted array of messages
 * @param fromIndex - Index of the user message to find a response for
 * @returns The matching assistant message, or undefined if none found
 */
function findNextAssistantMessage(
  messages: MessageData[],
  fromIndex: number
): MessageData | undefined {
  for (let j = fromIndex + 1; j < messages.length; j++) {
    const candidate = messages[j];

    // Found the assistant response
    if (candidate.role === 'assistant') {
      return candidate;
    }

    // Hit another user message -- the original user message is orphaned
    if (candidate.role === 'user') {
      return undefined;
    }

    // Skip tool and system messages (they appear between user and assistant)
  }
  return undefined;
}
