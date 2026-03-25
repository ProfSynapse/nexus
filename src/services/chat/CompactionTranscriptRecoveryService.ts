import type { App } from 'obsidian';
import type {
  ConversationEvent,
  AlternativeMessageEvent,
  MessageEvent,
  MessageUpdatedEvent
} from '../../database/interfaces/StorageEvents';
import type { IMessageRepository } from '../../database/repositories/interfaces/IMessageRepository';
import type { AlternativeMessage, MessageData, ToolCall } from '../../types/storage/HybridStorageTypes';
import type { CompactedTranscriptCoverageRef } from './ContextCompactionService';

type TranscriptLookupRepository = Pick<IMessageRepository, 'getMessages'>;

export class CompactionTranscriptRecoveryService {
  private static readonly PAGE_SIZE = 200;

  constructor(
    private readonly messageRepository: TranscriptLookupRepository,
    private readonly app: App
  ) {}

  /**
   * Build an exact transcript coverage ref for the compacted messages by resolving
   * their stored sequence numbers from the live message repository before compaction
   * deletes them from the active conversation view.
   */
  async buildCoverageRef(
    conversationId: string,
    compactedMessageIds: string[]
  ): Promise<CompactedTranscriptCoverageRef | null> {
    if (!conversationId || compactedMessageIds.length === 0) {
      return null;
    }

    const targetIds = new Set(compactedMessageIds);
    const matchedMessages = new Map<string, MessageData>();
    let page = 0;
    let hasNextPage = true;

    while (hasNextPage && matchedMessages.size < targetIds.size) {
      const result = await this.messageRepository.getMessages(conversationId, {
        page,
        pageSize: CompactionTranscriptRecoveryService.PAGE_SIZE
      });

      for (const message of result.items) {
        if (targetIds.has(message.id)) {
          matchedMessages.set(message.id, message);
        }
      }

      hasNextPage = !!result.hasNextPage;
      page += 1;
    }

    if (matchedMessages.size !== targetIds.size) {
      return null;
    }

    const sequenceNumbers = Array.from(matchedMessages.values())
      .map(message => message.sequenceNumber)
      .sort((a, b) => a - b);

    return {
      conversationId,
      startSequenceNumber: sequenceNumbers[0],
      endSequenceNumber: sequenceNumbers[sequenceNumbers.length - 1]
    };
  }

  /**
   * Recover the exact compacted transcript from the append-only conversation event log.
   * This remains durable after compaction because the JSONL source of truth retains
   * historical message and update events even after the active message rows are deleted.
   */
  async recoverTranscript(
    coverage: CompactedTranscriptCoverageRef
  ): Promise<MessageData[]> {
    if (!coverage.conversationId) {
      return [];
    }

    const fullPath = `.nexus/conversations/conv_${coverage.conversationId}.jsonl`;
    const exists = await this.app.vault.adapter.exists(fullPath);
    if (!exists) {
      return [];
    }

    const content = await this.app.vault.adapter.read(fullPath);
    const events = content
      .split('\n')
      .filter(line => line.trim().length > 0)
      .map(line => {
        try {
          return JSON.parse(line) as ConversationEvent;
        } catch {
          return null;
        }
      })
      .filter((event): event is ConversationEvent => event !== null);

    const messages = new Map<string, MessageData>();

    for (const event of events) {
      if (event.type === 'message' && event.conversationId === coverage.conversationId) {
        this.applyMessageEvent(event, coverage, messages);
        continue;
      }

      if (event.type === 'message_updated') {
        this.applyMessageUpdatedEvent(event, messages);
      }
    }

    return Array.from(messages.values()).sort((a, b) => a.sequenceNumber - b.sequenceNumber);
  }

  private applyMessageEvent(
    event: MessageEvent,
    coverage: CompactedTranscriptCoverageRef,
    messages: Map<string, MessageData>
  ): void {
    const sequenceNumber = event.data.sequenceNumber;
    if (
      sequenceNumber < coverage.startSequenceNumber ||
      sequenceNumber > coverage.endSequenceNumber
    ) {
      return;
    }

    messages.set(event.data.id, {
      id: event.data.id,
      conversationId: event.conversationId,
      role: event.data.role,
      content: event.data.content,
      timestamp: event.timestamp ?? Date.now(),
      state: (event.data.state as MessageData['state']) ?? 'complete',
      sequenceNumber,
      toolCalls: this.normalizeToolCalls(event.data.tool_calls),
      toolCallId: event.data.tool_call_id,
      reasoning: event.data.reasoning,
      alternatives: this.normalizeAlternatives(event.data.alternatives),
      activeAlternativeIndex: event.data.activeAlternativeIndex ?? 0
    });
  }

  private applyMessageUpdatedEvent(
    event: MessageUpdatedEvent,
    messages: Map<string, MessageData>
  ): void {
    const existingMessage = messages.get(event.messageId);
    if (!existingMessage) {
      return;
    }

    if (event.data.content !== undefined) {
      existingMessage.content = event.data.content;
    }
    if (event.data.state !== undefined) {
      existingMessage.state = event.data.state as MessageData['state'];
    }
    if (event.data.reasoning !== undefined) {
      existingMessage.reasoning = event.data.reasoning;
    }
    if (event.data.tool_calls !== undefined) {
      existingMessage.toolCalls = this.normalizeToolCalls(event.data.tool_calls);
    }
    if (event.data.tool_call_id !== undefined) {
      existingMessage.toolCallId = event.data.tool_call_id;
    }
    if (event.data.alternatives !== undefined) {
      existingMessage.alternatives = this.normalizeAlternatives(event.data.alternatives);
    }
    if (event.data.activeAlternativeIndex !== undefined) {
      existingMessage.activeAlternativeIndex = event.data.activeAlternativeIndex;
    }
  }

  private normalizeToolCalls(
    toolCalls: MessageEvent['data']['tool_calls'] | MessageUpdatedEvent['data']['tool_calls'] | undefined
  ): ToolCall[] | undefined {
    if (!toolCalls) {
      return undefined;
    }

    return toolCalls.map(toolCall => ({
      id: toolCall.id,
      type: 'function',
      function: toolCall.function,
      name: toolCall.name,
      parameters: toolCall.parameters,
      result: toolCall.result,
      success: toolCall.success,
      error: toolCall.error,
      executionTime: 'executionTime' in toolCall ? toolCall.executionTime : undefined
    }));
  }

  private normalizeAlternatives(
    alternatives: AlternativeMessageEvent[] | undefined
  ): AlternativeMessage[] | undefined {
    if (!alternatives) {
      return undefined;
    }

    return alternatives.map(alternative => ({
      id: alternative.id,
      content: alternative.content,
      timestamp: alternative.timestamp,
      toolCalls: this.normalizeToolCalls(alternative.tool_calls),
      reasoning: alternative.reasoning,
      state: (alternative.state as AlternativeMessage['state']) ?? 'complete'
    }));
  }
}
