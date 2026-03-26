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
  Tool
} from '../types';
import { MISTRAL_MODELS, MISTRAL_DEFAULT_MODEL } from './MistralModels';

interface MistralUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

interface MistralContentChunk {
  type?: string;
  text?: string;
}

interface MistralMessage {
  content?: string | MistralContentChunk[];
  toolCalls?: unknown[];
  tool_calls?: unknown[];
}

interface MistralChoiceDelta {
  content?: string;
  tool_calls?: unknown[];
}

interface MistralChoice {
  delta?: MistralChoiceDelta;
  message?: MistralMessage;
  finish_reason?: string | null;
  finishReason?: string | null;
}

interface MistralChatCompletionsResponse {
  choices: MistralChoice[];
  usage?: MistralUsage;
}

interface MistralFunctionTool {
  name?: string;
  description?: string;
  parameters?: Record<string, unknown>;
  input_schema?: Record<string, unknown>;
}

interface MistralToolDefinition {
  type?: string;
  function?: MistralFunctionTool;
  name?: string;
  description?: string;
  parameters?: Record<string, unknown>;
  input_schema?: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function getUnknownArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

function getRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function parseUsage(value: unknown): MistralUsage | undefined {
  const record = getRecord(value);
  if (!record) {
    return undefined;
  }

  return {
    prompt_tokens: typeof record.prompt_tokens === 'number' ? record.prompt_tokens : undefined,
    completion_tokens: typeof record.completion_tokens === 'number' ? record.completion_tokens : undefined,
    total_tokens: typeof record.total_tokens === 'number' ? record.total_tokens : undefined
  };
}

function parseContentChunk(value: unknown): MistralContentChunk | undefined {
  const record = getRecord(value);
  if (!record) {
    return undefined;
  }

  return {
    type: getString(record.type),
    text: getString(record.text)
  };
}

function parseMessage(value: unknown): MistralMessage | undefined {
  const record = getRecord(value);
  if (!record) {
    return undefined;
  }

  const contentValue = record.content;
  let content: string | MistralContentChunk[] | undefined;
  if (typeof contentValue === 'string') {
    content = contentValue;
  } else if (Array.isArray(contentValue)) {
    content = contentValue
      .map((chunk) => parseContentChunk(chunk))
      .filter((chunk): chunk is MistralContentChunk => chunk !== undefined);
  }

  return {
    content,
    toolCalls: getUnknownArray(record.toolCalls),
    tool_calls: getUnknownArray(record.tool_calls)
  };
}

function parseChoiceDelta(value: unknown): MistralChoiceDelta | undefined {
  const record = getRecord(value);
  if (!record) {
    return undefined;
  }

  return {
    content: getString(record.content),
    tool_calls: getUnknownArray(record.tool_calls)
  };
}

function parseChoice(value: unknown): MistralChoice | undefined {
  const record = getRecord(value);
  if (!record) {
    return undefined;
  }

  return {
    delta: parseChoiceDelta(record.delta),
    message: parseMessage(record.message),
    finish_reason: typeof record.finish_reason === 'string' || record.finish_reason === null
      ? record.finish_reason
      : undefined,
    finishReason: typeof record.finishReason === 'string' || record.finishReason === null
      ? record.finishReason
      : undefined
  };
}

function parseChatCompletionsResponse(value: unknown): MistralChatCompletionsResponse {
  const record = getRecord(value);
  if (!record) {
    return { choices: [] };
  }

  const choices = getUnknownArray(record.choices)
    ?.map((choice) => parseChoice(choice))
    .filter((choice): choice is MistralChoice => choice !== undefined) ?? [];

  return {
    choices,
    usage: parseUsage(record.usage)
  };
}

function parseFunctionTool(value: unknown): MistralFunctionTool | undefined {
  const record = getRecord(value);
  if (!record) {
    return undefined;
  }

  const parameters = getRecord(record.parameters);
  const inputSchema = getRecord(record.input_schema);

  return {
    name: getString(record.name),
    description: getString(record.description),
    parameters,
    input_schema: inputSchema
  };
}

function parseToolDefinition(value: unknown): MistralToolDefinition | undefined {
  const record = getRecord(value);
  if (!record) {
    return undefined;
  }

  const functionTool = parseFunctionTool(record.function);

  return {
    type: getString(record.type),
    function: functionTool,
    name: getString(record.name),
    description: getString(record.description),
    parameters: getRecord(record.parameters),
    input_schema: getRecord(record.input_schema)
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
          messages: this.buildMessages(prompt, options?.systemPrompt),
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
        extractContent: (chunk) => this.getStreamChoice(chunk)?.delta?.content ?? null,
        extractToolCalls: (chunk) => this.getStreamChoice(chunk)?.delta?.tool_calls ?? null,
        extractFinishReason: (chunk) => this.getStreamChoice(chunk)?.finish_reason ?? null,
        extractUsage: (chunk) => parseChatCompletionsResponse(chunk).usage ?? null,
        accumulateToolCalls: true,
        toolCallThrottling: {
          initialYield: true,
          progressInterval: 50
        }
      });
    } catch (error) {
      console.error('[MistralAdapter] Streaming error:', error);
      if (error instanceof Error) {
        throw error;
      }
      throw new Error(String(error));
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    try {
      return MISTRAL_MODELS.map(model => ({
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
      }));
    } catch (error) {
      this.handleError(error, 'listing models');
      return [];
    }
  }

  getCapabilities(): ProviderCapabilities {
    const baseCapabilities = {
      supportsStreaming: true,
      streamingMode: 'streaming' as const,
      supportsJSON: true,
      supportsImages: false,
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

    // Build request body with snake_case keys matching the Mistral REST API
    const requestBody: Record<string, unknown> = {
      model,
      messages: this.buildMessages(prompt, options?.systemPrompt),
      temperature: options?.temperature,
      max_tokens: options?.maxTokens,
      top_p: options?.topP,
      stop: options?.stopSequences
    };

    // Add tools if provided
    if (options?.tools) {
      requestBody.tools = this.convertTools(options.tools);
    }

    const response = await this.request<MistralChatCompletionsResponse>({
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
    const responseJson = parseChatCompletionsResponse(response.json);
    const choice = responseJson.choices[0];
    
    if (!choice) {
      throw new Error('No response from Mistral');
    }
    
    let text = this.extractMessageContent(choice.message?.content) || '';
    const usage = this.extractUsage(responseJson);
    const finishReason = choice.finish_reason || choice.finishReason || 'stop';

    // If tools were provided and we got tool calls, return placeholder text
    if (options?.tools && (choice.message?.toolCalls || choice.message?.tool_calls)?.length > 0) {
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
  private getStreamChoice(chunk: unknown): MistralChoice | undefined {
    return parseChatCompletionsResponse(chunk).choices[0];
  }

  private convertTools(tools: Tool[]): unknown[] {
    return tools.map(tool => {
      const toolDef = parseToolDefinition(tool);
      if (toolDef?.type === 'function') {
        // Handle both nested (Chat Completions) and flat (Responses API) formats
        const functionTool = toolDef.function ?? toolDef;
        return {
          type: 'function',
          function: {
            name: functionTool.name,
            description: functionTool.description,
            parameters: functionTool.parameters ?? functionTool.input_schema
          }
        };
      }
      return tool;
    });
  }

  private extractToolCalls(message: unknown): unknown[] {
    return parseMessage(message)?.toolCalls ?? [];
  }

  private extractMessageContent(content: unknown): string {
    if (typeof content === 'string') {
      return content;
    }
    if (Array.isArray(content)) {
      return content
        .map((chunk) => parseContentChunk(chunk))
        .filter((chunk): chunk is MistralContentChunk => chunk?.type === 'text')
        .map((chunk) => chunk.text ?? '')
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

  protected extractUsage(response: unknown): TokenUsage | undefined {
    const usage = parseChatCompletionsResponse(response).usage;
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
