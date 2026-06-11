/**
 * SSE Stream Pump
 * Location: src/services/llm/adapters/shared/SseStreamPump.ts
 *
 * Shared read-feed-drain loop for SSE streaming: reads raw chunks from a
 * Node.js readable stream (or the buffered mobile fallback), feeds them to an
 * eventsource parser whose callback fills `eventQueue`, and yields queued
 * StreamChunks until a completion chunk is seen. Extracted from the
 * duplicated loops in BaseAdapter.processNodeStream and
 * OpenAIAdapter.processResponsesNodeStream; behavior-preserving.
 */
import { StreamChunk } from '../types';

export interface SseStreamPumpState {
  isCompleted: boolean;
}

export interface SseStreamPumpOptions {
  /** Chunk to yield when the stream ends without a completion event. */
  buildFinalChunk: () => StreamChunk;
  /**
   * Chunk to yield (before rethrowing) when the stream errors prior to
   * completion. Omit to rethrow without yielding.
   */
  buildErrorChunk?: () => StreamChunk;
}

export async function* pumpSseEventQueue(
  nodeStream: NodeJS.ReadableStream,
  feed: (text: string) => void,
  eventQueue: StreamChunk[],
  state: SseStreamPumpState,
  options: SseStreamPumpOptions
): AsyncGenerator<StreamChunk, void, unknown> {
  try {
    for await (const chunk of nodeStream as AsyncIterable<Buffer>) {
      if (state.isCompleted) break;

      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
      feed(text);

      // Yield queued events
      while (eventQueue.length > 0) {
        const event = eventQueue.shift();
        if (!event) {
          break;
        }
        yield event;
        if (event.complete) {
          state.isCompleted = true;
          break;
        }
      }
    }

    // Yield remaining events after stream ends
    while (eventQueue.length > 0) {
      const event = eventQueue.shift();
      if (event) {
        yield event;
      }
    }

    // If stream ended without a completion event, yield one
    if (!state.isCompleted) {
      yield options.buildFinalChunk();
    }
  } catch (error) {
    // If stream was destroyed (abort), optionally yield completion
    if (!state.isCompleted && options.buildErrorChunk) {
      yield options.buildErrorChunk();
    }
    throw error;
  }
}
