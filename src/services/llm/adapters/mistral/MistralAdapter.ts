/**
 * Mistral AI Adapter with true streaming support
 * Implements Mistral's REST API directly over requestUrl.
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
} from '../types';
import { MISTRAL_MODELS, MISTRAL_DEFAULT_MODEL } from './MistralModels';

interface MistralToolDefinition {
  type?: string;
  name?: string;
  description?: string;
  parameters?: Record<string, unknown>;
  input_schema?: Record<string, unknown>;
  function?: {
    name?: string;
    description?: string;
    parameters?: Record<string, unknown>;
    input_schema?: Record<string, unknown>;
  };
}

type MistralToolInput = {
  type?: string;
  name?: string;
  description?: string;
  parameters?: Record<string, unknown>;
  input_schema?: Record<string, unknown>;
  function?: {
    name?: string;
    description?: string;
    parameters?: Record<string, unknown>;
    input_schema?: Record<string, unknown>;
  };
};

interface MistralMessageContentPart {
  type?: string;
  text?: string;
}

interface MistralMessage {
  role?: string;
  content?: string | MistralMessageContentPart[];
  name?: string;
  tool_call_id?: string;
  toolCalls?: Array<Record<string, unknown>>;
  tool_calls?: Array<Record<string, unknown>>;
}

interface MistralChoice {
  message?: MistralMessage;
  finish_reason?: string;
  finishReason?: string;
}

interface MistralChatResponse {
  choices: MistralChoice[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

type MistralStreamChunk = {
  choices?: Array<{
    delta?: {
      content?: string;
      tool_calls?: Array<Record<string, unknown>>;
    };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
};

interface MistralNormalizedToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export class MistralAdapter extends BaseAdapter {
  readonly name = 'mistral';
  readonly baseUrl = 'https://api.mistral.ai';

  constructor(apiKey: string, model?: string) {
    super(apiKey, model || MISTRAL_DEFAULT_MODEL);
    this.initializeCache();
  }

  async generateUncached(prompt: string, options?: GenerateOptions): Promise<LLMResponse> {
    try {
      // Tool execution requires streaming - use generateStreamAsync instead
      if (options?.tools && options.tools.length > 0) {
        throw new Error('Tool execution requires streaming. Use generateStreamAsync() instead.');
      }

      // Use basic chat completions
      return await this.generateWithChatCompletions(prompt, options);
    } catch (error) {
      this.handleError(error, 'generation');
    }
  }

  /**
   * Generate streaming response using async generator
   * Uses unified stream processing with automatic tool call accumulation
   */
  async* generateStreamAsync(prompt: string, options?: GenerateOptions): AsyncGenerator<StreamChunk, void, unknown> {
    try {
      const messages = this.prepareMessages(
        options?.conversationHistory && options.conversationHistory.length > 0
          ? options.conversationHistory
          : this.buildMessages(prompt, options?.systemPrompt)
      );

      const nodeStream = await this.requestStream({
        url: `${this.baseUrl}/v1/chat/completions`,
        operation: 'streaming generation',
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: options?.model || this.currentModel,
          messages,
          temperature: options?.temperature,
          max_tokens: options?.maxTokens,
          top_p: options?.topP,
          stop: options?.stopSequences,
          tools: options?.tools ? this.convertTools(options.tools) : undefined,
          stream: true
        }),
        timeoutMs: 120_000
      });

      yield* this.processNodeStream(nodeStream, {
        debugLabel: 'Mistral',
        extractContent: (chunk) => (chunk as MistralStreamChunk).choices?.[0]?.delta?.content || null,
        extractToolCalls: (chunk) => (chunk as MistralStreamChunk).choices?.[0]?.delta?.tool_calls || null,
        extractFinishReason: (chunk) => (chunk as MistralStreamChunk).choices?.[0]?.finish_reason || null,
        extractUsage: (chunk) => (chunk as MistralStreamChunk).usage,
        accumulateToolCalls: true,
        toolCallThrottling: {
          initialYield: true,
          progressInterval: 50
        }
      });
    } catch (error) {
      console.error('[MistralAdapter] Streaming error:', error);
      throw error;
    }
  }

  listModels(): Promise<ModelInfo[]> {
    try {
      return Promise.resolve(MISTRAL_MODELS.map(model => ({
        id: model.apiName,
        name: model.name,
        contextWindow: model.contextWindow,
        maxOutputTokens: model.maxTokens,
        supportsJSON: model.capabilities.supportsJSON,
        supportsImages: model.capabilities.supportsImages,
        supportsFunctions: model.capabilities.supportsFunctions,
        supportsStreaming: model.capabilities.supportsStreaming,
        supportsThinking: false,
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
      })));
    } catch (error) {
      this.handleError(error, 'listing models');
      return Promise.resolve([]);
    }
  }

  getCapabilities(): ProviderCapabilities {
    const baseCapabilities = {
      supportsStreaming: true,
      streamingMode: 'streaming' as const,
      supportsJSON: true,
      supportsImages: true,
      supportsFunctions: true,
      supportsThinking: false,
      maxContextWindow: 128000,
      supportedFeatures: [
        'messages',
        'function_calling',
        'streaming',
        'json_mode'
      ]
    };

    return baseCapabilities;
  }

  /**
   * Generate using standard chat completions
   */
  private async generateWithChatCompletions(prompt: string, options?: GenerateOptions): Promise<LLMResponse> {
    const model = options?.model || this.currentModel;
    const messages = this.prepareMessages(
      options?.conversationHistory && options.conversationHistory.length > 0
        ? options.conversationHistory
        : this.buildMessages(prompt, options?.systemPrompt)
    );

    // Build request body with snake_case keys matching the Mistral REST API
    const requestBody: Record<string, unknown> = {
      model,
      messages,
      temperature: options?.temperature,
      max_tokens: options?.maxTokens,
      top_p: options?.topP,
      stop: options?.stopSequences
    };

    // Add tools if provided
    if (options?.tools) {
      requestBody.tools = this.convertTools(options.tools);
    }

    const response = await this.request<MistralChatResponse>({
      url: `${this.baseUrl}/v1/chat/completions`,
      operation: 'generation',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody),
      timeoutMs: 60_000
    });
    this.assertOk(response, `Mistral generation failed: HTTP ${response.status}`);
    const responseJson = response.json;
    if (!responseJson) {
      throw new Error('No response from Mistral');
    }
    if (!responseJson.choices || responseJson.choices.length === 0) {
      throw new Error('No response from Mistral');
    }
    const choice = responseJson.choices[0];
    
    if (!choice) {
      throw new Error('No response from Mistral');
    }
    
    let text = this.extractMessageContent(choice.message?.content) || '';
    const usage = this.extractUsage(responseJson);
    const finishReason = choice.finish_reason || choice.finishReason || 'stop';
    const toolCalls = choice.message?.toolCalls || choice.message?.tool_calls || [];

    // If tools were provided and we got tool calls, return placeholder text
    if (options?.tools && toolCalls.length > 0) {
      text = text || '[AI requested tool calls but tool execution not available]';
    }

    return this.buildLLMResponse(
      text,
      model,
      usage,
      undefined,
      finishReason as 'stop' | 'length' | 'tool_calls' | 'content_filter'
    );
  }

  // Private methods
  private convertTools(tools: MistralToolInput[]): MistralToolDefinition[] {
    return tools.map(tool => {
      if (tool.type === 'function') {
        // Handle both nested (Chat Completions) and flat (Responses API) formats
        const toolDef = tool.function || tool;
        return {
          type: 'function',
          function: {
            name: toolDef.name,
            description: toolDef.description,
            parameters: toolDef.parameters || toolDef.input_schema
          }
        };
      }
      return tool;
    });
  }

  private prepareMessages(messages: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
    return this.normalizeMessagesForMistral(messages);
  }

  private normalizeMessagesForMistral(messages: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
    const normalizedMessages: Array<Record<string, unknown>> = [];
    const normalizedToolCallIds = new Map<string, string>();
    const toolNamesById = new Map<string, string>();

    for (const message of messages) {
      const role = typeof message.role === 'string' ? message.role : undefined;
      if (!role) {
        continue;
      }

      if (role === 'assistant') {
        const toolCalls = this.normalizeAssistantToolCalls(message, normalizedToolCallIds, toolNamesById);
        normalizedMessages.push({
          role,
          content: this.stringifyMessageContent(message.content),
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {})
        });
        continue;
      }

      if (role === 'tool') {
        const rawToolCallId = typeof message.tool_call_id === 'string' ? message.tool_call_id : '';
        const normalizedToolCallId = this.normalizeToolCallId(
          rawToolCallId,
          normalizedToolCallIds,
          `tool-${normalizedMessages.length}`
        );
        const inferredToolName = this.toOptionalString(message.name) || toolNamesById.get(normalizedToolCallId) || '';

        normalizedMessages.push({
          role,
          tool_call_id: normalizedToolCallId,
          content: this.stringifyMessageContent(message.content),
          ...(inferredToolName ? { name: inferredToolName } : {})
        });
        continue;
      }

      normalizedMessages.push({
        role,
        content: this.stringifyMessageContent(message.content)
      });
    }

    return normalizedMessages;
  }

  private normalizeAssistantToolCalls(
    message: Record<string, unknown>,
    normalizedToolCallIds: Map<string, string>,
    toolNamesById: Map<string, string>
  ): MistralNormalizedToolCall[] {
    const rawToolCalls = this.getRawToolCalls(message);
    const normalizedToolCalls: MistralNormalizedToolCall[] = [];

    for (const [index, rawToolCall] of rawToolCalls.entries()) {
      if (!rawToolCall || typeof rawToolCall !== 'object') {
        continue;
      }

      const functionPayload = this.getFunctionPayload(rawToolCall);
      const toolName = this.toOptionalString(functionPayload?.name);
      if (!toolName) {
        continue;
      }

      const normalizedId = this.normalizeToolCallId(
        this.toOptionalString((rawToolCall as { id?: unknown }).id),
        normalizedToolCallIds,
        `${toolName}-${index}`
      );
      toolNamesById.set(normalizedId, toolName);

      normalizedToolCalls.push({
        id: normalizedId,
        type: 'function',
        function: {
          name: toolName,
          arguments: this.normalizeArguments(functionPayload?.arguments)
        }
      });
    }

    return normalizedToolCalls;
  }

  private getRawToolCalls(message: Record<string, unknown>): Array<Record<string, unknown>> {
    const toolCalls = message.tool_calls;
    if (Array.isArray(toolCalls)) {
      return toolCalls.filter((toolCall): toolCall is Record<string, unknown> => !!toolCall && typeof toolCall === 'object');
    }

    const camelToolCalls = message.toolCalls;
    if (Array.isArray(camelToolCalls)) {
      return camelToolCalls.filter((toolCall): toolCall is Record<string, unknown> => !!toolCall && typeof toolCall === 'object');
    }

    return [];
  }

  private getFunctionPayload(toolCall: Record<string, unknown>): { name?: string; arguments?: unknown } | undefined {
    const rawFunction = toolCall.function;
    if (rawFunction && typeof rawFunction === 'object' && !Array.isArray(rawFunction)) {
      return rawFunction as { name?: string; arguments?: unknown };
    }

    const toolName = this.toOptionalString(toolCall.name);
    if (!toolName) {
      return undefined;
    }

    return {
      name: toolName,
      arguments: toolCall.arguments
    };
  }

  private normalizeArguments(argumentsValue: unknown): string {
    if (typeof argumentsValue === 'string') {
      return argumentsValue;
    }
    if (argumentsValue === undefined) {
      return '{}';
    }

    try {
      return JSON.stringify(argumentsValue);
    } catch {
      return '{}';
    }
  }

  private normalizeToolCallId(
    rawId: string | undefined,
    normalizedToolCallIds: Map<string, string>,
    fallbackSeed: string
  ): string {
    const originalId = rawId || '';
    if (originalId && normalizedToolCallIds.has(originalId)) {
      return normalizedToolCallIds.get(originalId) || '';
    }

    const candidate = originalId.replace(/[^A-Za-z0-9]/g, '');
    if (candidate.length === 9) {
      normalizedToolCallIds.set(originalId, candidate);
      return candidate;
    }

    const normalizedId = this.generateMistralToolCallId(originalId || fallbackSeed);
    if (originalId) {
      normalizedToolCallIds.set(originalId, normalizedId);
    }
    return normalizedId;
  }

  private generateMistralToolCallId(seed: string): string {
    const source = seed || 'mistraltoolcall';
    let hash = 0;
    for (let index = 0; index < source.length; index++) {
      hash = ((hash << 5) - hash) + source.charCodeAt(index);
      hash |= 0;
    }

    const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let value = Math.abs(hash);
    let output = '';

    for (let index = 0; index < 9; index++) {
      const charIndex = value % alphabet.length;
      output += alphabet.charAt(charIndex);
      value = Math.floor(value / alphabet.length);
    }

    return output;
  }

  private stringifyMessageContent(content: unknown): string {
    if (typeof content === 'string') {
      return content;
    }

    if (Array.isArray(content)) {
      return content
        .filter((chunk): chunk is MistralMessageContentPart => !!chunk && typeof chunk === 'object')
        .filter(chunk => chunk.type === 'text')
        .map(chunk => chunk.text || '')
        .join('');
    }

    if (content === undefined || content === null) {
      return '';
    }

    try {
      return JSON.stringify(content);
    } catch {
      if (typeof content === 'number' || typeof content === 'boolean' || typeof content === 'bigint') {
        return `${content}`;
      }
      return '';
    }
  }

  private toOptionalString(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  }

  private extractToolCalls(message: MistralMessage | undefined): Array<Record<string, unknown>> {
    return message?.toolCalls || [];
  }

  private extractMessageContent(content: MistralMessage['content']): string {
    if (typeof content === 'string') {
      return content;
    }
    if (Array.isArray(content)) {
      return content
        .filter(chunk => chunk.type === 'text')
        .map(chunk => chunk.text || '')
        .join('');
    }
    return '';
  }

  private mapFinishReason(reason: string | null): 'stop' | 'length' | 'tool_calls' | 'content_filter' {
    if (!reason) return 'stop';
    
    const reasonMap: Record<string, 'stop' | 'length' | 'tool_calls' | 'content_filter'> = {
      'stop': 'stop',
      'length': 'length',
      'tool_calls': 'tool_calls',
      'model_length': 'length',
      'content_filter': 'content_filter'
    };
    return reasonMap[reason] || 'stop';
  }

  protected extractUsage(response: MistralChatResponse): TokenUsage | undefined {
    const usage = response.usage;
    if (usage) {
      return {
        promptTokens: usage.prompt_tokens || 0,
        completionTokens: usage.completion_tokens || 0,
        totalTokens: usage.total_tokens || 0
      };
    }
    return undefined;
  }

  private getCostPer1kTokens(modelId: string): { input: number; output: number } | undefined {
    const model = MISTRAL_MODELS.find(m => m.apiName === modelId);
    if (!model) return undefined;
    
    return {
      input: model.inputCostPerMillion / 1000,
      output: model.outputCostPerMillion / 1000
    };
  }

  getModelPricing(modelId: string): Promise<ModelPricing | null> {
    const costs = this.getCostPer1kTokens(modelId);
    if (!costs) return Promise.resolve(null);

    return Promise.resolve({
      rateInputPerMillion: costs.input * 1000,
      rateOutputPerMillion: costs.output * 1000,
      currency: 'USD'
    });
  }
}
