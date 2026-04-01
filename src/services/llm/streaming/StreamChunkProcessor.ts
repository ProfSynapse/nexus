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

import { StreamChunk, ToolCall } from '../adapters/types';

interface StreamToolCallFunction {
  name?: string;
  arguments?: string;
}

interface StreamToolCall {
  index?: number;
  id?: string;
  type?: string;
  function?: StreamToolCallFunction;
  reasoning_details?: unknown;
  thought_signature?: unknown;
}

function normalizeStreamToolCall(toolCall: StreamToolCall): ToolCall {
  return {
    id: toolCall.id || '',
    type: 'function',
    name: toolCall.function?.name,
    function: {
      name: toolCall.function?.name || '',
      arguments: toolCall.function?.arguments || ''
    },
    reasoning_details: Array.isArray(toolCall.reasoning_details)
      ? toolCall.reasoning_details as Array<Record<string, unknown>>
      : undefined,
    thought_signature: typeof toolCall.thought_signature === 'string'
      ? toolCall.thought_signature
      : undefined
  };
}

interface StreamChunkLike {
  delta?: {
    content?: string;
    tool_calls?: StreamToolCall[];
    finish_reason?: string;
  };
  choices?: Array<{
    delta?: {
      content?: string;
      tool_calls?: StreamToolCall[];
    };
    finish_reason?: string;
  }>;
  usage?: unknown;
  [key: string]: unknown;
}

export interface StreamChunkOptions {
  extractContent: (chunk: StreamChunkLike) => string | null;
  extractToolCalls: (chunk: StreamChunkLike) => StreamToolCall[] | null;
  extractFinishReason: (chunk: StreamChunkLike) => string | null;
  extractUsage?: (chunk: StreamChunkLike) => unknown;
}

export class StreamChunkProcessor {
  /**
   * Process individual stream chunk with tool call accumulation
   * Handles delta.content and delta.tool_calls from any OpenAI-compatible provider
   */
  static* processStreamChunk(
    chunk: StreamChunkLike,
    options: StreamChunkOptions,
    toolCallsAccumulator: Map<number, StreamToolCall>,
    _usageRef: unknown
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
        const index = toolCall.index || 0;

        if (!toolCallsAccumulator.has(index)) {
          // Initialize new tool call - preserve reasoning_details and thought_signature
          const accumulated: StreamToolCall = {
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
          if (toolCall.function?.name) {
            if (!existing.function) {
              existing.function = {};
            }
            existing.function.name = toolCall.function.name;
          }
          if (toolCall.function?.arguments) {
            if (!existing.function) {
              existing.function = {};
            }
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
        sum + (tc.function?.arguments?.length || 0), 0
      );

      if (totalArgLength > 0 && totalArgLength % 50 === 0) {
        yield {
          content: '',
          complete: false,
          toolCalls: currentToolCalls.map(normalizeStreamToolCall)
        };
      }
    }
  }
}
