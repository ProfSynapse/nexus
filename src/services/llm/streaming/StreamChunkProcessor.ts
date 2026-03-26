/**
 * Stream Chunk Processor
 * Location: src/services/llm/streaming/StreamChunkProcessor.ts
 *
 * Extracted from BaseAdapter.ts to follow Single Responsibility Principle.
 * Handles processing of individual stream chunks with tool call accumulation.
 *
 * ## Why Two Stream Processors?
 *
 * LLM providers deliver streaming data in two fundamentally different formats:
 *
 * 1. **SDK Streams (this processor)** - Used by OpenAI, Groq, Mistral SDKs
 *    - SDKs return `AsyncIterable<Chunk>` with pre-parsed JavaScript objects
 *    - Clean iteration: `for await (const chunk of stream)`
 *    - SDK handles HTTP, buffering, and JSON parsing internally
 *
 * 2. **SSE Streams (SSEStreamProcessor.ts)** - Used by OpenRouter, Requesty, Perplexity
 *    - Return raw `Response` objects with Server-Sent Events text format
 *    - Requires manual: byte decoding, SSE protocol parsing, JSON parsing, buffer management
 *    - More complex error recovery and reconnection handling
 *
 * OpenRouter uses SSE because it's a proxy service (100+ models) that exposes a raw HTTP API
 * rather than a typed SDK, allowing support for any HTTP client/language.
 *
 * Both processors must preserve `reasoning_details` and `thought_signature` for Gemini models
 * which require this data to be sent back in tool continuation requests.
 *
 * Usage:
 * - Used by BaseAdapter.processStream() for SDK stream processing
 * - Processes delta.content and delta.tool_calls from OpenAI-compatible providers
 * - Accumulates tool calls across multiple chunks
 * - Provides throttled progress updates for long tool arguments
 */

import { StreamChunk } from '../adapters/types';

interface StreamToolCallAccumulator {
  id: string;
  type: string;
  function: {
    name: string;
    arguments: string;
  };
  reasoning_details?: unknown[];
  thought_signature?: string;
  [key: string]: unknown;
}

interface StreamToolCallDelta {
  index?: number;
  id?: string;
  type?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
  reasoning_details?: unknown[];
  thought_signature?: string;
  [key: string]: unknown;
}

export interface StreamChunkOptions<TChunk = unknown, TUsage = unknown> {
  extractContent: (chunk: TChunk) => string | null;
  extractToolCalls: (chunk: TChunk) => StreamToolCallDelta[] | null;
  extractFinishReason: (chunk: TChunk) => string | null;
  extractUsage?: (chunk: TChunk) => TUsage;
}

export class StreamChunkProcessor {
  /**
   * Process individual stream chunk with tool call accumulation
   * Handles delta.content and delta.tool_calls from any OpenAI-compatible provider
   */
  static* processStreamChunk<TChunk = unknown, TUsage = unknown>(
    chunk: TChunk,
    options: StreamChunkOptions<TChunk, TUsage>,
    toolCallsAccumulator: Map<number, StreamToolCallAccumulator>,
    _usageRef: TUsage
  ): Generator<StreamChunk, void, unknown> {

    // Extract text content
    const content = options.extractContent(chunk);
    if (content) {
      yield { content, complete: false };
    }

    // Extract and accumulate tool calls
    const toolCalls = options.extractToolCalls(chunk);
    if (toolCalls) {
      for (const toolCall of toolCalls) {
        const index = typeof toolCall.index === 'number' ? toolCall.index : 0;

        if (!toolCallsAccumulator.has(index)) {
          // Initialize new tool call - preserve reasoning_details and thought_signature
          const accumulated: StreamToolCallAccumulator = {
            id: toolCall.id || '',
            type: toolCall.type || 'function',
            function: {
              name: toolCall.function?.name || '',
              arguments: toolCall.function?.arguments || ''
            }
          };

          // Preserve reasoning data for OpenRouter Gemini and Google models
          if (toolCall.reasoning_details) {
            accumulated.reasoning_details = toolCall.reasoning_details;
          }
          if (toolCall.thought_signature) {
            accumulated.thought_signature = toolCall.thought_signature;
          }

          toolCallsAccumulator.set(index, accumulated);
        } else {
          // Accumulate existing tool call arguments
          const existing = toolCallsAccumulator.get(index);
          if (!existing) {
            continue;
          }

          if (toolCall.id) existing.id = toolCall.id;
          if (toolCall.function?.name) existing.function.name = toolCall.function.name;
          if (toolCall.function?.arguments) {
            existing.function.arguments += toolCall.function.arguments;
          }
          // Also preserve reasoning data if it arrives in later chunks
          if (toolCall.reasoning_details && !existing.reasoning_details) {
            existing.reasoning_details = toolCall.reasoning_details;
          }
          if (toolCall.thought_signature && !existing.thought_signature) {
            existing.thought_signature = toolCall.thought_signature;
          }
        }
      }

      // Yield progress for UI (every 50 characters of arguments)
      const currentToolCalls = Array.from(toolCallsAccumulator.values());
      const totalArgLength = currentToolCalls.reduce((sum, tc) =>
        sum + tc.function.arguments.length, 0
      );

      if (totalArgLength > 0 && totalArgLength % 50 === 0) {
        yield {
          content: '',
          complete: false,
          toolCalls: currentToolCalls as StreamChunk['toolCalls']
        };
      }
    }
  }
}
