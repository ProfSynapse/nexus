/**
 * Tool calls as conversation events persist them, and the rules for writing
 * them once each.
 *
 * A `message_updated` event can only carry the whole `tool_calls` array, so
 * every new call in a long turn used to re-save every earlier result. During
 * a turn, each call that starts or finishes is now written on its own as a
 * `message_tool_call_upserted` event. When the turn ends, one ordinary
 * `message_updated` carries the full array: devices on versions that predate
 * the upsert event skip it (their applier switch has no default) and catch up
 * from that snapshot.
 *
 * The repository (live write) and the applier (replay) both use these
 * helpers, so what is written and what is replayed cannot drift.
 */

import type { MessageData } from '../../types/storage/HybridStorageTypes';
import type { MessageUpdatedEvent } from '../interfaces/StorageEvents';
import { trimToolResultForStorage } from '../../utils/toolResultTrim';

export type EventToolCall = NonNullable<MessageUpdatedEvent['data']['tool_calls']>[number];

/** States after which a message no longer changes on its own. */
const TERMINAL_STATES = new Set(['complete', 'aborted', 'invalid']);

export function isTerminalMessageState(state: string | undefined | null): boolean {
  return state !== undefined && state !== null && TERMINAL_STATES.has(state);
}

/**
 * The persisted shape of one tool call. Results over the storage limit are
 * trimmed here, so every persisted form (event, replayed cache row, live cache
 * row) holds the same bounded value.
 */
export function toEventToolCall(call: NonNullable<MessageData['toolCalls']>[number]): EventToolCall {
  return {
    id: call.id,
    type: call.type || 'function',
    function: call.function,
    name: call.name,
    parameters: call.parameters,
    result: trimToolResultForStorage(call.result),
    success: call.success,
    error: call.error
  };
}

export function toEventToolCalls(toolCalls: MessageData['toolCalls'] | null | undefined): EventToolCall[] | undefined {
  return toolCalls?.map(toEventToolCall);
}

/** Replace the call with the same id, or append it. Order is otherwise kept. */
export function mergeToolCall(existing: EventToolCall[] | null | undefined, call: EventToolCall): EventToolCall[] {
  const calls = existing ? [...existing] : [];
  const index = calls.findIndex(candidate => candidate.id === call.id);
  if (index >= 0) {
    calls[index] = call;
  } else {
    calls.push(call);
  }
  return calls;
}

export type ToolCallWritePlan =
  | { kind: 'unchanged' }
  | { kind: 'snapshot' }
  | { kind: 'upserts'; calls: EventToolCall[] };

/**
 * How to persist a change from `current` to `next` (both already in event
 * shape). Per-call upserts are only possible when replaying them onto
 * `current` reproduces `next` exactly: no call removed, the existing ones in
 * the same order, new ones appended. Anything else needs a full snapshot.
 */
export function planToolCallWrite(
  current: EventToolCall[] | null | undefined,
  next: EventToolCall[] | null | undefined,
  options: { turnEnded: boolean }
): ToolCallWritePlan {
  const before = current ?? [];
  const after = next ?? [];
  const same = (a: EventToolCall, b: EventToolCall) => JSON.stringify(a) === JSON.stringify(b);

  const unchanged = before.length === after.length && before.every((call, index) => same(call, after[index]));
  if (unchanged) {
    return { kind: 'unchanged' };
  }
  if (options.turnEnded || next === null || after.length < before.length) {
    return { kind: 'snapshot' };
  }
  for (let index = 0; index < before.length; index += 1) {
    if (before[index].id !== after[index].id) {
      return { kind: 'snapshot' };
    }
  }

  const ids = new Set<string>();
  for (const call of after) {
    if (ids.has(call.id)) return { kind: 'snapshot' };
    ids.add(call.id);
  }

  const calls = after.filter((call, index) => index >= before.length || !same(call, before[index]));
  return { kind: 'upserts', calls };
}
