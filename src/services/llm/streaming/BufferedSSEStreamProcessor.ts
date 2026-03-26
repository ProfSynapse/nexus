import { createParser, type ParseEvent } from 'eventsource-parser';
import { StreamChunk, type TokenUsage, type ToolCall } from '../adapters/types';
import { SSEStreamOptions } from './SSEStreamProcessor';

interface BufferedSSEUsagePayload {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  input_tokens?: number;
  output_tokens?: number;
}

interface BufferedSSEToolCallDelta {
  index?: number;
  id?: string;
  type?: ToolCall['type'];
  function?: {
    name?: string;
    arguments?: string;
  };
  reasoning_details?: ToolCall['reasoning_details'];
  thought_signature?: string;
}

function parseSSEEventData<TParsed>(rawData: string): TParsed {
  return JSON.parse(rawData) as TParsed;
}

function createAccumulatedToolCall(toolCall: BufferedSSEToolCallDelta): ToolCall {
  const accumulated: ToolCall = {
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

  return accumulated;
}

function getUsageFallbackValue(...values: Array<number | undefined>): number {
  for (const value of values) {
    if (value) {
      return value;
    }
  }

  return 0;
}

export class BufferedSSEStreamProcessor {
  static async* processSSEText<
    TParsed,
    TUsage extends BufferedSSEUsagePayload,
    TToolCall extends BufferedSSEToolCallDelta
  >(
    sseText: string,
    options: SSEStreamOptions<TParsed, TUsage, TToolCall>
  ): AsyncGenerator<StreamChunk, void, unknown> {
    const eventQueue: StreamChunk[] = [];
    let isCompleted = false;
    let usage: TUsage | undefined = undefined;
    let metadata: Record<string, unknown> | undefined = undefined;
    const toolCallsAccumulator: Map<number, ToolCall> = new Map();

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
        const parsed = parseSSEEventData<TParsed>(event.data);

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
              const accumulated = createAccumulatedToolCall(toolCall);

              toolCallsAccumulator.set(index, accumulated);
              shouldYieldToolCalls = options.toolCallThrottling?.initialYield !== false;
            } else {
              const existing = toolCallsAccumulator.get(index);
              if (!existing) {
                continue;
              }

              if (toolCall.id) {
                existing.id = toolCall.id;
              }
              if (toolCall.function?.name) {
                existing.function.name = toolCall.function.name;
              }
              if (toolCall.function?.arguments) {
                existing.function.arguments += toolCall.function.arguments;
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
              toolCalls: Array.from(toolCallsAccumulator.values())
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

function formatUsage<TUsage extends BufferedSSEUsagePayload>(usage?: TUsage): TokenUsage | undefined {
  if (!usage) {
    return undefined;
  }

  return {
    promptTokens: getUsageFallbackValue(
      usage.prompt_tokens,
      usage.promptTokenCount,
      usage.promptTokens,
      usage.input_tokens
    ),
    completionTokens: getUsageFallbackValue(
      usage.completion_tokens,
      usage.candidatesTokenCount,
      usage.completionTokens,
      usage.output_tokens
    ),
    totalTokens: getUsageFallbackValue(
      usage.total_tokens,
      usage.totalTokenCount,
      usage.totalTokens
    )
  };
}

function getFinalToolCalls(
  toolCallsAccumulator: Map<number, ToolCall>,
  options: SSEStreamOptions
): ToolCall[] | undefined {
  if (!options.accumulateToolCalls || toolCallsAccumulator.size === 0) {
    return undefined;
  }

  return Array.from(toolCallsAccumulator.values());
}
