import { createParser, type ParseEvent } from 'eventsource-parser';
import { StreamChunk, ToolCall } from '../adapters/types';
import { SSEStreamOptions } from './SSEStreamProcessor';

interface BufferedUsage {
  prompt_tokens?: number;
  promptTokenCount?: number;
  promptTokens?: number;
  input_tokens?: number;
  completion_tokens?: number;
  candidatesTokenCount?: number;
  completionTokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  totalTokenCount?: number;
  totalTokens?: number;
}

interface BufferedToolCall {
  id?: string;
  type?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
  reasoning_details?: unknown;
  thought_signature?: unknown;
  [key: string]: unknown;
}

type BufferedParsedEvent = Record<string, unknown>;

function normalizeBufferedToolCall(toolCall: BufferedToolCall): ToolCall {
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

export class BufferedSSEStreamProcessor {
  static async* processSSEText(
    sseText: string,
    options: SSEStreamOptions
  ): AsyncGenerator<StreamChunk, void, unknown> {
    const eventQueue: StreamChunk[] = [];
    let isCompleted = false;
    let usage: BufferedUsage | undefined;
    let metadata: Record<string, unknown> | undefined = undefined;
    const toolCallsAccumulator: Map<number, BufferedToolCall> = new Map();

    const parser = createParser((event: ParseEvent) => {
      if (event.type === 'reconnect-interval' || isCompleted) {
        return;
      }

      if (event.data === '[DONE]') {
        const finalToolCalls = getFinalToolCalls(toolCallsAccumulator, options);
        eventQueue.push({
          content: '',
          complete: true,
          usage: formatUsage(usage),
          toolCalls: finalToolCalls,
          toolCallsReady: finalToolCalls && finalToolCalls.length > 0 ? true : undefined,
          metadata
        });
        isCompleted = true;
        return;
      }

      try {
        const parsed = JSON.parse(event.data) as BufferedParsedEvent;

        if (options.extractMetadata) {
          metadata = {
            ...(metadata || {}),
            ...(options.extractMetadata(parsed) || {})
          };
        }

        const content = options.extractContent(parsed);
        if (content) {
          eventQueue.push({
            content,
            complete: false
          });
        }

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

        const toolCalls = options.extractToolCalls(parsed);
        if (toolCalls && options.accumulateToolCalls) {
          let shouldYieldToolCalls = false;

          for (const toolCall of toolCalls) {
            const index = toolCall.index || 0;

            if (!toolCallsAccumulator.has(index)) {
              const accumulated: BufferedToolCall = {
                id: toolCall.id || '',
                type: toolCall.type || 'function',
                function: {
                  name: toolCall.function?.name || '',
                  arguments: toolCall.function?.arguments || ''
                }
              };

              if (toolCall.reasoning_details) {
                accumulated.reasoning_details = toolCall.reasoning_details;
              }
              if (toolCall.thought_signature) {
                accumulated.thought_signature = toolCall.thought_signature;
              }

              toolCallsAccumulator.set(index, accumulated);
              shouldYieldToolCalls = options.toolCallThrottling?.initialYield !== false;
            } else {
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
                existing.function.arguments = `${existing.function.arguments ?? ''}${toolCall.function.arguments}`;
                const interval = options.toolCallThrottling?.progressInterval || 50;
                shouldYieldToolCalls = existing.function.arguments.length > 0 &&
                  existing.function.arguments.length % interval === 0;
              }
              if (toolCall.reasoning_details && !existing.reasoning_details) {
                existing.reasoning_details = toolCall.reasoning_details;
              }
              if (toolCall.thought_signature && !existing.thought_signature) {
                existing.thought_signature = toolCall.thought_signature;
              }
            }
          }

          if (shouldYieldToolCalls) {
            eventQueue.push({
              content: '',
              complete: false,
              toolCalls: Array.from(toolCallsAccumulator.values()).map(normalizeBufferedToolCall)
            });
          }
        }

        if (options.extractUsage) {
          const extractedUsage = options.extractUsage(parsed);
          if (extractedUsage) {
            usage = extractedUsage;
          }
        }

        const finishReason = options.extractFinishReason(parsed);
        if (finishReason === 'stop' || finishReason === 'length' || finishReason === 'tool_calls') {
          const finalToolCalls = getFinalToolCalls(toolCallsAccumulator, options);
          eventQueue.push({
            content: '',
            complete: true,
            usage: formatUsage(usage),
            toolCalls: finalToolCalls,
            toolCallsReady: finalToolCalls && finalToolCalls.length > 0 ? true : undefined,
            metadata
          });
          isCompleted = true;
        }
      } catch (parseError) {
        if (options.onParseError) {
          options.onParseError(parseError as Error, event.data);
        }
      }
    });

    parser.feed(sseText);

    while (eventQueue.length > 0) {
      const chunk = eventQueue.shift();
      if (chunk) {
        yield chunk;
      }
    }
  }
}

function formatUsage(usage: BufferedUsage | undefined): StreamChunk['usage'] {
  if (!usage) {
    return undefined;
  }

  return {
    promptTokens: usage.prompt_tokens || usage.promptTokenCount || usage.promptTokens || usage.input_tokens || 0,
    completionTokens: usage.completion_tokens || usage.candidatesTokenCount || usage.completionTokens || usage.output_tokens || 0,
    totalTokens: usage.total_tokens || usage.totalTokenCount || usage.totalTokens || 0
  };
}

function getFinalToolCalls(
  toolCallsAccumulator: Map<number, BufferedToolCall>,
  options: SSEStreamOptions
): ToolCall[] | undefined {
  if (!options.accumulateToolCalls || toolCallsAccumulator.size === 0) {
    return undefined;
  }

  return Array.from(toolCallsAccumulator.values()).map(normalizeBufferedToolCall);
}
