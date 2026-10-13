import type { ChatRuntimeEvent } from '../llm/runtime/ChatRuntimeEvent';
import { createInitialChatTurnState, reduceChatTurn, type ChatTurnState } from '../llm/runtime/ChatTurnReducer';
import type { ConversationMessage } from '../../types/chat/ChatTypes';

export type TurnSaveState = 'pending' | 'saving' | 'saved' | 'failed';
export interface ChatTurnSnapshot {
  readonly conversationId: string;
  readonly messageId: string;
  readonly generationId: string;
  readonly state: ChatTurnState;
  readonly saveState: TurnSaveState;
  readonly saveError?: string;
}
export interface ReasoningDisplayState {
  generationId?: string;
  phase: 'waiting' | 'thinking' | 'settled' | 'interrupted';
  text: string;
  segments: ChatTurnState['reasoning']['segments'];
}

let generationSequence = 0;

/** Service-owned runtime state. Subscribers observe; only the execution owner dispatches. */
export class ChatTurnStore {
  private turns = new Map<string, ChatTurnSnapshot>();
  private listeners = new Set<(snapshot: ChatTurnSnapshot) => void>();
  private key(conversationId: string, messageId: string): string { return JSON.stringify([conversationId, messageId]); }

  get(conversationId: string, messageId: string): ChatTurnSnapshot | undefined {
    return this.turns.get(this.key(conversationId, messageId));
  }

  activeMessageId(conversationId?: string): string | null {
    return [...this.turns.values()].find(turn => turn.conversationId === conversationId && !turn.state.terminalEvent)?.messageId ?? null;
  }

  assertConversationSaved(conversationId: string): void {
    if ([...this.turns.values()].some(turn => turn.conversationId === conversationId && turn.state.terminalEvent && turn.saveState !== 'saved')) {
      throw new Error('Save the unsaved response before continuing this conversation.');
    }
  }

  begin(conversationId: string, messageId: string): ChatTurnSnapshot {
    this.assertConversationSaved(conversationId);
    const previous = this.get(conversationId, messageId);
    if (previous && previous.saveState !== 'saved') throw new Error('This response is still running or has unsaved changes. Save it before retrying.');
    if ([...this.turns.values()].filter(turn => turn.saveState !== 'saved').length >= 32) {
      throw new Error('Too many active or unsaved responses. Save pending responses before starting another.');
    }
    return this.publish({ conversationId, messageId, generationId: `${Date.now()}-${++generationSequence}`, state: createInitialChatTurnState(), saveState: 'pending' });
  }

  isCurrent(turn: ChatTurnSnapshot): boolean {
    return this.get(turn.conversationId, turn.messageId)?.generationId === turn.generationId;
  }

  dispatch(turn: ChatTurnSnapshot, event: ChatRuntimeEvent): ChatTurnSnapshot {
    const current = this.get(turn.conversationId, turn.messageId);
    if (!current || current.generationId !== turn.generationId) throw new Error('Stale chat generation');
    return this.publish({ ...current, state: reduceChatTurn(current.state, event) });
  }

  setSaveState(turn: ChatTurnSnapshot, saveState: TurnSaveState, saveError?: string): ChatTurnSnapshot {
    const current = this.get(turn.conversationId, turn.messageId);
    if (!current || !this.isCurrent(turn)) throw new Error('Stale chat save');
    return this.publish({ ...current, saveState, saveError });
  }

  subscribe(listener: (snapshot: ChatTurnSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private publish(snapshot: ChatTurnSnapshot): ChatTurnSnapshot {
    this.turns.set(this.key(snapshot.conversationId, snapshot.messageId), snapshot);
    // Retain failed saves; only acknowledged history can be reloaded from disk.
    if (this.turns.size > 128) {
      for (const [key, turn] of this.turns) {
        if (this.turns.size <= 128) break;
        if (turn.saveState === 'saved' && turn !== snapshot) this.turns.delete(key);
      }
    }
    for (const listener of this.listeners) {
      try { listener(snapshot); } catch (error) { console.error('[ChatTurnStore] Subscriber failed:', error); }
    }
    return snapshot;
  }
}

export function selectReasoning(turn: ChatTurnSnapshot): ReasoningDisplayState {
  const state = turn.state;
  return {
    generationId: turn.generationId,
    phase: state.phase === 'aborted' || state.phase === 'failed' ? 'interrupted'
      : state.terminalEvent ? 'settled'
      : state.reasoning.openSegmentIndex !== undefined ? 'thinking'
      : state.phase === 'pending' ? 'waiting' : 'settled',
    text: state.reasoning.text,
    segments: state.reasoning.segments,
  };
}

/** A derived view, never a persistence payload or independent runtime owner. */
export function projectTurn(message: ConversationMessage, turn: ChatTurnSnapshot): ConversationMessage {
  const state = turn.state;
  return {
    ...message,
    content: state.content,
    reasoning: state.reasoning.text || undefined,
    reasoningSegments: state.reasoning.segments,
    toolCalls: state.toolCalls.length ? state.toolCalls : undefined,
    state: state.phase === 'complete' ? 'complete' : state.phase === 'aborted' ? 'aborted'
      : state.phase === 'failed' ? 'invalid' : 'streaming',
    isLoading: !state.terminalEvent && state.phase === 'pending',
    metadata: { ...state.metadata, ...(state.error ? { runtimeError: state.error } : {}) },
    provider: state.provider ?? message.provider,
    model: state.model ?? message.model,
    usage: state.usage,
    cost: state.cost,
  };
}
