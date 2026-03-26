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
  TokenUsage,
  Tool
} from '../types';
import { ANTHROPIC_MODELS, ANTHROPIC_DEFAULT_MODEL } from './AnthropicModels';
import { ThinkingEffortMapper } from '../../utils/ThinkingEffortMapper';

interface AnthropicUsageLike {
  input_tokens?: number;
  output_tokens?: number;
  [key: string]: unknown;
}

interface AnthropicContentBlock {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  thinking?: string;
  [key: string]: unknown;
}

interface AnthropicConversationMessage {
  role: 'user' | 'assistant' | 'system';
  content: string | AnthropicContentBlock[];
  [key: string]: unknown;
}

interface AnthropicRequestMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[];
  [key: string]: unknown;
}

interface AnthropicRequestParams {
  model: string;
  max_tokens: number;
  messages: AnthropicRequestMessage[];
  temperature?: number;
  stream: true;
  stop_sequences?: string[];
  system?: string;
  thinking?: {
    type: 'enabled';
    budget_tokens: number;
  };
  tools?: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

interface AnthropicStreamEvent {
  type: string;
  index?: number;
  message?: {
    usage?: AnthropicUsageLike;
    [key: string]: unknown;
  };
  usage?: AnthropicUsageLike;
  content_block?: {
    type?: string;
    id?: string;
    name?: string;
    input?: unknown;
    [key: string]: unknown;
  };
  delta?: {
    type?: string;
    text?: string;
    partial_json?: string;
    thinking?: string;
    [key: string]: unknown;
  };
  error?: {
    message?: string;
    [key: string]: unknown;
  };
  content?: AnthropicContentBlock[];
  stop_reason?: string | null;
  stop_sequence?: string;
  model?: string;
  [key: string]: unknown;
}

interface AnthropicResponseJson {
  content?: AnthropicContentBlock[];
  usage?: AnthropicUsageLike;
  stop_reason?: string | null;
  stop_sequence?: string;
  model?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAnthropicStreamEvent(value: unknown): value is AnthropicStreamEvent {
  return isRecord(value) && typeof value.type === 'string';
}

function isAnthropicContentBlock(value: unknown): value is AnthropicContentBlock {
  return isRecord(value) && typeof value.type === 'string';
}

function isAnthropicConversationMessage(value: unknown): value is AnthropicConversationMessage {
  return isRecord(value)
    && (value.role === 'user' || value.role === 'assistant' || value.role === 'system')
    && ('content' in value);
}

function isAnthropicUsageLike(value: unknown): value is AnthropicUsageLike {
  return isRecord(value);
}

function getAnthropicSystemPrompt(message: AnthropicConversationMessage | undefined): string | undefined {
  return typeof message?.content === 'string' ? message.content : undefined;
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
      let messages: AnthropicConversationMessage[];
      if (
        Array.isArray(options?.conversationHistory) &&
        options.conversationHistory.length > 0 &&
        options.conversationHistory.every(isAnthropicConversationMessage)
      ) {
        // Use provided conversation history for tool continuations
        messages = options.conversationHistory;
      } else {
        // Build simple messages for initial request
        messages = this.buildMessages(prompt, options?.systemPrompt).filter(isAnthropicConversationMessage);
      }

      const requestParams: AnthropicRequestParams = {
        model: this.normalizeModelId(options?.model || this.currentModel),
        max_tokens: options?.maxTokens || 4096,
        messages: messages.filter((msg): msg is AnthropicRequestMessage => msg.role !== 'system'),
        temperature: options?.temperature,
        stream: true
      };

      // Add system message if provided (either from messages or from options)
      const systemMessage = messages.find(msg => msg.role === 'system');
      const systemPrompt = getAnthropicSystemPrompt(systemMessage);
      if (systemPrompt) {
        requestParams.system = systemPrompt;
      } else if (options?.systemPrompt) {
        requestParams.system = options.systemPrompt;
      }

      // Extended thinking mode for Claude 4 models
      if (options?.enableThinking && this.supportsThinking(options?.model || this.currentModel)) {
        const effort = options?.thinkingEffort || 'medium';
        const thinkingParams = ThinkingEffortMapper.getAnthropicParams({ enabled: true, effort });
        const budgetTokens = thinkingParams?.budget_tokens || 16000;
        requestParams.thinking = {
          type: 'enabled',
          budget_tokens: budgetTokens
        };
        // Ensure max_tokens > budget_tokens (Anthropic API requirement)
        if (requestParams.max_tokens <= budgetTokens) {
          requestParams.max_tokens = budgetTokens + 1024;
        }
      }

      // Add tools if provided
      if (options?.tools && options.tools.length > 0) {
        requestParams.tools = this.convertTools(options.tools);
      }

      // Add web search tool if requested
      if (options?.webSearch) {
        requestParams.tools = requestParams.tools || [];
        requestParams.tools.push({
          type: 'web_search_20250305',
          name: 'web_search',
          max_uses: 5
        });
      }

      // Look up model spec for beta headers (sent via HTTP header, not body field)
      const modelSpec = ANTHROPIC_MODELS.find(m => m.apiName === this.normalizeModelId(options?.model || this.currentModel));

      let usage: AnthropicUsageLike | undefined = undefined;
      let thinkingBlockIndex: number | null = null;  // Track thinking block for completion
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
        extractContent: (event) => {
          if (!isAnthropicStreamEvent(event)) {
            return null;
          }
          if (event.type === 'message_start' && event.message?.usage) {
            usage = event.message.usage;
          } else if (event.type === 'message_delta' && event.usage) {
            usage = event.usage;
          } else if (event.type === 'content_block_start' && event.content_block?.type === 'thinking') {
            thinkingBlockIndex = event.index;
          }

          if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
            return event.delta.text || null;
          }
          return null;
        },
        extractToolCalls: (event) => {
          if (!isAnthropicStreamEvent(event)) {
            return null;
          }
          if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
            return [{
              index: event.index,
              id: event.content_block.id,
              type: 'function',
              function: {
                name: event.content_block.name,
                arguments: ''
              }
            }];
          }

          if (event.type === 'content_block_delta' && event.delta?.type === 'input_json_delta') {
            return [{
              index: event.index,
              function: {
                arguments: event.delta.partial_json || ''
              }
            }];
          }

          return null;
        },
        extractFinishReason: (event) => {
          if (!isAnthropicStreamEvent(event)) {
            return null;
          }
          if (event.type === 'message_stop') {
            return 'stop';
          }
          if (event.type === 'error' && event.error?.message) {
            throw new Error(`Anthropic stream error: ${event.error.message}`);
          }
          return null;
        },
        extractUsage: () => usage,
        extractReasoning: (event) => {
          if (!isAnthropicStreamEvent(event)) {
            return null;
          }
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

  async listModels(): Promise<ModelInfo[]> {
    try {
      return ANTHROPIC_MODELS.map(model => ({
        // For 1M context models, append :1m to make ID unique
        id: model.contextWindow >= 1000000 ? `${model.apiName}:1m` : model.apiName,
        name: model.name,
        contextWindow: model.contextWindow,
        maxOutputTokens: model.maxTokens,
        supportsJSON: model.capabilities.supportsJSON,
        supportsImages: model.capabilities.supportsImages,
        supportsFunctions: model.capabilities.supportsFunctions,
        supportsStreaming: model.capabilities.supportsStreaming,
        supportsThinking: model.capabilities.supportsThinking,
        costPer1kTokens: {
          input: model.inputCostPerMillion / 1000,
          output: model.outputCostPerMillion / 1000
        },
        pricing: {
          inputPerMillion: model.inputCostPerMillion,
          outputPerMillion: model.outputCostPerMillion,
          currency: 'USD',
          lastUpdated: new Date().toISOString()
        }
      }));
    } catch (error) {
      this.handleError(error, 'listing models');
      return [];
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
    const messages = this.buildMessages(prompt, options?.systemPrompt).filter(isAnthropicConversationMessage);
    
    const requestParams: AnthropicRequestParams = {
      model: options?.model || this.currentModel,
      max_tokens: options?.maxTokens || 4096,
      messages: messages.filter((msg): msg is AnthropicRequestMessage => msg.role !== 'system'),
      temperature: options?.temperature,
      stop_sequences: options?.stopSequences
    };

    // Add system message if provided
    const systemMessage = messages.find(msg => msg.role === 'system');
    const systemPrompt = getAnthropicSystemPrompt(systemMessage);
    if (systemPrompt) {
      requestParams.system = systemPrompt;
    }

    // Extended thinking mode for Claude 4 models
    if (options?.enableThinking && this.supportsThinking(options?.model || this.currentModel)) {
      const effort = options?.thinkingEffort || 'medium';
      const thinkingParams = ThinkingEffortMapper.getAnthropicParams({ enabled: true, effort });
      const budgetTokens = thinkingParams?.budget_tokens || 16000;
      requestParams.thinking = {
        type: 'enabled',
        budget_tokens: budgetTokens
      };
      // Ensure max_tokens > budget_tokens (Anthropic API requirement)
      if (requestParams.max_tokens <= budgetTokens) {
        requestParams.max_tokens = budgetTokens + 1024;
      }
    }

    // Add tools if provided
    if (options?.tools && options.tools.length > 0) {
      requestParams.tools = this.convertTools(options.tools);
    }

    // Special tools
    if (options?.webSearch) {
      requestParams.tools = requestParams.tools || [];
      requestParams.tools.push({
        type: 'web_search_20250305',
        name: 'web_search',
        max_uses: 5
      });
    }

    // Look up model spec for beta headers (sent via HTTP header, not body field)
    const modelSpec = ANTHROPIC_MODELS.find(m => m.apiName === this.normalizeModelId(options?.model || this.currentModel));

    const response = await this.request<AnthropicResponseJson>({
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
      throw new Error('Anthropic response missing JSON body');
    }
    
    const extractedUsage = this.extractUsage(responseJson);
    const finishReason = this.mapStopReason(responseJson.stop_reason);
    const toolCalls = this.extractToolCalls(responseJson.content);
    const metadata = {
      thinking: this.extractThinking(responseJson),
      stopSequence: responseJson.stop_sequence
    };

    return await this.buildLLMResponse(
      this.extractTextFromContent(responseJson.content),
      responseJson.model,
      extractedUsage,
      metadata,
      finishReason,
      toolCalls
    );
  }

  // Private methods

  /**
   * Normalize model ID by removing :1m suffix to match against apiName
   * The :1m suffix is used to distinguish the 1M context variant in the UI,
   * but both variants use the same API name with different beta headers
   */
  private normalizeModelId(modelId: string): string {
    return modelId.replace(':1m', '');
  }

  private supportsThinking(modelId: string): boolean {
    const model = ANTHROPIC_MODELS.find(m => m.apiName === this.normalizeModelId(modelId));
    return model?.capabilities.supportsThinking || false;
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

  private convertTools(tools: readonly Tool[]): Array<Record<string, unknown>> {
    return tools.map(tool => {
      if (tool.type === 'function' && tool.function) {
        // Handle both nested (Chat Completions) and flat (Responses API) formats
        const toolDef = tool.function;
        return {
          name: toolDef.name,
          description: toolDef.description,
          input_schema: toolDef.parameters || toolDef.input_schema
        };
      }
      return { ...tool };
    });
  }

  private extractTextFromContent(content: AnthropicContentBlock[] | undefined): string {
    return (content ?? [])
      .filter((block): block is AnthropicContentBlock & { type: 'text'; text: string } => {
        return isAnthropicContentBlock(block) && block.type === 'text' && typeof block.text === 'string';
      })
      .map(block => block.text)
      .join('');
  }

  private extractToolCalls(content: AnthropicContentBlock[] | undefined): LLMResponse['toolCalls'] {
    return (content ?? [])
      .filter((block): block is AnthropicContentBlock & { type: 'tool_use'; id: string; name: string; input?: unknown } => {
        return isAnthropicContentBlock(block)
          && block.type === 'tool_use'
          && typeof block.id === 'string'
          && typeof block.name === 'string';
      })
      .map(block => ({
        id: block.id,
        type: 'function',
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input)
        }
      }));
  }

  private extractThinking(response: AnthropicResponseJson): string | undefined {
    // Extract thinking process from response if available
    const thinkingBlocks = (response.content ?? []).filter((block): block is AnthropicContentBlock & { type: 'thinking'; thinking?: string } => {
      return isAnthropicContentBlock(block) && block.type === 'thinking';
    });
    if (thinkingBlocks.length > 0) {
      return thinkingBlocks.map(block => block.thinking || '').join('\n');
    }
    return undefined;
  }

  private mapStopReason(reason: string | null): 'stop' | 'length' | 'tool_calls' | 'content_filter' {
    if (!reason) return 'stop';
    
    const reasonMap: Record<string, 'stop' | 'length' | 'tool_calls' | 'content_filter'> = {
      'end_turn': 'stop',
      'max_tokens': 'length',
      'tool_use': 'tool_calls',
      'stop_sequence': 'stop'
    };
    return reasonMap[reason] || 'stop';
  }

  protected extractUsage(response: AnthropicResponseJson): TokenUsage | undefined {
    if (isAnthropicUsageLike(response.usage)) {
      return {
        promptTokens: response.usage.input_tokens || 0,
        completionTokens: response.usage.output_tokens || 0,
        totalTokens: (response.usage.input_tokens || 0) + (response.usage.output_tokens || 0)
      };
    }
    return undefined;
  }

  private getCostPer1kTokens(modelId: string): { input: number; output: number } | undefined {
    const model = ANTHROPIC_MODELS.find(m => m.apiName === this.normalizeModelId(modelId));
    if (!model) return undefined;

    return {
      input: model.inputCostPerMillion / 1000,
      output: model.outputCostPerMillion / 1000
    };
  }

  async getModelPricing(modelId: string): Promise<ModelPricing | null> {
    const costs = this.getCostPer1kTokens(modelId);
    if (!costs) return null;
    
    return {
      rateInputPerMillion: costs.input * 1000,
      rateOutputPerMillion: costs.output * 1000,
      currency: 'USD'
    };
  }
}
