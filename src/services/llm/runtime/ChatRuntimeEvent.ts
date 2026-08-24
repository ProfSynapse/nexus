import type {
  MessageCost,
  MessageUsage,
  ToolCall,
} from '../../../types/chat/ChatTypes';

export interface ChatRuntimeError {
  message: string;
  code?: string;
  provider?: string;
  retryable?: boolean;
}

export type ChatRuntimeEvent =
  | { type: 'assistant.delta'; text: string }
  | {
      type: 'reasoning.delta';
      text: string;
      blockId?: string;
      encryptedContent?: string;
    }
  | { type: 'reasoning.completed'; blockId?: string }
  | { type: 'tool.snapshot'; calls: ToolCall[]; ready: boolean }
  | { type: 'tool.execution.started'; operationId: string; call: ToolCall }
  | {
      type: 'tool.execution.completed';
      operationId: string;
      call: ToolCall;
      success: boolean;
    }
  | { type: 'usage.updated'; usage: MessageUsage }
  | { type: 'cost.updated'; cost: MessageCost }
  | { type: 'response.metadata'; metadata: Record<string, unknown> }
  | { type: 'response.resolved'; provider?: string; model?: string }
  | {
      type: 'response.completed';
      finishReason?: 'stop' | 'length' | 'tool_calls' | 'content_filter';
    }
  | {
      type: 'turn.completed';
      finishReason?: 'stop' | 'length' | 'tool_calls' | 'content_filter';
    }
  | { type: 'turn.aborted'; reason?: string }
  | { type: 'turn.failed'; error: ChatRuntimeError };

/**
 * The single chat-stream transport above the provider orchestration layer.
 * The event is authoritative; messageId only identifies the UI/persistence
 * target and deliberately carries no duplicate content/completion fields.
 */
export interface ChatRuntimeEnvelope {
  messageId: string;
  event: ChatRuntimeEvent;
}

export type TerminalChatRuntimeEvent = Extract<
  ChatRuntimeEvent,
  { type: 'turn.completed' | 'turn.aborted' | 'turn.failed' }
>;

export function isTerminalChatRuntimeEvent(
  event: ChatRuntimeEvent
): event is TerminalChatRuntimeEvent {
  return event.type === 'turn.completed'
    || event.type === 'turn.aborted'
    || event.type === 'turn.failed';
}
