/**
 * Mid-turn checkpoints for streaming chat turns.
 *
 * The assistant message used to be written twice per turn: an empty draft at
 * the start and the full message at the end. A crash or reload in between lost
 * the whole turn. While a turn runs, its progress is now saved at most once
 * every `TURN_CHECKPOINT_INTERVAL_MS`, so at most that much is lost. Per-field
 * writes and per-call tool events (MessageRepository) keep each checkpoint
 * small.
 *
 * A checkpointed message is stored with state `streaming` and a
 * `turnCheckpoint` marker in its metadata. If it is found that way with no
 * live turn behind it, the turn was interrupted and is repaired: kept as
 * `aborted`, with the tool calls that never finished removed, so it reads as
 * interrupted and replays safely to the model.
 */

import type { ConversationMessage, ToolCall } from '../../types/chat/ChatTypes';

export const TURN_CHECKPOINT_INTERVAL_MS = 2000;

/**
 * A checkpoint written by another device counts as interrupted once it is this
 * old. Until then the other device is assumed to still be running the turn;
 * its own final save would overwrite a premature repair anyway.
 */
export const FOREIGN_CHECKPOINT_STALE_MS = 30 * 60 * 1000;

export const TURN_CHECKPOINT_METADATA_KEY = 'turnCheckpoint';

export interface TurnCheckpointMarker {
  /** When this checkpoint was written (ms since epoch). */
  at: number;
  /** The device that is running the turn. */
  deviceId?: string;
}

/**
 * Saves turn progress at most once per interval, one save at a time. The first
 * change is saved at once; later changes inside an interval are folded into
 * one save at its end. `close()` cancels anything pending and waits for a save
 * in flight, so a checkpoint can never land after the turn's final save.
 */
export class TurnCheckpointer {
  private timer: number | null = null;
  private inFlight: Promise<void> | null = null;
  private dirty = false;
  private closed = false;
  private lastStartedAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly save: () => Promise<void>,
    private readonly intervalMs: number = TURN_CHECKPOINT_INTERVAL_MS,
    private readonly now: () => number = () => Date.now()
  ) {}

  /** Note that the turn changed; a save follows within the interval. */
  request(): void {
    if (this.closed) return;
    this.dirty = true;
    if (this.timer !== null || this.inFlight) return;
    this.schedule();
  }

  /** Stop checkpointing and wait for any save already running. */
  async close(): Promise<void> {
    this.closed = true;
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.inFlight) {
      await this.inFlight;
    }
  }

  private schedule(): void {
    const wait = Math.max(0, this.lastStartedAt + this.intervalMs - this.now());
    this.timer = window.setTimeout(() => {
      this.timer = null;
      void this.run();
    }, wait);
  }

  private async run(): Promise<void> {
    if (this.closed || !this.dirty) return;
    this.dirty = false;
    this.lastStartedAt = this.now();
    this.inFlight = this.save()
      .catch(error => {
        // A failed checkpoint only means less is recoverable after a crash;
        // the final save is what counts, and it reports its own failures.
        console.warn('[TurnCheckpointer] Checkpoint save failed:', error);
      })
      .finally(() => {
        this.inFlight = null;
        if (this.dirty && !this.closed) this.schedule();
      });
    await this.inFlight;
  }
}

export function readTurnCheckpoint(message: Pick<ConversationMessage, 'metadata'>): TurnCheckpointMarker | undefined {
  const marker = message.metadata?.[TURN_CHECKPOINT_METADATA_KEY];
  if (!marker || typeof marker !== 'object') return undefined;
  const at = (marker as { at?: unknown }).at;
  if (typeof at !== 'number' || !Number.isFinite(at)) return undefined;
  const deviceId = (marker as { deviceId?: unknown }).deviceId;
  return { at, deviceId: typeof deviceId === 'string' ? deviceId : undefined };
}

/**
 * Whether a stored message is a checkpoint of a turn that is no longer
 * running. Callers check first that no live turn exists for it locally.
 */
export function isInterruptedCheckpoint(
  message: Pick<ConversationMessage, 'state' | 'metadata'>,
  thisDeviceId: string | undefined,
  now: number
): boolean {
  if (message.state !== 'streaming') return false;
  const marker = readTurnCheckpoint(message);
  if (!marker) return false;
  if (thisDeviceId && marker.deviceId === thisDeviceId) return true;
  return now - marker.at > FOREIGN_CHECKPOINT_STALE_MS;
}

/** The stored form of an interrupted turn: kept, marked aborted, unfinished tool calls dropped. */
export function repairInterruptedTurn(message: ConversationMessage): Pick<ConversationMessage, 'state' | 'toolCalls' | 'metadata'> {
  const finished = (message.toolCalls ?? []).filter((call: ToolCall) => call.result !== undefined || call.error !== undefined);
  const metadata: Record<string, unknown> = { ...message.metadata };
  const marker = readTurnCheckpoint(message);
  delete metadata[TURN_CHECKPOINT_METADATA_KEY];
  metadata.interruptedTurn = { lastCheckpointAt: marker?.at };
  return {
    state: 'aborted',
    toolCalls: finished,
    metadata
  };
}
