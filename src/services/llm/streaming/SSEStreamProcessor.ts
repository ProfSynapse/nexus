/**
 * SSE Stream Processor
 * Location: src/services/llm/streaming/SSEStreamProcessor.ts
 *
 * Extracted from BaseAdapter.ts to follow Single Responsibility Principle.
 * Handles Server-Sent Events (SSE) streaming with automatic tool call accumulation.
 *
 * ## Why Two Stream Processors?
 *
 * LLM providers deliver streaming data in two fundamentally different formats:
 *
 * 1. **SDK Streams (StreamChunkProcessor.ts)** - Used by OpenAI, Groq, Mistral SDKs
 *    - SDKs return `AsyncIterable<Chunk>` with pre-parsed JavaScript objects
 *    - Clean iteration: `for await (const chunk of stream)`
 *    - SDK handles HTTP, buffering, and JSON parsing internally
 *
 * 2. **SSE Streams (this processor)** - Used by OpenRouter, Requesty, Perplexity
 *    - Return raw `Response` objects with Server-Sent Events text format:
 *      ```
 *      data: {"choices":[{"delta":{"content":"Hello"}}]}
 *      data: {"choices":[{"delta":{"content":" world"}}]}
 *      data: [DONE]
 *      ```
 *    - Requires manual: byte-to-text decoding, SSE protocol parsing (`data:`, newlines),
 *      JSON parsing of each event, buffer management for partial chunks
 *    - More complex error recovery and reconnection handling
 *
 * OpenRouter uses SSE because it's a proxy service (100+ models) that exposes a raw HTTP API
 * rather than a typed SDK. This allows them to:
 * - Support any HTTP client/language
 * - Add custom headers (cost tracking, routing metadata)
 * - Unify different provider formats into one consistent SSE stream
 *
 * Both processors must preserve `reasoning_details` and `thought_signature` for Gemini models
 * which require this data to be sent back in tool continuation requests.
 *
 * Usage:
 * - Used by BaseAdapter.processSSEStream()
 * - Handles buffering, parsing, and error recovery for SSE streams
 * - Accumulates tool calls incrementally with throttled yielding
 * - Uses eventsource-parser for robust SSE parsing
 *
 * Features:
 * - Automatic tool call accumulation across stream chunks
 * - Configurable throttling for tool call progress updates
 * - Usage extraction from stream events
 * - Proper finish reason handling
 */

import { createParser, type ParsedEvent, type ParseEvent } from 'eventsource-parser';
import { StreamChunk } from '../adapters/types';

export interface SSEStreamOptions {
  extractContent: (parsed: any) => string | null;
  extractToolCalls: (parsed: any) => any[] | null;
  extractFinishReason: (parsed: any) => string | null;
  extractUsage?: (parsed: any) => any;
  extractMetadata?: (parsed: any) => Record<string, unknown> | null;
  // Reasoning/thinking extraction for models that support it
  extractReasoning?: (parsed: any) => { text: string; complete: boolean } | null;
  onParseError?: (error: Error, rawData: string) => void;
  debugLabel?: string;
  // Tool call accumulation settings
  accumulateToolCalls?: boolean;
  toolCallThrottling?: {
    initialYield: boolean;
    progressInterval: number; // Yield every N characters of arguments
  };
}

export class SSEStreamProcessor {
  /**
   * Process SSE stream with automatic tool call accumulation
   * Handles all the complex buffering, parsing, and error recovery
   */
  static async* processSSEStream(
    response: Response,
    options: SSEStreamOptions
  ): AsyncGenerator<StreamChunk, void, unknown> {
    if (!response.body) {
      throw new Error('Response body is not readable');
    }

    const debugLabel = options.debugLabel || 'SSE';
    let tokenCount = 0;
    let usage: any = undefined;
    let metadata: Record<string, unknown> | undefined = undefined;

    // Tool call accumulation system
    const toolCallsAccumulator: Map<number, any> = new Map();
    let accumulatedContent = '';

    // Event queue for handling async events in sync generator
    const eventQueue: StreamChunk[] = [];
    let isCompleted = false;
    let completionError: Error | null = null;

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    const parser = createParser((event: ParseEvent) => {
      if (isCompleted) return;

      // Handle reconnect intervals
      if (event.type === 'reconnect-interval') {
        return;
      }

      // Handle [DONE] event
      if (event.data === '[DONE]') {
        const finalUsage = usage ? {
          promptTokens: usage.prompt_tokens || 0,
          completionTokens: usage.completion_tokens || 0,
          totalTokens: usage.total_tokens || 0
        } : undefined;

        const finalToolCalls = options.accumulateToolCalls && toolCallsAccumulator.size > 0
          ? Array.from(toolCallsAccumulator.values())
          : undefined;

        eventQueue.push({
          content: '',
          complete: true,
          usage: finalUsage,
          toolCalls: finalToolCalls,
          toolCallsReady: finalToolCalls && finalToolCalls.length > 0 ? true : undefined,
          metadata
        });

        isCompleted = true;
        return;
      }

      try {
        const parsed = JSON.parse(event.data);

        if (options.extractMetadata) {
          metadata = {
            ...(metadata || {}),
            ...(options.extractMetadata(parsed) || {})
          };
        }

        // Extract content using adapter-specific logic
        const content = options.extractContent(parsed);
        if (content) {
          tokenCount++;
          accumulatedContent += content;

          eventQueue.push({
            content,
            complete: false
          });
        }

        // Extract reasoning/thinking using adapter-specific logic (if provided)
        if (options.extractReasoning) {
          const reasoning = options.extractReasoning(parsed);
          if (reasoning) {
            eventQueue.push({
              content: '',
              complete: false,
              reasoning: reasoning.text,
              reasoningComplete: reasoning.complete
            });
          }
        }

        // Extract tool calls using adapter-specific logic
        const toolCalls = options.extractToolCalls(parsed);
        if (toolCalls && options.accumulateToolCalls) {
          let shouldYieldToolCalls = false;

          for (const toolCall of toolCalls) {
            const index = toolCall.index || 0;

            if (!toolCallsAccumulator.has(index)) {
              // Initialize new tool call - preserve reasoning_details and thought_signature
              const accumulated: any = {
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
              shouldYieldToolCalls = options.toolCallThrottling?.initialYield !== false;
            } else {
              // Accumulate existing tool call
              const existing = toolCallsAccumulator.get(index);
              if (toolCall.id) existing.id = toolCall.id;
              if (toolCall.function?.name) existing.function.name = toolCall.function.name;
              if (toolCall.function?.arguments) {
                existing.function.arguments += toolCall.function.arguments;

                // Check throttling conditions
                const argLength = existing.function.arguments.length;
                const interval = options.toolCallThrottling?.progressInterval || 50;
                shouldYieldToolCalls = argLength > 0 && argLength % interval === 0;
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

          if (shouldYieldToolCalls) {
            const currentToolCalls = Array.from(toolCallsAccumulator.values());

            eventQueue.push({
              content: '',
              complete: false,
              toolCalls: currentToolCalls
            });
          }
        }

        // Extract usage information
        if (options.extractUsage) {
          const extractedUsage = options.extractUsage(parsed);
          if (extractedUsage) {
            usage = extractedUsage;
          }
        }

        // Handle completion
        const finishReason = options.extractFinishReason(parsed);
        if (finishReason === 'stop' || finishReason === 'length' || finishReason === 'tool_calls') {
          // Include accumulated tool calls in completion event (same pattern as [DONE])
          const finalToolCalls = options.accumulateToolCalls && toolCallsAccumulator.size > 0
            ? Array.from(toolCallsAccumulator.values())
            : undefined;

          const finalUsageFormatted = usage ? {
            promptTokens: usage.prompt_tokens || 0,
            completionTokens: usage.completion_tokens || 0,
            totalTokens: usage.total_tokens || 0
          } : undefined;

          eventQueue.push({
            content: '',
            complete: true,
            toolCalls: finalToolCalls,
            usage: finalUsageFormatted,
            toolCallsReady: finalToolCalls && finalToolCalls.length > 0 ? true : undefined,
            metadata
          });

          isCompleted = true;
        }

      } catch (parseError) {
        if (options.onParseError) {
          options.onParseError(parseError as Error, event.data);
        }
        // Continue processing other events
      }
    });

    try {
      // Process the stream
      while (!isCompleted && !completionError) {
        const { done, value } = await reader.read();

        if (done) {
          isCompleted = true;
          break;
        }

        // Feed chunk to parser
        const chunk = decoder.decode(value, { stream: true });
        parser.feed(chunk);

        // Yield any queued events
        while (eventQueue.length > 0) {
          const event = eventQueue.shift()!;
          yield event;

          // If this was a completion event, we're done
          if (event.complete) {
            isCompleted = true;
            break;
          }
        }
      }

      // Yield any remaining queued events
      while (eventQueue.length > 0) {
        const event = eventQueue.shift()!;
        yield event;
      }

      // If we completed without a completion event, yield one
      if (!isCompleted || (!eventQueue.length && !completionError)) {
        yield {
          content: '',
          complete: true,
          usage: usage ? {
            promptTokens: usage.prompt_tokens || 0,
            completionTokens: usage.completion_tokens || 0,
            totalTokens: usage.total_tokens || 0
          } : undefined
        };
      }

    } catch (error) {
      throw error;
    } finally {
      try {
        reader.cancel();
      } catch (error) {
        // Ignore cancellation errors
      }
    }

    if (completionError) {
      throw completionError;
    }
  }
}
