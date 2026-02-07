/**
 * Location: src/services/embeddings/ConversationEmbeddingWatcher.ts
 * Purpose: Real-time indexing of completed conversation turns into the
 * conversation embedding pipeline.
 *
 * Watches for assistant messages that reach state='complete' via the
 * MessageRepository callback hook, finds the corresponding user message,
 * builds a QA pair, and embeds it using EmbeddingService.
 *
 * Also embeds tool trace pairs when the assistant message contains toolCalls.
 * For each tool call, the tool invocation (Q) and tool result (A) are paired
 * and embedded using the same pattern as QAPairBuilder.buildQAPairs.
 *
 * Skip conditions:
 * - Non-assistant messages (only assistant completions trigger embedding)
 * - Non-complete messages (still streaming, aborted, etc.)
 * - Branch conversations (parentConversationId is set)
 * - Messages without text content (pure tool-call-only messages)
 *
 * Related Files:
 * - src/database/repositories/MessageRepository.ts - Provides onMessageComplete hook
 * - src/services/embeddings/EmbeddingService.ts - embedConversationTurn() for storage
 * - src/services/embeddings/QAPairBuilder.ts - QAPair type and hashContent utility
 * - src/services/embeddings/EmbeddingManager.ts - Lifecycle owner (start/stop)
 */

import type { MessageData, ToolCall } from '../../types/storage/HybridStorageTypes';
import type { IMessageRepository } from '../../database/repositories/interfaces/IMessageRepository';
import type { EmbeddingService } from './EmbeddingService';
import type { SQLiteCacheManager } from '../../database/storage/SQLiteCacheManager';
import { hashContent } from './QAPairBuilder';
import type { QAPair } from './QAPairBuilder';

/**
 * Watches for completed assistant messages and embeds them as QA pairs.
 *
 * Lifecycle:
 * - Created by EmbeddingManager during initialization
 * - start() registers the onMessageComplete callback on MessageRepository
 * - stop() unregisters the callback and cleans up
 *
 * The watcher operates asynchronously -- embedding happens in the background
 * without blocking the message write path. Errors during embedding are caught
 * and logged; they do not propagate to the message pipeline.
 */
export class ConversationEmbeddingWatcher {
  private readonly embeddingService: EmbeddingService;
  private readonly messageRepository: IMessageRepository;
  private readonly db: SQLiteCacheManager;
  private unsubscribe: (() => void) | null = null;

  /** Tracks in-flight pair IDs to prevent redundant concurrent embedding */
  private readonly inFlightPairIds: Set<string> = new Set();

  constructor(
    embeddingService: EmbeddingService,
    messageRepository: IMessageRepository,
    db: SQLiteCacheManager
  ) {
    this.embeddingService = embeddingService;
    this.messageRepository = messageRepository;
    this.db = db;
  }

  /**
   * Start watching for completed assistant messages.
   * Registers the onMessageComplete callback on MessageRepository.
   * Safe to call multiple times -- subsequent calls are no-ops.
   */
  start(): void {
    if (this.unsubscribe) {
      return; // Already watching
    }

    this.unsubscribe = this.messageRepository.onMessageComplete(
      (message: MessageData) => {
        // Fire-and-forget: do not block the write path
        this.handleMessageComplete(message).catch(error => {
          console.error(
            '[ConversationEmbeddingWatcher] Failed to handle message complete:',
            error
          );
        });
      }
    );
  }

  /**
   * Stop watching for completed messages.
   * Unregisters the callback. Safe to call multiple times.
   */
  stop(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
  }

  /**
   * Handle a completed message by building a QA pair and embedding it.
   *
   * Only processes assistant messages with text content that belong to
   * non-branch conversations. The corresponding user message is found
   * by scanning backwards from the assistant's sequence number.
   *
   * Also embeds tool trace pairs when the assistant message contains toolCalls.
   */
  private async handleMessageComplete(message: MessageData): Promise<void> {
    // Skip condition: only process assistant messages
    if (message.role !== 'assistant') {
      return;
    }

    // Skip condition: only process complete messages
    if (message.state !== 'complete') {
      return;
    }

    // Skip condition: branch conversations (subagent branches, alternatives)
    const isBranch = await this.isConversationBranch(message.conversationId);
    if (isBranch) {
      return;
    }

    // Get conversation metadata for workspace/session context
    const convMeta = await this.db.queryOne<{
      workspaceId: string | null;
      sessionId: string | null;
    }>(
      'SELECT workspaceId, sessionId FROM conversations WHERE id = ?',
      [message.conversationId]
    );

    // Embed conversation turn QA pair (if the message has text content)
    if (message.content && message.content.trim().length > 0) {
      await this.embedConversationTurn(message, convMeta);
    }

    // Embed tool trace pairs (if the message has tool calls)
    if (message.toolCalls && message.toolCalls.length > 0) {
      await this.embedToolTraces(message, convMeta);
    }
  }

  /**
   * Embed a conversation turn QA pair: user question paired with assistant answer.
   */
  private async embedConversationTurn(
    message: MessageData,
    convMeta: { workspaceId: string | null; sessionId: string | null } | null
  ): Promise<void> {
    // Find the corresponding user message by looking backwards
    const userMessage = await this.findPrecedingUserMessage(
      message.conversationId,
      message.sequenceNumber
    );

    if (!userMessage || !userMessage.content) {
      return; // No user message found or empty user message
    }

    const question = userMessage.content;
    const answer = message.content!;
    const pairId = `${message.conversationId}:${userMessage.sequenceNumber}`;

    // Dedup check: skip if this pair is already being embedded
    if (this.inFlightPairIds.has(pairId)) {
      return;
    }

    this.inFlightPairIds.add(pairId);
    try {
      const qaPair: QAPair = {
        pairId,
        conversationId: message.conversationId,
        startSequenceNumber: userMessage.sequenceNumber,
        endSequenceNumber: message.sequenceNumber,
        pairType: 'conversation_turn',
        sourceId: userMessage.id,
        question,
        answer,
        contentHash: hashContent(question + answer),
        workspaceId: convMeta?.workspaceId ?? undefined,
        sessionId: convMeta?.sessionId ?? undefined,
      };

      await this.embeddingService.embedConversationTurn(qaPair);
    } finally {
      this.inFlightPairIds.delete(pairId);
    }
  }

  /**
   * Embed tool trace pairs from the assistant message's tool calls.
   *
   * For each tool call, finds the corresponding tool result message
   * (role='tool', matching toolCallId) and builds a trace_pair QA pair:
   * - Q: Tool invocation description (`Tool: name(args)`)
   * - A: Tool result content
   *
   * Follows the same pattern as QAPairBuilder.buildQAPairs for trace pairs.
   */
  private async embedToolTraces(
    message: MessageData,
    convMeta: { workspaceId: string | null; sessionId: string | null } | null
  ): Promise<void> {
    if (!message.toolCalls) return;

    // Fetch messages following the assistant message to find tool results
    // Tool results typically appear immediately after the assistant message
    const followingMessages = await this.messageRepository.getMessagesBySequenceRange(
      message.conversationId,
      message.sequenceNumber + 1,
      message.sequenceNumber + 50  // Look ahead up to 50 messages for tool results
    );

    // Build a lookup map: toolCallId -> tool result message
    const toolResultsByCallId = new Map<string, MessageData>();
    for (const msg of followingMessages) {
      if (msg.role === 'tool' && msg.toolCallId) {
        toolResultsByCallId.set(msg.toolCallId, msg);
      }
    }

    for (const toolCall of message.toolCalls) {
      const toolResult = toolResultsByCallId.get(toolCall.id);
      if (!toolResult) {
        continue; // No matching tool result found
      }

      const question = this.formatToolCallQuestion(toolCall);
      const answer = toolResult.content || '[No tool result content]';
      const pairId = `${message.conversationId}:${message.sequenceNumber}:${toolCall.id}`;

      // Dedup check
      if (this.inFlightPairIds.has(pairId)) {
        continue;
      }

      this.inFlightPairIds.add(pairId);
      try {
        const qaPair: QAPair = {
          pairId,
          conversationId: message.conversationId,
          startSequenceNumber: message.sequenceNumber,
          endSequenceNumber: toolResult.sequenceNumber,
          pairType: 'trace_pair',
          sourceId: message.id,
          question,
          answer,
          contentHash: hashContent(question + answer),
          workspaceId: convMeta?.workspaceId ?? undefined,
          sessionId: convMeta?.sessionId ?? undefined,
        };

        await this.embeddingService.embedConversationTurn(qaPair);
      } finally {
        this.inFlightPairIds.delete(pairId);
      }
    }
  }

  /**
   * Format a tool call invocation as a human-readable question string.
   * Matches the format used in QAPairBuilder.
   */
  private formatToolCallQuestion(toolCall: ToolCall): string {
    const toolName = toolCall.function?.name || toolCall.name || 'unknown';

    let args: string;
    if (toolCall.function?.arguments) {
      args = toolCall.function.arguments;
    } else if (toolCall.parameters) {
      args = JSON.stringify(toolCall.parameters);
    } else {
      args = '{}';
    }

    return `Tool: ${toolName}(${args})`;
  }

  /**
   * Check if a conversation is a branch (has a parent conversation).
   * Branch conversations should not be embedded independently since they
   * are variants of the parent conversation.
   */
  private async isConversationBranch(conversationId: string): Promise<boolean> {
    const conv = await this.db.queryOne<{ metadataJson: string | null }>(
      'SELECT metadataJson FROM conversations WHERE id = ?',
      [conversationId]
    );

    if (!conv || !conv.metadataJson) {
      return false;
    }

    try {
      const metadata = JSON.parse(conv.metadataJson) as Record<string, unknown>;
      return !!metadata.parentConversationId;
    } catch {
      return false;
    }
  }

  /**
   * Find the user message preceding an assistant message in the same conversation.
   * Scans backwards from the assistant's sequence number, skipping tool messages.
   *
   * @param conversationId - The conversation to search
   * @param assistantSeqNum - The assistant message's sequence number
   * @returns The preceding user message, or null if not found
   */
  private async findPrecedingUserMessage(
    conversationId: string,
    assistantSeqNum: number
  ): Promise<MessageData | null> {
    // Look backwards from the assistant message (up to 20 messages back to handle
    // tool call chains between user and assistant)
    const startSeq = Math.max(0, assistantSeqNum - 20);

    const messages = await this.messageRepository.getMessagesBySequenceRange(
      conversationId,
      startSeq,
      assistantSeqNum - 1
    );

    // Scan backwards to find the most recent user message
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') {
        return messages[i];
      }
    }

    return null;
  }
}
