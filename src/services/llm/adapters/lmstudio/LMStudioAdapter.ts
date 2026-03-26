/**
 * LM Studio Adapter
 * Provides local LLM models via LM Studio's OpenAI-compatible API
 * Supports model auto-discovery, streaming, and function calling
 *
 * Uses the standard /v1/chat/completions API for reliable conversation handling.
 * Supports multiple tool calling formats (native tool_calls, [TOOL_CALLS], XML, etc.)
 * via ToolCallContentParser.
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
  LLMProviderError
} from '../types';
import { ToolCallContentParser } from './ToolCallContentParser';
import { usesCustomToolFormat } from '../../../chat/builders/ContextBuilderFactory';

/** OpenAI-compatible chat completion response shape from LM Studio */
interface ChatCompletionResponse {
  id?: string;
  model?: string;
  choices?: Array<{
    message?: {
      content?: string;
      tool_calls?: unknown[];
    };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

/** OpenAI-compatible model list response shape from LM Studio */
interface ModelListResponse {
  data?: Array<{
    id: string;
    context_length?: number;
    max_tokens?: number;
  }>;
}

interface LMStudioRequestBody {
  model: string;
  messages: readonly unknown[];
  stream: boolean;
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  stop?: string[];
  tools?: Array<Record<string, unknown>>;
  response_format?: {
    type: 'json_object';
  };
}

interface LMStudioToolFunction {
  name?: string;
  description?: string;
  parameters?: Record<string, unknown>;
  arguments?: string;
}

interface LMStudioToolCallInput {
  id?: string;
  function?: LMStudioToolFunction;
}

interface LMStudioToolInput extends Record<string, unknown> {
  type?: string;
  name?: string;
  description?: string;
  parameters?: Record<string, unknown>;
  function?: LMStudioToolFunction;
}

interface LMStudioChatMessage {
  role?: string;
  content?: string;
  tool_calls?: unknown[];
  tool_call_id?: string;
}

interface LMStudioResponsesToolDefinition {
  type: 'function';
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
}

type LMStudioResponsesInputItem =
  | { role: 'system' | 'user' | 'assistant'; content: string }
  | { type: 'function_call'; call_id: string; name: string; arguments: string }
  | { type: 'function_call_output'; call_id: string; output: string };

interface LMStudioStreamDelta {
  content?: string;
  tool_calls?: unknown[];
}

interface LMStudioStreamChoice {
  delta?: LMStudioStreamDelta;
  finish_reason?: string;
}

interface LMStudioErrorLike {
  message?: string;
  code?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isToolFunction(value: unknown): value is LMStudioToolFunction {
  return isRecord(value);
}

function isChatMessage(value: unknown): value is LMStudioChatMessage {
  return isRecord(value) && (!('role' in value) || isString(value.role));
}

function toToolInput(value: unknown): LMStudioToolInput | null {
  if (!isRecord(value)) {
    return null;
  }

  return {
    ...value,
    type: isString(value.type) ? value.type : undefined,
    name: isString(value.name) ? value.name : undefined,
    description: isString(value.description) ? value.description : undefined,
    parameters: isRecord(value.parameters) ? value.parameters : undefined,
    function: isToolFunction(value.function)
      ? {
          name: isString(value.function.name) ? value.function.name : undefined,
          description: isString(value.function.description) ? value.function.description : undefined,
          parameters: isRecord(value.function.parameters) ? value.function.parameters : undefined,
          arguments: isString(value.function.arguments) ? value.function.arguments : undefined
        }
      : undefined
  };
}

function toToolCallInput(value: unknown): LMStudioToolCallInput {
  if (!isRecord(value)) {
    return {};
  }

  return {
    id: isString(value.id) ? value.id : undefined,
    function: isToolFunction(value.function)
      ? {
          name: isString(value.function.name) ? value.function.name : undefined,
          arguments: isString(value.function.arguments) ? value.function.arguments : undefined
        }
      : undefined
  };
}

function getStreamChoice(parsed: unknown): LMStudioStreamChoice | undefined {
  if (!isRecord(parsed) || !Array.isArray(parsed.choices) || parsed.choices.length === 0) {
    return undefined;
  }

  const choices = parsed.choices as unknown[];
  const firstChoice = choices[0];
  if (!isRecord(firstChoice)) {
    return undefined;
  }

  const delta = isRecord(firstChoice.delta)
    ? {
        content: isString(firstChoice.delta.content) ? firstChoice.delta.content : undefined,
        tool_calls: Array.isArray(firstChoice.delta.tool_calls) ? firstChoice.delta.tool_calls : undefined
      }
    : undefined;

  return {
    delta,
    finish_reason: isString(firstChoice.finish_reason) ? firstChoice.finish_reason : undefined
  };
}

function getUsage(parsed: unknown): ChatCompletionResponse['usage'] | undefined {
  if (!isRecord(parsed) || !isRecord(parsed.usage)) {
    return undefined;
  }

  return {
    prompt_tokens: typeof parsed.usage.prompt_tokens === 'number' ? parsed.usage.prompt_tokens : undefined,
    completion_tokens: typeof parsed.usage.completion_tokens === 'number' ? parsed.usage.completion_tokens : undefined,
    total_tokens: typeof parsed.usage.total_tokens === 'number' ? parsed.usage.total_tokens : undefined
  };
}

function getErrorDetails(error: unknown): LMStudioErrorLike {
  if (!isRecord(error)) {
    return {};
  }

  return {
    message: isString(error.message) ? error.message : undefined,
    code: isString(error.code) ? error.code : undefined
  };
}

export class LMStudioAdapter extends BaseAdapter {
  readonly name = 'lmstudio';
  readonly baseUrl: string;

  private serverUrl: string;

  constructor(serverUrl: string) {
    // LM Studio doesn't need an API key - set requiresApiKey to false
    super('', '', serverUrl, false);

    this.serverUrl = serverUrl;
    this.baseUrl = serverUrl;

    this.initializeCache();
  }

  /**
   * Generate response without caching using /v1/chat/completions
   * Uses Obsidian's requestUrl to bypass CORS
   */
  async generateUncached(prompt: string, options?: GenerateOptions): Promise<LLMResponse> {
    const model = options?.model || this.currentModel;

    let messages: readonly unknown[];
    if (Array.isArray(options?.conversationHistory) && options.conversationHistory.length > 0) {
      messages = options.conversationHistory as unknown[];
    } else {
      messages = this.buildMessages(prompt, options?.systemPrompt);
    }

    const requestBody: LMStudioRequestBody = {
      model: model,
      messages: messages,
      stream: false
    };

    if (options?.temperature !== undefined) {
      requestBody.temperature = options.temperature;
    }

    if (options?.maxTokens !== undefined) {
      requestBody.max_tokens = options.maxTokens;
    }

    if (options?.topP !== undefined) {
      requestBody.top_p = options.topP;
    }

    if (options?.frequencyPenalty !== undefined) {
      requestBody.frequency_penalty = options.frequencyPenalty;
    }

    if (options?.presencePenalty !== undefined) {
      requestBody.presence_penalty = options.presencePenalty;
    }

    if (options?.stopSequences !== undefined) {
      requestBody.stop = options.stopSequences;
    }

    const skipToolSchemas = LMStudioAdapter.usesToolCallsContentFormat(model);
    if (options?.tools && options.tools.length > 0 && !skipToolSchemas) {
      requestBody.tools = this.convertTools(options.tools);
    }

    if (options?.jsonMode) {
      requestBody.response_format = { type: 'json_object' };
    }

    const response = await this.request({
      url: `${this.serverUrl}/v1/chat/completions`,
      operation: 'generation',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
      timeoutMs: 60_000
    });

    this.assertOk(response, `LM Studio API error: ${response.status} - ${response.text || 'Unknown error'}`);

    const data = response.json as ChatCompletionResponse | null;

    if (!data?.choices || !data.choices[0]) {
      throw new LLMProviderError(
        'Invalid response format from LM Studio API: missing choices',
        'generation',
        'INVALID_RESPONSE'
      );
    }

    const choice = data.choices[0];
    let content = choice.message?.content || '';
    let toolCalls = choice.message?.tool_calls || [];

    if (ToolCallContentParser.hasToolCallsFormat(content)) {
      const parsed = ToolCallContentParser.parse(content);
      if (parsed.hasToolCalls) {
        if (toolCalls.length === 0) {
          toolCalls = parsed.toolCalls;
        }
        content = parsed.cleanContent;
      }
    }

    const usage: TokenUsage = {
      promptTokens: data.usage?.prompt_tokens || 0,
      completionTokens: data.usage?.completion_tokens || 0,
      totalTokens: data.usage?.total_tokens || 0
    };

    return await this.buildLLMResponse(
      content,
      model,
      usage,
      { cached: false, model: data.model, id: data.id },
      toolCalls.length > 0 ? 'tool_calls' : this.mapFinishReason(choice.finish_reason),
      toolCalls
    );
  }

  /**
   * Generate streaming response using /v1/chat/completions
   * Supports multiple tool calling formats via ToolCallContentParser
   */
  async* generateStreamAsync(prompt: string, options?: GenerateOptions): AsyncGenerator<StreamChunk, void, unknown> {
    const model = options?.model || this.currentModel;

    // Check for pre-built conversation history (tool continuations)
    let messages: readonly unknown[];
    if (Array.isArray(options?.conversationHistory) && options.conversationHistory.length > 0) {
      messages = options.conversationHistory as unknown[];
    } else {
      messages = this.buildMessages(prompt, options?.systemPrompt);
    }

    const requestBody: LMStudioRequestBody = {
      model: model,
      messages: messages,
      stream: true
    };

    if (options?.temperature !== undefined) {
      requestBody.temperature = options.temperature;
    }

    if (options?.maxTokens !== undefined) {
      requestBody.max_tokens = options.maxTokens;
    }

    if (options?.topP !== undefined) {
      requestBody.top_p = options.topP;
    }

    if (options?.frequencyPenalty !== undefined) {
      requestBody.frequency_penalty = options.frequencyPenalty;
    }

    if (options?.presencePenalty !== undefined) {
      requestBody.presence_penalty = options.presencePenalty;
    }

    if (options?.stopSequences !== undefined) {
      requestBody.stop = options.stopSequences;
    }

    // Add tools if provided
    const skipToolSchemas = LMStudioAdapter.usesToolCallsContentFormat(model);
    if (options?.tools && options.tools.length > 0 && !skipToolSchemas) {
      requestBody.tools = this.convertTools(options.tools);
    }

    // requestStream() throws on HTTP errors; no assertOk needed
    const nodeStream = await this.requestStream({
      url: `${this.serverUrl}/v1/chat/completions`,
      operation: 'streaming generation',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
      timeoutMs: 120_000
    });

    let accumulatedContent = '';
    let hasToolCallsFormat = false;

    for await (const chunk of this.processNodeStream(nodeStream, {
      debugLabel: 'LM Studio',
      extractContent: (parsed) => getStreamChoice(parsed)?.delta?.content || null,
      extractToolCalls: (parsed) => getStreamChoice(parsed)?.delta?.tool_calls || null,
      extractFinishReason: (parsed) => getStreamChoice(parsed)?.finish_reason || null,
      extractUsage: (parsed) => getUsage(parsed),
      accumulateToolCalls: true,
      toolCallThrottling: {
        initialYield: true,
        progressInterval: 50
      }
    })) {
      if (chunk.content) {
        accumulatedContent += chunk.content;
      }

      if (!hasToolCallsFormat && ToolCallContentParser.hasToolCallsFormat(accumulatedContent)) {
        hasToolCallsFormat = true;
      }

      if (hasToolCallsFormat) {
        if (chunk.complete) {
          const parsed = ToolCallContentParser.parse(accumulatedContent);
          yield {
            content: parsed.cleanContent,
            complete: true,
            toolCalls: parsed.hasToolCalls ? parsed.toolCalls : undefined,
            toolCallsReady: parsed.hasToolCalls,
            usage: chunk.usage
          };
        }
      } else {
        yield chunk;
      }
    }
  }

  /**
   * Convert tools to Responses API format
   */
  private convertToolsForResponsesApi(tools: readonly unknown[]): Array<LMStudioResponsesToolDefinition | Record<string, unknown>> {
    return tools.map((tool) => {
      const toolInput = toToolInput(tool);

      if (toolInput?.function) {
        return {
          type: 'function',
          name: toolInput.function.name || '',
          description: toolInput.function.description,
          parameters: toolInput.function.parameters
        };
      }

      return toolInput || {};
    });
  }

  /**
   * Convert Chat Completions format messages to Responses API input
   *
   * Chat Completions format:
   * - { role: 'user', content: '...' }
   * - { role: 'assistant', content: '...', tool_calls: [...] }
   * - { role: 'tool', tool_call_id: '...', content: '...' }
   *
   * Responses API input:
   * - { role: 'user', content: '...' }
   * - { role: 'assistant', content: '...' } OR function_call items
   * - { type: 'function_call_output', call_id: '...', output: '...' }
   */
  private convertChatCompletionsToResponsesInput(messages: readonly unknown[], systemPrompt?: string): LMStudioResponsesInputItem[] {
    const input: LMStudioResponsesInputItem[] = [];

    // Add system prompt first if provided
    if (systemPrompt) {
      input.push({ role: 'system', content: systemPrompt });
    }

    for (const rawMessage of messages) {
      if (!isChatMessage(rawMessage)) {
        continue;
      }

      const msg = rawMessage;
      const content = msg.content || '';

      if (msg.role === 'user') {
        input.push({ role: 'user', content });
      } else if (msg.role === 'assistant') {
        const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];

        if (toolCalls.length > 0) {
          // Add text content if present
          if (content.trim()) {
            input.push({ role: 'assistant', content });
          }

          // Convert tool_calls to function_call items
          for (const rawToolCall of toolCalls) {
            const toolCall = toToolCallInput(rawToolCall);
            input.push({
              type: 'function_call',
              call_id: toolCall.id || '',
              name: toolCall.function?.name || '',
              arguments: toolCall.function?.arguments || '{}'
            });
          }
        } else {
          // Plain assistant message
          input.push({ role: 'assistant', content });
        }
      } else if (msg.role === 'tool') {
        // Convert tool result to function_call_output
        input.push({
          type: 'function_call_output',
          call_id: msg.tool_call_id || '',
          output: content || '{}'
        });
      } else if (msg.role === 'system') {
        // System messages (shouldn't be here but handle gracefully)
        input.push({ role: 'system', content });
      }
    }

    return input;
  }

  /**
   * List available models by querying LM Studio's /v1/models endpoint
   * Discovers loaded models dynamically
   */
  async listModels(): Promise<ModelInfo[]> {
    try {
      // Use Obsidian's requestUrl to bypass CORS
      const response = await this.request({
        url: `${this.serverUrl}/v1/models`,
        operation: 'list models',
        method: 'GET',
        timeoutMs: 15_000
      });

      if (response.status !== 200) {
        // Server returned error - silently return empty (server may not be ready)
        return [];
      }

      const data = response.json as ModelListResponse | null;

      if (!data?.data || !Array.isArray(data.data)) {
        // Unexpected response format - silently return empty
        return [];
      }

      return data.data.map((model) => {
        const modelId = model.id;
        const isVisionModel = this.detectVisionSupport(modelId);
        const supportsTools = this.detectToolSupport(modelId);

        return {
          id: modelId,
          name: modelId,
          contextWindow: model.context_length || 4096,
          maxOutputTokens: model.max_tokens || 2048,
          supportsJSON: true, // Most models support JSON mode
          supportsImages: isVisionModel,
          supportsFunctions: supportsTools,
          supportsStreaming: true,
          supportsThinking: false,
          pricing: {
            inputPerMillion: 0, // Local models are free
            outputPerMillion: 0,
            currency: 'USD',
            lastUpdated: new Date().toISOString()
          }
        };
      });
    } catch {
      // Server not reachable - silently return empty (app probably not running)
      return [];
    }
  }

  getCapabilities(): ProviderCapabilities {
    return {
      supportsStreaming: true,
      streamingMode: 'streaming',
      supportsJSON: true, // Most models support JSON mode
      supportsImages: false, // Depends on specific model
      supportsFunctions: true, // Many models support function calling via OpenAI-compatible API
      supportsThinking: false,
      maxContextWindow: 128000, // Varies by model, reasonable default
      supportedFeatures: ['streaming', 'function_calling', 'json_mode', 'local', 'privacy']
    };
  }

  async getModelPricing(_modelId: string): Promise<ModelPricing | null> {
    // Local models are free - zero rates
    const pricing: ModelPricing = {
      rateInputPerMillion: 0,
      rateOutputPerMillion: 0,
      currency: 'USD'
    };

    return pricing;
  }

  async isAvailable(): Promise<boolean> {
    try {
      const response = await this.request({
        url: `${this.serverUrl}/v1/models`,
        operation: 'availability check',
        method: 'GET',
        timeoutMs: 10_000
      });
      return response.status === 200;
    } catch {
      return false;
    }
  }

  /**
   * Convert tools from Chat Completions format to ensure compatibility
   * Handles both flat and nested tool formats
   */
  private convertTools(tools: readonly unknown[]): Array<Record<string, unknown>> {
    return tools.map((tool) => {
      const toolInput = toToolInput(tool);

      // If already in flat format {type, name, description, parameters}, return as-is
      if (toolInput?.name && !toolInput.function) {
        return toolInput;
      }

      // If in nested format {type, function: {name, description, parameters}}, flatten it
      if (toolInput?.function) {
        return {
          type: 'function',
          function: {
            name: toolInput.function.name,
            description: toolInput.function.description,
            parameters: toolInput.function.parameters
          }
        };
      }

      return toolInput || {};
    });
  }

  /**
   * Detect if a model supports vision based on name patterns
   */
  private detectVisionSupport(modelId: string): boolean {
    const visionKeywords = ['vision', 'llava', 'bakllava', 'cogvlm', 'yi-vl', 'moondream'];
    const lowerModelId = modelId.toLowerCase();
    return visionKeywords.some(keyword => lowerModelId.includes(keyword));
  }

  /**
   * Detect if a model supports tool/function calling based on name patterns
   * Many newer models support function calling
   *
   * Note: Models with "nexus" or "tools" in the name likely use [TOOL_CALLS] format
   * which is automatically parsed by this adapter
   */
  private detectToolSupport(modelId: string): boolean {
    const toolSupportedKeywords = [
      'gpt', 'mistral', 'mixtral', 'hermes', 'nous', 'qwen',
      'deepseek', 'dolphin', 'functionary', 'gorilla',
      // Fine-tuned models that use [TOOL_CALLS] format
      'nexus', 'tools-sft', 'tool-calling'
    ];
    const lowerModelId = modelId.toLowerCase();
    return toolSupportedKeywords.some(keyword => lowerModelId.includes(keyword));
  }

  /**
   * Check if a model uses custom tool call format (<tool_call> or [TOOL_CALLS])
   * These are fine-tuned models that have internalized tool schemas and don't need
   * tool schemas passed via the API - they output tool calls as content.
   *
   * Delegates to centralized check in ContextBuilderFactory for consistency.
   */
  static usesToolCallsContentFormat(modelId: string): boolean {
    return usesCustomToolFormat(modelId);
  }

  /**
   * Map OpenAI finish reasons to our standard types
   */
  private mapFinishReason(reason: string | undefined): 'stop' | 'length' | 'tool_calls' | 'content_filter' {
    if (!reason) return 'stop';

    switch (reason) {
      case 'stop':
        return 'stop';
      case 'length':
      case 'max_tokens':
        return 'length';
      case 'tool_calls':
      case 'function_call':
        return 'tool_calls';
      case 'content_filter':
        return 'content_filter';
      default:
        return 'stop';
    }
  }

  protected buildMessages(prompt: string, systemPrompt?: string): Array<{ role: 'system' | 'user'; content: string }> {
    const messages: Array<{ role: 'system' | 'user'; content: string }> = [];

    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
    }

    messages.push({ role: 'user', content: prompt });

    return messages;
  }

  protected handleError(error: unknown, operation: string): never {
    if (error instanceof LLMProviderError) {
      throw error;
    }

    let message = `LM Studio ${operation} failed`;
    let code = 'UNKNOWN_ERROR';
    const details = getErrorDetails(error);

    if (details.message) {
      message += `: ${details.message}`;
    }

    if (details.code === 'ECONNREFUSED') {
      message = 'Cannot connect to LM Studio server. Make sure LM Studio is running and the server is started.';
      code = 'CONNECTION_REFUSED';
    } else if (details.code === 'ENOTFOUND') {
      message = 'LM Studio server not found. Check the URL configuration.';
      code = 'SERVER_NOT_FOUND';
    }

    throw new LLMProviderError(message, this.name, code, error instanceof Error ? error : undefined);
  }
}
