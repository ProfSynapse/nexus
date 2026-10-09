/**
 * Anthropic Claude Adapter with true streaming support
 * Implements Anthropic's SSE streaming protocol
 * Uses Anthropic's Messages REST API with buffered SSE replay.
 */

import { BaseAdapter } from '../BaseAdapter';
import {
  GenerateOptions,
  StreamChunk,
  LLMResponse,
  ModelInfo,
  ProviderCapabilities,
  ModelPricing,
  ToolCall,
  TokenUsage,
  SearchResult
} from '../types';
import { WebSearchUtils } from '../../utils/WebSearchUtils';
import { extractStreamErrorMessage } from '../../streaming/streamErrorFrames';
import { ANTHROPIC_MODELS, ANTHROPIC_DEFAULT_MODEL } from './AnthropicModels';
import { ThinkingEffortMapper, mapAnthropicAdaptiveEffort } from '../../utils/ThinkingEffortMapper';
import { staticModelToModelInfo, getStaticModelPricing } from '../shared/StaticModelHelpers';
import type { AnthropicThinkingBlock, ThinkingEffort } from '../../../../types/llm/ProviderTypes';
import { TokenUsageExtractor } from '../../utils/TokenUsageExtractor';
import { acceptsSamplingParams } from '../shared/SamplingParams';

interface AnthropicMessage {
  role: string;
  content: string | AnthropicContentBlock[];
}

interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  server_tool_use?: { web_search_requests?: number };
}

interface AnthropicToolDefinition {
  type?: string;
  name?: string;
  description?: string;
  max_uses?: number;
  input_schema?: unknown;
  function?: {
    name?: string;
    description?: string;
    parameters?: unknown;
    input_schema?: unknown;
  };
}

type AnthropicToolInput = {
  type?: string;
  name?: string;
  description?: string;
  parameters?: unknown;
  input_schema?: unknown;
  function?: {
    name?: string;
    description?: string;
    parameters?: unknown;
    input_schema?: unknown;
  };
};

interface AnthropicContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  thinking?: string;
  type_name?: string;
  content?: AnthropicContentBlock[];
  title?: string;
  url?: string;
  citations?: Array<{ type?: string; title?: string; url?: string }>;
}

interface AnthropicResponse {
  model?: string;
  stop_reason?: string | null;
  stop_sequence?: string | null;
  content?: AnthropicContentBlock[];
  usage?: AnthropicUsage;
  error?: { message?: string };
  message?: { usage?: AnthropicUsage };
}

interface AnthropicStreamEvent extends AnthropicResponse {
  type?: string;
  index?: number;
  content_block?: {
    type?: string;
    id?: string;
    name?: string;
    thinking?: string;
    signature?: string;
    data?: string;
    content?: AnthropicContentBlock[];
    citations?: Array<{ type?: string; title?: string; url?: string }>;
  };
  delta?: {
    type?: string;
    text?: string;
    partial_json?: string;
    thinking?: string;
    signature?: string;
    stop_reason?: string | null;
    stop_sequence?: string | null;
    citation?: { type?: string; title?: string; url?: string };
  };
}

export class AnthropicAdapter extends BaseAdapter {
  readonly name = 'anthropic';
  readonly baseUrl = 'https://api.anthropic.com';

  constructor(apiKey: string, model?: string) {
    super(apiKey, model || ANTHROPIC_DEFAULT_MODEL);
    this.initializeCache();
  }

  async generateUncached(prompt: string, options?: GenerateOptions): Promise<LLMResponse> {
    return this.withRetry(async () => {
      try {
        // Tool execution requires streaming - use generateStreamAsync instead
        if (options?.tools && options.tools.length > 0) {
          throw new Error('Tool execution requires streaming. Use generateStreamAsync() instead.');
        }

        // Use basic message generation
        return await this.generateWithBasicMessages(prompt, options);
      } catch (error) {
        this.handleError(error, 'generation');
      }
    });
  }

  async* generateStreamAsync(prompt: string, options?: GenerateOptions): AsyncGenerator<StreamChunk, void, unknown> {
    try {
      // Build messages - use conversation history if provided (for tool continuations)
      let messages: AnthropicMessage[];
      if (options?.conversationHistory && options.conversationHistory.length > 0) {
        // Use provided conversation history for tool continuations
        messages = options.conversationHistory as unknown as AnthropicMessage[];
      } else {
        // Build simple messages for initial request
        messages = this.buildMessages(prompt, options?.systemPrompt);
      }

      let maxTokens = this.resolveMaxTokens(options);
      const tools: AnthropicToolDefinition[] = [];
      const requestParams: Record<string, unknown> = {
        model: this.normalizeModelId(options?.model || this.currentModel),
        max_tokens: maxTokens,
        messages: messages.filter(msg => msg.role !== 'system'),
        temperature: options?.temperature,
        stream: true
      };
      this.dropUnsupportedSampling(requestParams);

      // Add system message if provided (either from messages or from options).
      // Sent as a block with a cache breakpoint: the system prompt is the stable
      // prefix now that history travels as turns, so Anthropic can serve it
      // from cache on every turn after the first. Below the model's minimum
      // cacheable length the marker is ignored, which costs nothing.
      const systemMessage = messages.find(msg => msg.role === 'system');
      const systemText = systemMessage
        ? this.contentToText(systemMessage.content)
        : options?.systemPrompt;
      if (systemText) {
        requestParams.system = [{
          type: 'text',
          text: systemText,
          cache_control: { type: 'ephemeral' }
        }];
      }

      // Use adaptive thinking on Claude 4.6+ and manual budgets on 4.5.
      if (options?.enableThinking && this.supportsThinking(options?.model || this.currentModel)) {
        const effort = options?.thinkingEffort || 'medium';
        maxTokens = this.applyThinkingConfig(
          requestParams,
          options?.model || this.currentModel,
          effort,
          maxTokens
        );
      } else {
        this.applyDisabledThinkingConfig(requestParams, options);
      }

      // Add tools if provided
      if (options?.tools && options.tools.length > 0) {
        tools.push(...this.convertTools(options.tools));
      }

      // Add web search tool if requested
      if (options?.webSearch) {
        tools.push({
          type: 'web_search_20250305',
          name: 'web_search',
          max_uses: 5
        });
      }

      if (tools.length > 0) {
        // Tool definitions precede the system block in Anthropic's cache order;
        // marking the last one caches the whole tool list as well.
        const last = tools[tools.length - 1] as AnthropicToolDefinition & { cache_control?: { type: 'ephemeral' } };
        last.cache_control = { type: 'ephemeral' };
        requestParams.tools = tools;
      }

      // Look up model spec for beta headers (sent via HTTP header, not body field)
      const modelSpec = ANTHROPIC_MODELS.find(m => m.apiName === this.normalizeModelId(options?.model || this.currentModel));

      let usage: AnthropicUsage | undefined;
      let stopReason: string | null = null;
      let thinkingBlockIndex: number | null = null;  // Track thinking block for completion
      const thinkingBlocks = new Map<number, AnthropicThinkingBlock>();
      const clientToolIndices = new Set<number>();
      const webSources = new Map<string, SearchResult>();
      const responseBlocks = new Map<number, Record<string, unknown>>();
      const nodeStream = await this.requestStream({
        url: `${this.baseUrl}/v1/messages`,
        operation: 'streaming generation',
        method: 'POST',
        headers: this.buildAnthropicHeaders(modelSpec?.betaHeaders),
        body: JSON.stringify(requestParams),
        timeoutMs: 120_000
      });

      yield* this.processNodeStream(nodeStream, {
        debugLabel: 'Anthropic',
        yieldMetadataUpdates: true,
        yieldUsageUpdates: true,
        extractMetadata: (parsed) => {
          this.captureThinkingBlock(parsed, thinkingBlocks);
          const event = parsed as AnthropicStreamEvent;
          this.captureResponseBlock(event, responseBlocks);
          const result: Record<string, unknown> = {};
          if (event.type === 'message_stop') {
            result.anthropicResponseContent = Array.from(responseBlocks.entries())
              .sort(([a], [b]) => a - b).map(([, block]) => block);
          }
          if (event.type === 'content_block_start' && event.content_block?.type) {
            this.addAnthropicSources({ ...event.content_block, type: event.content_block.type }, webSources);
          }
          if (event.type === 'content_block_delta' && event.delta?.citation) {
            this.addAnthropicSources({ type: 'text', citations: [event.delta.citation] }, webSources);
          }
          if (webSources.size > 0) result.webSearchResults = Array.from(webSources.values());
          if (typeof event.delta?.stop_reason === 'string') {
            stopReason = event.delta.stop_reason;
            result.stopReason = stopReason;
          }
          if (event.delta && 'stop_sequence' in event.delta
            && (typeof event.delta.stop_sequence === 'string' || event.delta.stop_sequence === null)) {
            result.stopSequence = event.delta.stop_sequence;
          }
          return Object.keys(result).length > 0 ? result : null;
        },
        extractContent: (event: AnthropicStreamEvent) => {
          // message_start carries the input classes (input, cache read, cache
          // write); message_delta carries the final output count and may repeat
          // the input classes. Merge so neither event drops the other's fields.
          if (event.type === 'message_start' && event.message?.usage) {
            usage = { ...usage, ...event.message.usage };
          } else if (event.type === 'message_delta' && event.usage) {
            usage = { ...usage, ...event.usage };
          } else if (event.type === 'content_block_start' && event.content_block?.type === 'thinking') {
            thinkingBlockIndex = event.index ?? null;
          }

          if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
            return event.delta.text || null;
          }
          return null;
        },
        extractToolCalls: (event: AnthropicStreamEvent) => {
          const preservedThinkingBlocks = Array.from(thinkingBlocks.entries())
            .sort(([left], [right]) => left - right)
            .map(([, block]) => block);
          if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
            if (event.index !== undefined) clientToolIndices.add(event.index);
            return [{
              index: event.index,
              id: event.content_block.id || `anthropic-tool-${event.index ?? 0}`,
              type: 'function',
              function: {
                name: event.content_block.name || '',
                arguments: ''
              },
              anthropic_thinking_blocks: preservedThinkingBlocks
            }];
          }

          if (event.type === 'content_block_delta' && event.delta?.type === 'input_json_delta'
            && event.index !== undefined && clientToolIndices.has(event.index)) {
            return [{
              index: event.index,
              id: `anthropic-tool-${event.index ?? 0}`,
              function: {
                name: '',
                arguments: event.delta.partial_json || ''
              },
              type: 'function',
              anthropic_thinking_blocks: preservedThinkingBlocks
            }];
          }

          return null;
        },
        extractFinishReason: (event: AnthropicStreamEvent) => {
          if (event.type === 'message_stop') {
            return this.mapStopReason(stopReason);
          }
          return null;
        },
        // Anthropic reports a fatal error over HTTP 200 as an `error` event:
        // {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}.
        // (This used to throw from extractFinishReason, where the processor's
        // parse-error guard swallowed it and the stream just ended silently.)
        extractError: (event: AnthropicStreamEvent & { error?: { type?: string; message?: string } }) => {
          if (event.type !== 'error' && !event.error) {
            return null;
          }
          const message = extractStreamErrorMessage(event, 'Anthropic streaming error');
          return message ? `Anthropic stream error: ${message}` : 'Anthropic stream error';
        },
        extractUsage: (event: AnthropicStreamEvent) =>
          event.type === 'message_start' || event.type === 'message_delta' ? usage : undefined,
        extractReasoning: (event: AnthropicStreamEvent) => {
          if (event.type === 'content_block_delta' && event.delta?.type === 'thinking_delta') {
            return {
              text: event.delta.thinking || '',
              complete: false
            };
          }

          if (event.type === 'content_block_stop' && thinkingBlockIndex !== null && event.index === thinkingBlockIndex) {
            thinkingBlockIndex = null;
            return {
              text: '',
              complete: true
            };
          }

          return null;
        },
        accumulateToolCalls: true,
        toolCallThrottling: {
          initialYield: true,
          progressInterval: 50
        }
      });
    } catch (error) {
      console.error('[AnthropicAdapter] Streaming error:', error);
      throw error;
    }
  }

  listModels(): Promise<ModelInfo[]> {
    try {
      return Promise.resolve(ANTHROPIC_MODELS.map(model => ({
        ...staticModelToModelInfo(model),
        // For 1M context models, append :1m to make ID unique
        id: model.contextWindow >= 1000000 ? `${model.apiName}:1m` : model.apiName
      })));
    } catch (error) {
      this.handleError(error, 'listing models');
      return Promise.resolve([]);
    }
  }

  getCapabilities(): ProviderCapabilities {
    return {
      supportsStreaming: true,
      streamingMode: 'streaming',
      supportsJSON: true,
      supportsImages: true,
      supportsFunctions: true,
      supportsThinking: true,
      maxContextWindow: 200000,
      supportedFeatures: [
        'messages',
        'extended_thinking',
        'function_calling',
        'web_search',
        'computer_use',
        'vision',
        'streaming'
      ]
    };
  }

  /**
   * Generate using basic message API without tools
   */
  private async generateWithBasicMessages(prompt: string, options?: GenerateOptions): Promise<LLMResponse> {
    const messages = this.buildMessages(prompt, options?.systemPrompt);
    let maxTokens = this.resolveMaxTokens(options);
    const tools: AnthropicToolDefinition[] = [];
    
    const requestParams: Record<string, unknown> = {
      model: this.normalizeModelId(options?.model || this.currentModel),
      max_tokens: maxTokens,
      messages: messages.filter(msg => msg.role !== 'system'),
      temperature: options?.temperature,
      stop_sequences: options?.stopSequences
    };
    this.dropUnsupportedSampling(requestParams);

    // Add system message if provided
    const systemMessage = messages.find(msg => msg.role === 'system');
    if (systemMessage) {
      requestParams.system = systemMessage.content;
    }

    // Use adaptive thinking on Claude 4.6+ and manual budgets on 4.5.
    if (options?.enableThinking && this.supportsThinking(options?.model || this.currentModel)) {
      const effort = options?.thinkingEffort || 'medium';
      maxTokens = this.applyThinkingConfig(
        requestParams,
        options?.model || this.currentModel,
        effort,
        maxTokens
      );
    } else {
      this.applyDisabledThinkingConfig(requestParams, options);
    }

    // Add tools if provided
    if (options?.tools && options.tools.length > 0) {
      tools.push(...this.convertTools(options.tools));
    }

    // Special tools
    if (options?.webSearch) {
      tools.push({
        type: 'web_search_20250305',
        name: 'web_search',
        max_uses: 5
      });
    }

    if (tools.length > 0) {
      requestParams.tools = tools;
    }

    // Look up model spec for beta headers (sent via HTTP header, not body field)
    const modelSpec = ANTHROPIC_MODELS.find(m => m.apiName === this.normalizeModelId(options?.model || this.currentModel));

    const response = await this.request<AnthropicResponse>({
      url: `${this.baseUrl}/v1/messages`,
      operation: 'generation',
      method: 'POST',
      headers: this.buildAnthropicHeaders(modelSpec?.betaHeaders),
      body: JSON.stringify(requestParams),
      timeoutMs: 60_000
    });
    this.assertOk(response, `Anthropic generation failed: HTTP ${response.status}`);
    const responseJson = response.json;
    if (!responseJson) {
      throw new Error('Invalid response from Anthropic API');
    }
    
    const extractedUsage = this.extractUsage(responseJson);
    const finishReason = this.mapStopReason(responseJson.stop_reason || null);
    const toolCalls = this.extractToolCalls(responseJson.content);
    const metadata = {
      thinking: this.extractThinking(responseJson),
      stopReason: responseJson.stop_reason,
      stopSequence: responseJson.stop_sequence,
      anthropicResponseContent: responseJson.content,
      webSearchResults: this.extractAnthropicSources(responseJson.content)
    };

    return await this.buildLLMResponse(
      this.extractTextFromContent(responseJson.content),
      responseJson.model || this.currentModel,
      extractedUsage,
      metadata,
      finishReason,
      toolCalls
    );
  }

  // Private methods

  private captureResponseBlock(event: AnthropicStreamEvent, blocks: Map<number, Record<string, unknown>>): void {
    if (event.index === undefined) return;
    if (event.type === 'content_block_start' && event.content_block) {
      blocks.set(event.index, { ...event.content_block });
      return;
    }
    const block = blocks.get(event.index);
    if (!block) return;
    if (event.type === 'content_block_stop') {
      if (typeof block['__partialInput'] === 'string') {
        try { block.input = JSON.parse(block['__partialInput']); } catch { /* Incomplete tool input remains absent. */ }
        delete block['__partialInput'];
      }
      return;
    }
    if (event.type !== 'content_block_delta' || !event.delta) return;
    const delta = event.delta;
    if (delta.type === 'text_delta' && typeof delta.text === 'string') {
      block.text = (typeof block.text === 'string' ? block.text : '') + delta.text;
    } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
      block.thinking = (typeof block.thinking === 'string' ? block.thinking : '') + delta.thinking;
    } else if (delta.type === 'signature_delta' && typeof delta.signature === 'string') {
      block.signature = (typeof block.signature === 'string' ? block.signature : '') + delta.signature;
    } else if (delta.type === 'citations_delta' && delta.citation) {
      const existing: unknown[] = Array.isArray(block.citations) ? block.citations as unknown[] : [];
      block.citations = [...existing, delta.citation];
    } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
      const json = (typeof block['__partialInput'] === 'string' ? block['__partialInput'] : '') + delta.partial_json;
      block['__partialInput'] = json;
    }
  }

  private extractAnthropicSources(blocks: AnthropicContentBlock[] | undefined): SearchResult[] {
    const sources = new Map<string, SearchResult>();
    for (const block of blocks || []) this.addAnthropicSources(block, sources);
    return Array.from(sources.values());
  }

  private addAnthropicSources(block: AnthropicContentBlock, sources: Map<string, SearchResult>): void {
    if (block.type === 'web_search_result') {
      const source = WebSearchUtils.validateSearchResult({ title: block.title || block.url, url: block.url });
      if (source) sources.set(source.url, source);
    }
    for (const citation of block.citations || []) {
      if (citation.type !== 'web_search_result_location') continue;
      const source = WebSearchUtils.validateSearchResult({ title: citation.title || citation.url, url: citation.url });
      if (source) sources.set(source.url, source);
    }
    if (Array.isArray(block.content)) {
      for (const child of block.content) this.addAnthropicSources(child, sources);
    }
  }

  /**
   * Normalize model ID by removing :1m suffix to match against apiName
   * The :1m suffix is used to distinguish the 1M context variant in the UI,
   * but both variants use the same API name with different beta headers
   */
  private normalizeModelId(modelId: string): string {
    return modelId.replace(':1m', '');
  }

  private resolveMaxTokens(options?: GenerateOptions): number {
    const modelId = this.normalizeModelId(options?.model || this.currentModel);
    // The request requires max_tokens; unknown model limits cannot be inferred.
    return options?.maxTokens ?? ANTHROPIC_MODELS.find(model => model.apiName === modelId)?.maxTokens ?? 4096;
  }

  private supportsThinking(modelId: string): boolean {
    const model = ANTHROPIC_MODELS.find(m => m.apiName === this.normalizeModelId(modelId));
    return model?.capabilities.supportsThinking || false;
  }

  private supportsAdaptiveThinking(modelId: string): boolean {
    const normalized = this.normalizeModelId(modelId);
    return /^claude-(?:(?:fable|mythos|opus|sonnet)-(?:5(?:-|$)|4-(?:6|7|8)(?:-|$))|haiku-5-5(?:-|$))/.test(normalized);
  }

  private captureThinkingBlock(
    event: AnthropicStreamEvent,
    blocks: Map<number, AnthropicThinkingBlock>
  ): void {
    const index = event.index;
    if (index === undefined) {
      return;
    }

    if (event.type === 'content_block_start' && event.content_block?.type === 'thinking') {
      blocks.set(index, {
        type: 'thinking',
        thinking: event.content_block.thinking || '',
        signature: event.content_block.signature || ''
      });
      return;
    }

    if (event.type === 'content_block_start' && event.content_block?.type === 'redacted_thinking') {
      blocks.set(index, {
        type: 'redacted_thinking',
        data: event.content_block.data || ''
      });
      return;
    }

    const existing = blocks.get(index);
    if (!existing || existing.type !== 'thinking' || event.type !== 'content_block_delta') {
      return;
    }

    if (event.delta?.type === 'thinking_delta') {
      existing.thinking += event.delta.thinking || '';
    } else if (event.delta?.type === 'signature_delta') {
      existing.signature += event.delta.signature || '';
    }
  }

  /** Newer Claude models reject `temperature` even with thinking off. */
  private dropUnsupportedSampling(requestParams: Record<string, unknown>): void {
    if (!acceptsSamplingParams(ANTHROPIC_MODELS, this.normalizeModelId(String(requestParams.model)))) {
      delete requestParams.temperature;
    }
  }

  private applyDisabledThinkingConfig(requestParams: Record<string, unknown>, options?: GenerateOptions): void {
    if (this.normalizeModelId(options?.model || this.currentModel) !== 'claude-haiku-5-5') return;
    // Haiku defaults to adaptive thinking if the field is omitted. Explicitly
    // disable it and keep a stale enabled-mode effort below the rejection tier.
    const effort = options?.thinkingEffort || 'medium';
    requestParams.thinking = { type: 'disabled' };
    requestParams.output_config = { effort: effort === 'xhigh' || effort === 'max' ? 'high' : effort };
  }

  protected generateCacheKey(prompt: string, options?: GenerateOptions): string {
    const key = super.generateCacheKey(prompt, options);
    const model = this.normalizeModelId(options?.model || this.currentModel);
    if (model !== 'claude-haiku-5-5') return key;
    const requested = options?.thinkingEffort || 'medium';
    const effort = options?.enableThinking
      ? mapAnthropicAdaptiveEffort(requested, model)
      : requested === 'xhigh' || requested === 'max' ? 'high' : requested;
    return `${key}:thinking=${Boolean(options?.enableThinking)}:effort=${effort}`;
  }

  private applyThinkingConfig(
    requestParams: Record<string, unknown>,
    modelId: string,
    effort: ThinkingEffort,
    maxTokens: number
  ): number {
    // Anthropic rejects sampling temperature whenever thinking is enabled.
    delete requestParams.temperature;

    if (this.supportsAdaptiveThinking(modelId)) {
      requestParams.thinking = { type: 'adaptive', display: 'summarized' };
      requestParams.output_config = { effort: mapAnthropicAdaptiveEffort(effort, modelId) };
      return maxTokens;
    }

    const thinkingParams = ThinkingEffortMapper.getAnthropicParams({ enabled: true, effort }, maxTokens);
    const budgetTokens = thinkingParams?.budget_tokens ?? 16000;
    if ((effort === 'xhigh' || effort === 'max') && budgetTokens < 1024) {
      throw new Error('Anthropic manual thinking at Extra high or Max requires maxTokens of at least 2048.');
    }
    requestParams.thinking = { type: 'enabled', budget_tokens: budgetTokens };

    if (maxTokens <= budgetTokens) {
      const adjustedMaxTokens = budgetTokens + 1024;
      requestParams.max_tokens = adjustedMaxTokens;
      return adjustedMaxTokens;
    }

    return maxTokens;
  }

  private buildAnthropicHeaders(betaHeaders?: string[]): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-api-key': this.apiKey,
      'anthropic-version': '2023-06-01'
    };

    if (betaHeaders && betaHeaders.length > 0) {
      headers['anthropic-beta'] = betaHeaders.join(',');
    }

    return headers;
  }

  private convertTools(tools: AnthropicToolInput[]): AnthropicToolDefinition[] {
    return tools.map(tool => {
      if (tool.type === 'function') {
        // Handle both nested (Chat Completions) and flat (Responses API) formats
        const toolDef = tool.function || tool;
        return {
          name: toolDef.name,
          description: toolDef.description,
          input_schema: toolDef.parameters || toolDef.input_schema
        };
      }
      return tool;
    });
  }

  private extractTextFromContent(content: AnthropicContentBlock[] | undefined): string {
    if (!content) {
      return '';
    }
    return content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('');
  }

  private extractToolCalls(content: AnthropicContentBlock[] | undefined): ToolCall[] {
    if (!content) {
      return [];
    }
    return content
      .filter(block => block.type === 'tool_use')
      .map((block, index) => ({
        id: block.id || `anthropic-tool-${index}`,
        type: 'function',
        function: {
          name: block.name || '',
          arguments: JSON.stringify(block.input || {})
        }
      }));
  }

  private extractThinking(response: AnthropicResponse): string | undefined {
    // Extract thinking process from response if available
    const thinkingBlocks = response.content?.filter((block) => block.type === 'thinking') || [];
    if (thinkingBlocks.length > 0) {
      return thinkingBlocks.map((block) => block.thinking).filter((thinking): thinking is string => typeof thinking === 'string').join('\n');
    }
    return undefined;
  }

  /** Prose of a system message that may already be a block array. */
  private contentToText(content: string | AnthropicContentBlock[]): string {
    if (typeof content === 'string') return content;
    return content.map(block => block.text || '').filter(Boolean).join('\n');
  }

  private mapStopReason(reason: string | null): 'stop' | 'length' | 'tool_calls' | 'content_filter' {
    if (!reason) return 'stop';
    
    const reasonMap: Record<string, 'stop' | 'length' | 'tool_calls' | 'content_filter'> = {
      'end_turn': 'stop',
      'max_tokens': 'length',
      'model_context_window_exceeded': 'length',
      'tool_use': 'tool_calls',
      'stop_sequence': 'stop',
      'refusal': 'content_filter'
    };
    return reasonMap[reason] || 'stop';
  }

  protected extractUsage(response: AnthropicResponse): TokenUsage | undefined {
    if (response.usage) {
      // Grosses up input_tokens with cache reads/writes and carries the cache fields.
      return TokenUsageExtractor.normalize(response.usage);
    }
    return undefined;
  }

  getModelPricing(modelId: string): Promise<ModelPricing | null> {
    return Promise.resolve(getStaticModelPricing(ANTHROPIC_MODELS, this.normalizeModelId(modelId)));
  }
}
