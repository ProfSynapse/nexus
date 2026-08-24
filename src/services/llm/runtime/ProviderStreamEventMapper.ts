import type { ToolCall as ChatToolCall } from '../../../types/chat/ChatTypes';
import type { StreamChunk, ToolCall as ProviderToolCall } from '../adapters/types';
import type { ChatRuntimeEvent } from './ChatRuntimeEvent';

/**
 * Maps the provider transport DTO into the canonical runtime vocabulary.
 * Provider adapters still own wire parsing; orchestration above this seam only
 * sees events and therefore cannot infer turn completion from transport flags.
 */
export function mapProviderStreamChunk(chunk: StreamChunk): ChatRuntimeEvent[] {
  const events: ChatRuntimeEvent[] = [];

  if (chunk.content) {
    events.push({ type: 'assistant.delta', text: chunk.content });
  }

  if (chunk.reasoning) {
    events.push({
      type: 'reasoning.delta',
      text: chunk.reasoning,
      blockId: chunk.reasoningId,
      encryptedContent: chunk.reasoningEncryptedContent,
    });
  }

  if (chunk.reasoningComplete) {
    events.push({ type: 'reasoning.completed', blockId: chunk.reasoningId });
  }

  if (chunk.toolCalls) {
    events.push({
      type: 'tool.snapshot',
      calls: chunk.toolCalls.map(toChatToolCall),
      ready: chunk.toolCallsReady ?? chunk.complete,
    });
  }

  if (chunk.usage) {
    events.push({ type: 'usage.updated', usage: { ...chunk.usage } });
  }

  if (chunk.metadata) {
    events.push({ type: 'response.metadata', metadata: { ...chunk.metadata } });
  }

  if (chunk.complete) {
    events.push({
      type: 'response.completed',
      finishReason: chunk.toolCalls?.length ? 'tool_calls' : undefined,
    });
  }

  return events;
}

function toChatToolCall(toolCall: ProviderToolCall): ChatToolCall {
  return {
    ...toolCall,
    type: 'function',
    function: {
      name: toolCall.function?.name || '',
      arguments: toolCall.function?.arguments || '{}',
    },
  };
}
