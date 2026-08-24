import type {
  MessageCost,
  MessageUsage,
  ToolCall,
} from '../../../types/chat/ChatTypes';
import {
  isTerminalChatRuntimeEvent,
  type ChatRuntimeError,
  type ChatRuntimeEvent,
  type TerminalChatRuntimeEvent,
} from './ChatRuntimeEvent';

export type ChatTurnPhase =
  | 'pending'
  | 'streaming'
  | 'waiting-for-tool'
  | 'executing-tool'
  | 'complete'
  | 'aborted'
  | 'failed';

export interface ChatTurnReasoningState {
  text: string;
  complete: boolean;
  blockId?: string;
  encryptedContent?: string;
}

export interface ChatTurnState {
  phase: ChatTurnPhase;
  content: string;
  reasoning: ChatTurnReasoningState;
  toolCalls: ToolCall[];
  usage?: MessageUsage;
  cost?: MessageCost;
  metadata: Record<string, unknown>;
  provider?: string;
  model?: string;
  error?: ChatRuntimeError;
  terminalEvent?: TerminalChatRuntimeEvent;
}

export function createInitialChatTurnState(): ChatTurnState {
  return {
    phase: 'pending',
    content: '',
    reasoning: {
      text: '',
      complete: false,
    },
    toolCalls: [],
    metadata: {},
  };
}

export function reduceChatTurn(
  state: ChatTurnState,
  event: ChatRuntimeEvent
): ChatTurnState {
  if (state.terminalEvent) {
    if (!isTerminalChatRuntimeEvent(event)) {
      return state;
    }

    if (stableSerialize(state.terminalEvent) === stableSerialize(event)) {
      return state;
    }

    throw new Error(
      `Conflicting terminal chat events: ${state.terminalEvent.type} then ${event.type}.`
    );
  }

  switch (event.type) {
    case 'assistant.delta':
      return {
        ...state,
        phase: activePhase(state.phase),
        content: state.content + event.text,
      };
    case 'reasoning.delta':
      return {
        ...state,
        phase: activePhase(state.phase),
        reasoning: {
          text: state.reasoning.text + event.text,
          complete: false,
          blockId: event.blockId ?? state.reasoning.blockId,
          encryptedContent: event.encryptedContent ?? state.reasoning.encryptedContent,
        },
      };
    case 'reasoning.completed':
      return {
        ...state,
        phase: activePhase(state.phase),
        reasoning: {
          ...state.reasoning,
          complete: true,
          blockId: event.blockId ?? state.reasoning.blockId,
        },
      };
    case 'tool.snapshot': {
      const toolCalls = mergeToolCallSnapshots(state.toolCalls, event.calls);
      const hasUnsettledCall = toolCalls.some(call =>
        call.result === undefined
        && call.success === undefined
        && call.error === undefined
      );
      return {
        ...state,
        phase: event.ready && hasUnsettledCall
          ? 'waiting-for-tool'
          : activePhase(state.phase),
        toolCalls,
      };
    }
    case 'tool.execution.started':
      return {
        ...state,
        phase: 'executing-tool',
        toolCalls: mergeToolCallSnapshots(state.toolCalls, [event.call]),
      };
    case 'tool.execution.completed':
      return {
        ...state,
        phase: 'streaming',
        toolCalls: mergeToolCallSnapshots(state.toolCalls, [event.call]),
      };
    case 'usage.updated':
      return { ...state, usage: { ...event.usage } };
    case 'cost.updated':
      return { ...state, cost: { ...event.cost } };
    case 'response.metadata':
      return {
        ...state,
        metadata: { ...state.metadata, ...event.metadata },
      };
    case 'response.resolved':
      return {
        ...state,
        provider: event.provider ?? state.provider,
        model: event.model ?? state.model,
      };
    case 'response.completed':
      return {
        ...state,
        phase: event.finishReason === 'tool_calls'
          ? 'waiting-for-tool'
          : activePhase(state.phase),
      };
    case 'turn.completed':
      return settle(state, event, 'complete');
    case 'turn.aborted':
      return settle(state, event, 'aborted');
    case 'turn.failed':
      return {
        ...settle(state, event, 'failed'),
        error: event.error,
      };
  }
}

function activePhase(phase: ChatTurnPhase): ChatTurnPhase {
  return phase === 'waiting-for-tool' || phase === 'executing-tool'
    ? phase
    : 'streaming';
}

function settle(
  state: ChatTurnState,
  event: TerminalChatRuntimeEvent,
  phase: Extract<ChatTurnPhase, 'complete' | 'aborted' | 'failed'>
): ChatTurnState {
  return {
    ...state,
    phase,
    terminalEvent: event,
  };
}

function mergeToolCallSnapshots(
  existing: ToolCall[],
  incoming: ToolCall[]
): ToolCall[] {
  const merged = existing.map(call => ({
    ...call,
    function: { ...call.function },
  }));

  for (let index = 0; index < incoming.length; index++) {
    const next = incoming[index];
    const existingIndex = next.id
      ? merged.findIndex(call => call.id === next.id)
      : index < merged.length ? index : -1;

    if (existingIndex < 0) {
      merged.push({
        ...next,
        function: { ...next.function },
      });
      continue;
    }

    const previous = merged[existingIndex];
    merged[existingIndex] = {
      ...previous,
      ...next,
      function: {
        ...previous.function,
        ...next.function,
      },
    };
  }

  return merged;
}

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(stableSerialize).join(',')}]`;
  }

  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map(key => `${JSON.stringify(key)}:${stableSerialize(record[key])}`)
    .join(',')}}`;
}
