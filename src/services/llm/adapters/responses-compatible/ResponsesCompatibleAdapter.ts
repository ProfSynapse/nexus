import { createParser } from 'eventsource-parser';
import type {
  LLMProviderConfig,
  OpenAICompatibleModelDefinition,
  ResponsesCompatibleAuthMode,
  ResponsesCompatibleStateMode,
} from '../../../../types/llm/ProviderTypes';
import { BaseAdapter } from '../BaseAdapter';
import {
  LLMProviderError,
  type GenerateOptions,
  type LLMResponse,
  type ModelInfo,
  type ModelPricing,
  type ProviderCapabilities,
  type StreamChunk,
  type TokenUsage,
  type Tool,
  type ToolCall,
} from '../types';
import { OPENAI_MODELS } from '../openai/OpenAIModels';
import {
  isOpenAICompatibleModelId,
  OPENAI_COMPATIBLE_GENERATION_TIMEOUT_MS,
} from '../openai-compatible/OpenAICompatibleConfig';
import {
  clampEffortToSupportedTiers,
  resolveDefinitionThinking,
  stripCompatibleModelPrefix,
} from '../shared/CompatibleEndpointUtils';
import { acceptsSamplingParams } from '../shared/SamplingParams';
import { pumpSseEventQueue } from '../shared/SseStreamPump';
import {
  createProviderStreamError,
  extractResponsesApiStreamError,
} from '../../streaming/streamErrorFrames';
import { mapOpenAIThinkingEffort } from '../../utils/ThinkingEffortMapper';
import { TokenUsageExtractor } from '../../utils/TokenUsageExtractor';
import { synthesizeToolCallId } from '../../utils/toolCallId';
import {
  buildResponsesCompatibleModels,
  RESPONSES_COMPATIBLE_CONTEXT_WINDOW,
  responsesCompatibleHeaders,
  validateResponsesCompatibleConfig,
} from './ResponsesCompatibleConfig';

interface ResponsesApiContentPart {
  type?: string;
  text?: string;
}

interface ResponsesApiItem {
  type?: string;
  id?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  encrypted_content?: string | null;
  summary?: Array<{ type?: string; text?: string }>;
  content?: ResponsesApiContentPart[];
}

interface ResponsesApiEvent {
  type?: string;
  delta?: string | { text?: string; content?: string };
  content?: string;
  message?: unknown;
  text?: string;
  output_index?: number;
  item_id?: string;
  part?: ResponsesApiContentPart;
  item?: ResponsesApiItem;
  response?: {
    id?: string;
    status?: string;
    incomplete_details?: { reason?: string };
    usage?: unknown;
    output?: ResponsesApiItem[];
  };
}

interface ResponsesApiResponse {
  id?: string;
  status?: string;
  incomplete_details?: { reason?: string };
  output?: ResponsesApiItem[];
  output_text?: string;
  usage?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function extractEventDeltaText(event: ResponsesApiEvent): string | null {
  if (typeof event.delta === 'string' && event.delta.length > 0) {
    return event.delta;
  }
  if (event.delta && typeof event.delta === 'object') {
    if (typeof event.delta.text === 'string' && event.delta.text.length > 0) {
      return event.delta.text;
    }
    if (typeof event.delta.content === 'string' && event.delta.content.length > 0) {
      return event.delta.content;
    }
  }
  if (event.type === 'response.output_text.delta' && typeof event.content === 'string' && event.content.length > 0) {
    return event.content;
  }
  return null;
}

function isStreamRequiredResponse(json: unknown, text: string): boolean {
  const body = asRecord(json);
  const candidates: unknown[] = [
    body?.error,
    asRecord(body?.error)?.message,
    body?.message,
    body?.detail,
    asRecord(body?.detail)?.message,
    text,
  ];
  return candidates.some(candidate => typeof candidate === 'string' && /stream/i.test(candidate));
}

function isSseResponsePayload(
  headers: Record<string, string> | undefined,
  json: unknown,
  text: string,
): boolean {
  if (headers) {
    for (const [key, value] of Object.entries(headers)) {
      if (key.toLowerCase() === 'content-type' && typeof value === 'string' && /text\/event-stream/i.test(value)) {
        return true;
      }
    }
  }
  return !json && /^\s*(?:event:|data:)/m.test(text);
}

function textToNodeStream(text: string): NodeJS.ReadableStream {
  const payload = text.endsWith('\n\n') ? text : `${text}\n\n`;
  const iterable: AsyncIterable<string> = {
    [Symbol.asyncIterator](): AsyncIterator<string> {
      let yielded = false;
      return {
        next(): Promise<IteratorResult<string>> {
          if (yielded) {
            return Promise.resolve({ value: undefined, done: true });
          }
          yielded = true;
          return Promise.resolve({ value: payload, done: false });
        },
      };
    },
  };
  return iterable as unknown as NodeJS.ReadableStream;
}

/** Named third-party OpenAI Responses API endpoint (`/v1/responses`). */
export class ResponsesCompatibleAdapter extends BaseAdapter {
  readonly name: string;
  readonly baseUrl: string;
  private readonly responsesUrl: string;
  private readonly stateMode: ResponsesCompatibleStateMode;
  private readonly authMode: ResponsesCompatibleAuthMode;
  private readonly savedModels: ModelInfo[];
  private readonly modelDefinitions: Record<string, OpenAICompatibleModelDefinition>;
  private readonly activeRequests = new Set<AbortController>();
  private disposed = false;

  constructor(config: LLMProviderConfig, instanceId: string) {
    const resolved = validateResponsesCompatibleConfig(config);
    const savedModels = buildResponsesCompatibleModels(config);
    super(config.apiKey, savedModels[0]?.id ?? '', resolved.baseUrl, false);
    this.name = instanceId;
    this.baseUrl = resolved.baseUrl;
    this.responsesUrl = resolved.responsesUrl;
    this.stateMode = config.responsesCompatible?.stateMode ?? 'stateless';
    this.authMode = config.responsesCompatible?.authMode ?? 'bearer';
    this.savedModels = savedModels;
    this.modelDefinitions = config.responsesCompatible?.models ?? {};
    this.initializeCache();
  }

  override generate(prompt: string, options?: GenerateOptions): Promise<LLMResponse> {
    return this.generateUncached(prompt, options);
  }

  private resolveTargetModel(options?: GenerateOptions): string {
    const model = options?.model || this.currentModel;
    if (!isOpenAICompatibleModelId(model)) {
      throw new LLMProviderError(
        'Select a model configured on this Responses-compatible endpoint before sending a message.',
        this.name,
        'CONFIGURATION_ERROR',
      );
    }
    return model;
  }

  private requestScope(signal?: AbortSignal): { signal: AbortSignal; cleanup: () => void } {
    if (this.disposed) {
      throw new LLMProviderError('This endpoint was closed while the request was starting.', this.name, 'ABORTED');
    }
    const controller = new AbortController();
    this.activeRequests.add(controller);
    const relay = () => controller.abort();
    if (signal?.aborted) {
      controller.abort();
    } else {
      signal?.addEventListener('abort', relay, { once: true });
    }
    return {
      signal: controller.signal,
      cleanup: () => {
        signal?.removeEventListener('abort', relay);
        this.activeRequests.delete(controller);
      },
    };
  }

  private abortError(signal: AbortSignal): LLMProviderError {
    if (signal.reason instanceof LLMProviderError) {
      return signal.reason;
    }
    return new LLMProviderError('Request aborted.', this.name, 'ABORTED');
  }

  private buildRequestBody(
    prompt: string,
    options: GenerateOptions | undefined,
    model: string,
    stream: boolean,
  ): Record<string, unknown> {
    const bareModel = stripCompatibleModelPrefix(model);
    const body: Record<string, unknown> = {
      model,
      stream,
    };

    if (this.stateMode === 'stateful') {
      body.input = options?.conversationHistory?.length ? options.conversationHistory : prompt;
      if (options?.systemPrompt) {
        body.instructions = options.systemPrompt;
      }
      if (options?.previousResponseId) {
        body.previous_response_id = options.previousResponseId;
      }
    } else {
      body.input = options?.conversationHistory?.length
        ? options.conversationHistory
        : [{ role: 'user', content: prompt }];
      body.instructions = options?.systemPrompt || '';
      body.store = false;
    }

    if (options?.enableTools !== false && options?.tools && options.tools.length > 0) {
      body.tools = options.tools.map((tool: Tool) => {
        if (tool.function) {
          const fn = tool.function as NonNullable<Tool['function']> & { strict?: boolean | null };
          const converted: Record<string, unknown> = {
            type: 'function',
            name: fn.name,
            parameters: fn.parameters || {},
          };
          if (fn.description) {
            converted.description = fn.description;
          }
          if (fn.strict !== undefined && fn.strict !== null) {
            converted.strict = fn.strict;
          }
          return converted;
        }
        return tool;
      });
      body.tool_choice = 'auto';
    }

    if (options?.webSearch) {
      const existingTools: unknown[] = Array.isArray(body.tools) ? (body.tools as unknown[]) : [];
      body.tools = [...existingTools, { type: 'web_search' }];
    }

    const allowSampling = !options?.enableThinking && acceptsSamplingParams(OPENAI_MODELS, bareModel);
    if (allowSampling && options?.temperature !== undefined) {
      body.temperature = options.temperature;
    }
    if (allowSampling && options?.topP !== undefined) {
      body.top_p = options.topP;
    }
    if (options?.maxTokens !== undefined) {
      body.max_output_tokens = options.maxTokens;
    }

    if (options?.enableThinking) {
      const resolved = resolveDefinitionThinking(this.modelDefinitions[model]);
      if (resolved.supportsThinking !== false) {
        const rawEffort = options.thinkingEffort || 'medium';
        body.reasoning = {
          effort: resolved.efforts?.length
            ? clampEffortToSupportedTiers(rawEffort, resolved.efforts)
            : mapOpenAIThinkingEffort(rawEffort, bareModel),
          summary: 'auto',
        };
      }
    }

    return body;
  }

  private async collectStreamResponse(
    stream: AsyncGenerator<StreamChunk, void, unknown>,
    model: string,
  ): Promise<LLMResponse> {
    let fullText = '';
    let fullThinking = '';
    let finalUsage: TokenUsage | undefined;
    let collectedToolCalls: ToolCall[] = [];
    let responseId: string | undefined;
    let finishReason: LLMResponse['finishReason'] = 'stop';

    for await (const chunk of stream) {
      if (chunk.content) {
        fullText += chunk.content;
      }
      if (chunk.reasoning) {
        fullThinking += chunk.reasoning;
      }
      if (chunk.usage) {
        finalUsage = chunk.usage;
      }
      if (chunk.toolCalls && chunk.toolCalls.length > 0) {
        collectedToolCalls = chunk.toolCalls;
      }
      if (typeof chunk.metadata?.responseId === 'string' && chunk.metadata.responseId) {
        responseId = chunk.metadata.responseId;
      }
      if (chunk.finishReason) {
        finishReason = chunk.finishReason;
      }
    }

    const hasToolCalls = collectedToolCalls.length > 0;
    const metadata: Record<string, unknown> = {
      ...(responseId ? { responseId } : {}),
      ...(fullThinking ? { thinking: fullThinking } : {}),
    };

    return await this.buildLLMResponse(
      fullText,
      model,
      finalUsage,
      metadata,
      hasToolCalls ? 'tool_calls' : finishReason,
      hasToolCalls ? collectedToolCalls : undefined,
    );
  }

  private async parseNonStreamingResponse(
    responseJson: ResponsesApiResponse | null,
    model: string,
  ): Promise<LLMResponse> {
    if (!responseJson || ((!Array.isArray(responseJson.output) || responseJson.output.length === 0)
      && (typeof responseJson.output_text !== 'string' || !responseJson.output_text))) {
      throw new Error('No output from Responses API');
    }

    let text = '';
    let thinking = '';
    for (const item of responseJson.output ?? []) {
      if (item.type === 'reasoning') {
        if (Array.isArray(item.summary)) {
          thinking += item.summary.map(part => part.text || '').join('');
        }
        if (Array.isArray(item.content)) {
          for (const part of item.content) {
            if ((part.type === 'reasoning_text' || part.type === 'text') && part.text) {
              thinking += part.text;
            }
          }
        }
      }
      if (item.type === 'message' && Array.isArray(item.content)) {
        for (const contentPart of item.content) {
          if ((contentPart.type === 'output_text' || contentPart.type === 'text') && contentPart.text) {
            text += contentPart.text;
          }
        }
      }
    }

    if (!text && typeof responseJson.output_text === 'string') {
      text = responseJson.output_text;
    }

    const usage = responseJson.usage
      ? TokenUsageExtractor.normalize(responseJson.usage)
      : undefined;
    const metadata: Record<string, unknown> = {
      ...(responseJson.id ? { responseId: responseJson.id } : {}),
      ...(thinking ? { thinking } : {}),
    };
    const finishReason: LLMResponse['finishReason'] = responseJson.status === 'incomplete'
      && responseJson.incomplete_details?.reason === 'max_output_tokens'
      ? 'length'
      : 'stop';

    return await this.buildLLMResponse(text, model, usage, metadata, finishReason);
  }

  async generateUncached(prompt: string, options?: GenerateOptions): Promise<LLMResponse> {
    const model = this.resolveTargetModel(options);
    const scope = this.requestScope(options?.abortSignal);

    try {
      if (options?.tools && options.tools.length > 0) {
        throw new Error('Tool execution requires streaming. Use generateStreamAsync() instead.');
      }

      const body = this.buildRequestBody(prompt, options, model, false);
      const response = await this.request<ResponsesApiResponse>({
        url: this.responsesUrl,
        operation: 'generation',
        method: 'POST',
        headers: responsesCompatibleHeaders(this.apiKey, this.authMode),
        body: JSON.stringify(body),
        timeoutMs: OPENAI_COMPATIBLE_GENERATION_TIMEOUT_MS,
        signal: scope.signal,
        retries: 0,
      });

      if (!response.ok && response.status === 400 && isStreamRequiredResponse(response.json, response.text)) {
        return await this.collectStreamResponse(
          this.generateStreamAsync(prompt, { ...options, model, abortSignal: scope.signal }),
          model,
        );
      }

      if (response.ok && isSseResponsePayload(response.headers, response.json, response.text)) {
        return await this.collectStreamResponse(
          this.processResponsesNodeStream(textToNodeStream(response.text)),
          model,
        );
      }

      this.assertOk(response, `Responses generation failed: HTTP ${response.status}`);

      const jsonError = extractResponsesApiStreamError(response.json, 'Responses generation error');
      if (jsonError) {
        throw createProviderStreamError(jsonError, this.name, response.json);
      }

      return await this.parseNonStreamingResponse(response.json, model);
    } catch (error) {
      if (scope.signal.aborted) {
        throw this.abortError(scope.signal);
      }
      this.handleError(error, 'generation');
    } finally {
      scope.cleanup();
    }
  }

  async* generateStreamAsync(prompt: string, options?: GenerateOptions): AsyncGenerator<StreamChunk, void, unknown> {
    const model = this.resolveTargetModel(options);
    const scope = this.requestScope(options?.abortSignal);

    try {
      const body = this.buildRequestBody(prompt, options, model, true);
      const nodeStream = await this.requestStream({
        url: this.responsesUrl,
        operation: 'streaming generation',
        method: 'POST',
        headers: responsesCompatibleHeaders(this.apiKey, this.authMode),
        body: JSON.stringify(body),
        timeoutMs: OPENAI_COMPATIBLE_GENERATION_TIMEOUT_MS,
        signal: scope.signal,
      });

      for await (const chunk of this.processResponsesNodeStream(nodeStream)) {
        if (scope.signal.aborted) {
          throw this.abortError(scope.signal);
        }
        yield chunk;
      }
    } catch (error) {
      if (scope.signal.aborted) {
        throw this.abortError(scope.signal);
      }
      this.handleError(error, 'streaming generation');
    } finally {
      scope.cleanup();
    }
  }

  private async* processResponsesNodeStream(nodeStream: NodeJS.ReadableStream): AsyncGenerator<StreamChunk, void, unknown> {
    let currentResponseId: string | null = null;
    const toolCallsMap = new Map<number, ToolCall>();
    let usage: TokenUsage | undefined;
    let currentReasoningId: string | null = null;
    let isInReasoningPart = false;
    let emittedAnyText = false;
    const textSeenByOutputIndex = new Set<number>();
    const finalizedTextItemIds = new Set<string>();
    const reasoningSeenByItemId = new Set<string>();
    const pumpState = { isCompleted: false };
    let streamError: string | undefined;
    let streamErrorFrame: unknown;

    const eventQueue: StreamChunk[] = [];

    const buildCompletionChunk = (finishReason?: LLMResponse['finishReason']): StreamChunk => {
      const toolCallsArray = Array.from(toolCallsMap.entries())
        .sort(([a], [b]) => a - b)
        .map(([, call]) => call);
      const metadata = currentResponseId ? { responseId: currentResponseId } : undefined;
      return {
        content: '',
        complete: true,
        usage,
        toolCalls: toolCallsArray.length > 0 ? toolCallsArray : undefined,
        toolCallsReady: toolCallsArray.length > 0,
        finishReason: finishReason ?? (toolCallsArray.length > 0 ? 'tool_calls' : 'stop'),
        ...(metadata ? { metadata } : {}),
      };
    };

    const recordEmittedText = (outputIndex: number | undefined, itemId: string | undefined): void => {
      emittedAnyText = true;
      if (typeof outputIndex === 'number') {
        textSeenByOutputIndex.add(outputIndex);
      }
      if (itemId) {
        finalizedTextItemIds.add(itemId);
      }
    };

    const parser = createParser((sseEvent) => {
      if (sseEvent.type === 'reconnect-interval' || pumpState.isCompleted) return;
      if (sseEvent.data === '[DONE]') {
        eventQueue.push(buildCompletionChunk());
        pumpState.isCompleted = true;
        return;
      }

      let event: ResponsesApiEvent;
      try {
        const parsed = JSON.parse(sseEvent.data) as unknown;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return;
        }
        event = parsed;
      } catch {
        if (sseEvent.event === 'error' && sseEvent.data.trim()) {
          streamError = sseEvent.data.trim();
          pumpState.isCompleted = true;
        }
        return;
      }

      const errorMessage = extractResponsesApiStreamError(event, 'Responses streaming error')
        ?? (sseEvent.event === 'error'
          ? (typeof event.message === 'string' && event.message.trim()) || 'Responses streaming error'
          : null);
      if (errorMessage) {
        streamError = errorMessage;
        streamErrorFrame = event;
        pumpState.isCompleted = true;
        return;
      }

      if (event.response?.id && !currentResponseId) {
        currentResponseId = event.response.id;
      }

      switch (event.type) {
        case 'response.output_text.delta': {
          const text = extractEventDeltaText(event);
          if (text) {
            recordEmittedText(event.output_index, event.item_id);
            eventQueue.push({ content: text, complete: false });
          }
          break;
        }

        case 'response.output_item.added': {
          const item = event.item;
          if (!item) break;
          if (item.type === 'reasoning') {
            currentReasoningId = item.id || null;
            eventQueue.push({
              content: '',
              complete: false,
              reasoning: '',
              reasoningComplete: false,
              reasoningId: item.id || undefined,
            });
          } else if (item.type === 'message' && Array.isArray(item.content)) {
            for (const part of item.content) {
              if ((part.type === 'output_text' || part.type === 'text') && part.text) {
                recordEmittedText(event.output_index, item.id);
                eventQueue.push({ content: part.text, complete: false });
              }
            }
          }
          break;
        }

        case 'response.content_part.added': {
          const part = event.part;
          if (!part) break;
          if (part.type === 'reasoning_text') {
            isInReasoningPart = true;
            const reasoningId = event.item_id || currentReasoningId || undefined;
            if (part.text) {
              reasoningSeenByItemId.add(reasoningId ?? '__default__');
              eventQueue.push({
                content: '',
                complete: false,
                reasoning: part.text,
                reasoningComplete: false,
                reasoningId,
              });
            }
          } else if (part.type === 'output_text' || part.type === 'text') {
            isInReasoningPart = false;
            if (part.text) {
              recordEmittedText(event.output_index, event.item_id);
              eventQueue.push({ content: part.text, complete: false });
            }
          }
          break;
        }

        case 'response.content_part.delta': {
          const deltaText = extractEventDeltaText(event);
          if (!deltaText) break;
          const isReasoningDelta = event.part?.type === 'reasoning_text'
            || (isInReasoningPart && event.part?.type !== 'output_text' && event.part?.type !== 'text');
          if (isReasoningDelta) {
            const reasoningId = event.item_id || currentReasoningId || undefined;
            reasoningSeenByItemId.add(reasoningId ?? '__default__');
            eventQueue.push({
              content: '',
              complete: false,
              reasoning: deltaText,
              reasoningComplete: false,
              reasoningId,
            });
          } else {
            recordEmittedText(event.output_index, event.item_id);
            eventQueue.push({ content: deltaText, complete: false });
          }
          break;
        }

        case 'response.content_part.done': {
          if (event.part?.type === 'reasoning_text' || isInReasoningPart) {
            isInReasoningPart = false;
            eventQueue.push({
              content: '',
              complete: false,
              reasoning: '',
              reasoningComplete: true,
              reasoningId: event.item_id || currentReasoningId || undefined,
            });
          }
          break;
        }

        case 'response.output_item.done': {
          const item = event.item;
          if (!item) break;
          if (item.type === 'function_call') {
            const index = typeof event.output_index === 'number' ? event.output_index : toolCallsMap.size;
            toolCallsMap.set(index, {
              id: item.call_id || item.id || synthesizeToolCallId('responses'),
              type: 'function',
              function: {
                name: item.name || '',
                arguments: item.arguments || '{}',
              },
            });
          } else if (item.type === 'reasoning') {
            isInReasoningPart = false;
            const encrypted = item.encrypted_content || null;
            eventQueue.push({
              content: '',
              complete: false,
              reasoning: '',
              reasoningComplete: true,
              reasoningId: item.id || currentReasoningId || undefined,
              ...(encrypted ? { reasoningEncryptedContent: encrypted } : {}),
            });
            currentReasoningId = null;
          } else if (item.type === 'message' && Array.isArray(item.content)) {
            const outputIndex = typeof event.output_index === 'number' ? event.output_index : -1;
            const itemId = item.id;
            const shouldEmitMessageText = !textSeenByOutputIndex.has(outputIndex)
              && !(itemId && finalizedTextItemIds.has(itemId));
            if (shouldEmitMessageText) {
              for (const part of item.content) {
                if ((part.type === 'output_text' || part.type === 'text') && part.text) {
                  recordEmittedText(event.output_index, itemId);
                  eventQueue.push({ content: part.text, complete: false });
                }
              }
            }
          }
          break;
        }

        case 'response.output_text.done': {
          if (!event.text) break;
          const outputIndex = typeof event.output_index === 'number' ? event.output_index : -1;
          const shouldEmitDoneText = !textSeenByOutputIndex.has(outputIndex)
            && !(event.item_id && finalizedTextItemIds.has(event.item_id));
          if (shouldEmitDoneText) {
            recordEmittedText(event.output_index, event.item_id);
            eventQueue.push({ content: event.text, complete: false });
          }
          break;
        }

        case 'response.reasoning_summary_text.delta':
        case 'response.reasoning_text.delta': {
          const deltaText = extractEventDeltaText(event);
          if (deltaText) {
            const reasoningId = event.item_id || currentReasoningId || undefined;
            reasoningSeenByItemId.add(reasoningId ?? '__default__');
            eventQueue.push({
              content: '',
              complete: false,
              reasoning: deltaText,
              reasoningComplete: false,
              reasoningId,
            });
          }
          break;
        }

        case 'response.reasoning_summary_text.done':
        case 'response.reasoning_text.done': {
          const reasoningId = event.item_id || currentReasoningId || undefined;
          const key = reasoningId ?? '__default__';
          const fallbackText = event.text && !reasoningSeenByItemId.has(key) ? event.text : '';
          if (fallbackText) {
            reasoningSeenByItemId.add(key);
          }
          eventQueue.push({
            content: '',
            complete: false,
            reasoning: fallbackText,
            reasoningComplete: true,
            reasoningId,
          });
          break;
        }

        case 'response.reasoning_summary_part.done': {
          eventQueue.push({
            content: '',
            complete: false,
            reasoning: '',
            reasoningComplete: true,
            reasoningId: event.item_id || currentReasoningId || undefined,
          });
          break;
        }

        case 'response.done':
        case 'response.completed':
        case 'response.incomplete': {
          if (event.response?.id) {
            currentResponseId = event.response.id;
          }
          if (event.response?.usage) {
            usage = TokenUsageExtractor.normalize(event.response.usage);
          }
          if (toolCallsMap.size === 0 && Array.isArray(event.response?.output)) {
            event.response.output.forEach((item, index) => {
              if (item.type === 'function_call') {
                toolCallsMap.set(index, {
                  id: item.call_id || item.id || synthesizeToolCallId('responses'),
                  type: 'function',
                  function: {
                    name: item.name || '',
                    arguments: item.arguments || '{}',
                  },
                });
              }
            });
          }
          if (!emittedAnyText && Array.isArray(event.response?.output)) {
            for (const item of event.response.output) {
              if (item.type === 'message' && Array.isArray(item.content)) {
                for (const part of item.content) {
                  if ((part.type === 'output_text' || part.type === 'text') && part.text) {
                    emittedAnyText = true;
                    eventQueue.push({ content: part.text, complete: false });
                  }
                }
              }
            }
          }
          const isLengthLimit = event.type === 'response.incomplete'
            || (event.response?.status === 'incomplete'
              && event.response?.incomplete_details?.reason === 'max_output_tokens');
          eventQueue.push(buildCompletionChunk(
            toolCallsMap.size > 0 ? 'tool_calls' : isLengthLimit ? 'length' : 'stop',
          ));
          pumpState.isCompleted = true;
          break;
        }

        default:
          break;
      }
    });

    yield* pumpSseEventQueue(nodeStream, text => parser.feed(text), eventQueue, pumpState, {
      buildFinalChunk: () => (streamError ? { content: '', complete: false } : buildCompletionChunk()),
      buildErrorChunk: () => ({ content: '', complete: false }),
    });

    if (streamError) {
      throw createProviderStreamError(streamError, this.name, streamErrorFrame);
    }
  }

  listModels(): Promise<ModelInfo[]> {
    return Promise.resolve(this.savedModels.map(model => ({ ...model })));
  }

  override isAvailable(): Promise<boolean> {
    return Promise.resolve(!this.disposed && this.savedModels.length > 0);
  }

  getCapabilities(): ProviderCapabilities {
    const maxContextWindow = this.savedModels.reduce(
      (max, model) => Math.max(max, model.contextWindow),
      RESPONSES_COMPATIBLE_CONTEXT_WINDOW,
    );
    return {
      supportsStreaming: true,
      streamingMode: 'streaming',
      supportsJSON: true,
      supportsImages: true,
      supportsFunctions: true,
      supportsThinking: true,
      maxContextWindow,
      supportedFeatures: ['responses', 'streaming', 'function_calling', 'thinking_models', 'json_mode'],
    };
  }

  getModelPricing(_modelId: string): Promise<ModelPricing | null> {
    return Promise.resolve(null);
  }

  override async clearCache(): Promise<void> {
    await super.clearCache();
  }

  dispose(): void {
    this.disposed = true;
    for (const controller of this.activeRequests) {
      controller.abort();
    }
    this.activeRequests.clear();
  }
}
