/**
 * Ollama LLM Adapter
 * Provides local, privacy-focused LLM models via Ollama
 * Local LLM provider for text generation
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
  LLMProviderError,
  ToolCall,
  Tool
} from '../types';
import { ToolCallContentParser } from '../shared/ToolCallContentParser';
import { usesCustomToolFormat } from '../../../chat/builders/ContextBuilderFactory';
import { isThinkingModelName } from '../shared/thinkingModels';

/** Native Ollama tool call shape — arguments is an object/map, and there is no id */
interface OllamaToolCall {
  function?: {
    name?: string;
    arguments?: Record<string, unknown> | string;
  };
}

interface OllamaMessage {
  role: string;
  content: string;
  tool_calls?: OllamaToolCall[];
  tool_name?: string;
  tool_call_id?: string;
  [key: string]: unknown;
}

interface OllamaOptions {
  temperature?: number;
  num_predict?: number;
  num_ctx?: number;
  draft_num_predict?: number;
  stop?: string[];
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  [key: string]: unknown;
}

interface OllamaChatResponse {
  message?: {
    role?: string;
    content?: string;
    // Native reasoning field, populated when the request sets `think: true`.
    // Streamed incrementally (one fragment per chunk), like content.
    thinking?: string;
    tool_calls?: OllamaToolCall[];
  };
  prompt_eval_count?: number;
  eval_count?: number;
  done?: boolean;
  model?: string;
  total_duration?: number;
  load_duration?: number;
  prompt_eval_duration?: number;
  eval_duration?: number;
}

/** GET /api/tags response shape */
interface OllamaTagsResponse {
  models?: Array<{
    name?: string;
    model?: string;
    details?: {
      family?: string;
      parameter_size?: string;
      quantization_level?: string;
    };
  }>;
}

export class OllamaAdapter extends BaseAdapter {
  readonly name = 'ollama';
  readonly baseUrl: string;
  
  private ollamaUrl: string;
  /** Optional num_ctx override sent per request; undefined = use Ollama's server default */
  private contextLength?: number;
  /**
   * Speculative-decoding state. When undefined, draft_num_predict is left untouched
   * (Ollama's own default applies). When true, draft_num_predict is sent (draftNumPredict ?? 4)
   * to enable/tune drafting on MTP-capable models; when false, 0 is sent to disable it.
   */
  private speculativeDecoding?: boolean;
  private draftNumPredict?: number;

  constructor(
    ollamaUrl: string,
    userModel: string,
    contextLength?: number,
    speculativeDecoding?: boolean,
    draftNumPredict?: number
  ) {
    // Ollama doesn't need an API key - set requiresApiKey to false
    // Use user-configured model instead of hardcoded default
    super('', userModel, ollamaUrl, false);

    this.ollamaUrl = ollamaUrl;
    this.baseUrl = ollamaUrl;
    this.contextLength = contextLength && contextLength > 0 ? contextLength : undefined;
    this.speculativeDecoding = speculativeDecoding;
    this.draftNumPredict = draftNumPredict && draftNumPredict > 0 ? draftNumPredict : undefined;

    this.initializeCache();
  }

  async* generateStreamAsync(prompt: string, options?: GenerateOptions): AsyncGenerator<StreamChunk, void, unknown> {
    try {
      const model = options?.model || this.currentModel;

      // Check for pre-built conversation history (tool continuations)
      let messages: OllamaMessage[];
      if (options?.conversationHistory && options.conversationHistory.length > 0) {
        messages = options.conversationHistory as OllamaMessage[];
      } else {
        messages = this.buildMessages(prompt, options?.systemPrompt);
      }

      const requestBody: Record<string, unknown> = {
        model: model,
        messages: this.normalizeMessagesForOllama(messages),
        stream: true,
        // Native reasoning separation: thinking arrives in message.thinking instead of
        // leaking as inline <think> tags in content.
        think: this.shouldEnableThinking(model, options),
        options: this.buildOllamaOptions(options)
      };

      // Native tool calling: pass tool schemas unless the model uses the
      // content-embedded custom format (those route through ToolCallContentParser).
      const skipToolSchemas = usesCustomToolFormat(model);
      if (options?.tools && options.tools.length > 0 && !skipToolSchemas) {
        requestBody.tools = this.convertTools(options.tools);
      }

      // Structured output: Ollama's `format` accepts "json" or a JSON schema.
      if (options?.jsonMode) {
        requestBody.format = 'json';
      }

      // Use /api/chat endpoint (supports messages array and tool calling)
      // requestStream() throws on HTTP errors; no assertOk needed
      const nodeStream = await this.requestStream({
        url: `${this.ollamaUrl}/api/chat`,
        operation: 'streaming generation',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
        timeoutMs: 120_000
      });

      let accumulatedContent = '';
      let pendingToolCalls: ToolCall[] | undefined;
      let pendingUsage: TokenUsage | undefined;
      let hasContentToolFormat = false;

      for await (const chunk of this.processNodeStreamJsonLines(nodeStream, {
        extractChunk: (parsed) => {
          const response = parsed as OllamaChatResponse;
          const nativeToolCalls = response.message?.tool_calls?.length
            ? this.convertOllamaToolCalls(response.message.tool_calls)
            : undefined;
          const reasoning = response.message?.thinking;
          const usage = response.done
            ? {
                promptTokens: response.prompt_eval_count || 0,
                completionTokens: response.eval_count || 0,
                totalTokens: (response.prompt_eval_count || 0) + (response.eval_count || 0)
              }
            : undefined;
          if (response.message?.content || reasoning || nativeToolCalls || usage) {
            return {
              content: response.message?.content || '',
              complete: false,
              // Reasoning fragments stream before content; route to the thinking channel.
              reasoning: reasoning || undefined,
              reasoningComplete: reasoning ? false : undefined,
              toolCalls: nativeToolCalls,
              toolCallsReady: !!nativeToolCalls,
              usage
            };
          }
          return null;
        },
        extractDone: (parsed) => !!(parsed as OllamaChatResponse).done
      })) {
        if (chunk.content) {
          accumulatedContent += chunk.content;
        }
        if (chunk.toolCalls) {
          pendingToolCalls = chunk.toolCalls;
        }
        if (chunk.usage) {
          pendingUsage = chunk.usage;
        }

        // Detect content-embedded tool-call format (custom/fine-tuned models)
        if (!hasContentToolFormat && !pendingToolCalls &&
            ToolCallContentParser.hasToolCallsFormat(accumulatedContent)) {
          hasContentToolFormat = true;
        }

        if (chunk.complete) {
          let content = '';
          let toolCalls = pendingToolCalls;
          if (!toolCalls && hasContentToolFormat) {
            const parsed = ToolCallContentParser.parse(accumulatedContent);
            if (parsed.hasToolCalls) {
              toolCalls = parsed.toolCalls;
              content = parsed.cleanContent;
            }
          }
          yield {
            content,
            complete: true,
            toolCalls,
            toolCallsReady: !!toolCalls,
            usage: pendingUsage
          };
        } else if (pendingToolCalls || hasContentToolFormat) {
          // Suppress raw deltas once tool calls are being assembled — native
          // tool_calls arrive whole, and custom-format markers must not leak to the UI.
          continue;
        } else {
          yield chunk;
        }
      }
    } catch (error) {
      if (error instanceof LLMProviderError) {
        throw error;
      }
      throw new LLMProviderError(
        `Ollama streaming failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'streaming',
        'NETWORK_ERROR'
      );
    }
  }

  async generateUncached(prompt: string, options?: GenerateOptions): Promise<LLMResponse> {
    try {
      const model = options?.model || this.currentModel;

      // Check for pre-built conversation history (tool continuations)
      let messages: OllamaMessage[];
      if (options?.conversationHistory && options.conversationHistory.length > 0) {
        messages = options.conversationHistory as OllamaMessage[];
      } else {
        messages = this.buildMessages(prompt, options?.systemPrompt);
      }

      const requestBody: Record<string, unknown> = {
        model: model,
        messages: this.normalizeMessagesForOllama(messages),
        stream: false,
        // Native reasoning separation (see streaming path) — keeps <think> out of content.
        think: this.shouldEnableThinking(model, options),
        options: this.buildOllamaOptions(options)
      };

      const skipToolSchemas = usesCustomToolFormat(model);
      if (options?.tools && options.tools.length > 0 && !skipToolSchemas) {
        requestBody.tools = this.convertTools(options.tools);
      }

      if (options?.jsonMode) {
        requestBody.format = 'json';
      }

      // Use /api/chat endpoint (supports messages array and tool calling)
      const response = await this.request<OllamaChatResponse>({
        url: `${this.ollamaUrl}/api/chat`,
        operation: 'generation',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
        timeoutMs: 60_000
      });

      this.assertOk(response, `Ollama API error: ${response.status} - ${response.text || 'Unknown error'}`);

      const data = response.json;
      if (!data?.message) {
        throw new LLMProviderError(
          'Invalid response format from Ollama API: missing message field',
          'generation',
          'INVALID_RESPONSE'
        );
      }

      // Native tool calls (arguments as object), with content-embedded fallback
      let content = data.message.content || '';
      let toolCalls = data.message.tool_calls?.length
        ? this.convertOllamaToolCalls(data.message.tool_calls)
        : undefined;
      if (!toolCalls && ToolCallContentParser.hasToolCallsFormat(content)) {
        const parsed = ToolCallContentParser.parse(content);
        if (parsed.hasToolCalls) {
          toolCalls = parsed.toolCalls;
          content = parsed.cleanContent;
        }
      }

      // A valid response has either content or tool calls
      if (!content && !toolCalls) {
        throw new LLMProviderError(
          'Invalid response format from Ollama API: missing message content and tool calls',
          'generation',
          'INVALID_RESPONSE'
        );
      }

      // Extract usage information
      const usage: TokenUsage = {
        promptTokens: data.prompt_eval_count || 0,
        completionTokens: data.eval_count || 0,
        totalTokens: (data.prompt_eval_count || 0) + (data.eval_count || 0)
      };

      const finishReason = toolCalls && toolCalls.length > 0
        ? 'tool_calls'
        : (data.done ? 'stop' : 'length');
      const reasoning = data.message.thinking;
      const metadata = {
        cached: false,
        modelDetails: data.model,
        totalDuration: data.total_duration,
        loadDuration: data.load_duration,
        promptEvalDuration: data.prompt_eval_duration,
        evalDuration: data.eval_duration,
        ...(typeof reasoning === 'string' && reasoning.length > 0 ? { reasoning } : {})
      };

      return await this.buildLLMResponse(
        content,
        model,
        usage,
        metadata,
        finishReason,
        toolCalls
      );
    } catch (error) {
      if (error instanceof LLMProviderError) {
        throw error;
      }
      throw new LLMProviderError(
        `Ollama generation failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'generation',
        'NETWORK_ERROR'
      );
    }
  }

  async generateStream(prompt: string, options?: GenerateOptions): Promise<LLMResponse> {
    try {
      const model = options?.model || this.currentModel;

      // Collect streaming chunks into a complete response
      let fullText = '';
      let usage: TokenUsage = {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0
      };

      for await (const chunk of this.generateStreamAsync(prompt, options)) {
        if (chunk.content) {
          fullText += chunk.content;
        }
        if (chunk.usage) {
          usage = chunk.usage;
        }
      }

      const result: LLMResponse = {
        text: fullText,
        model: model,
        provider: this.name,
        usage: usage,
        cost: {
          inputCost: 0, // Local models are free
          outputCost: 0,
          totalCost: 0,
          currency: 'USD',
          rateInputPerMillion: 0,
          rateOutputPerMillion: 0
        },
        finishReason: 'stop',
        metadata: {
          cached: false,
          streamed: true
        }
      };

      return result;
    } catch (error) {
      const errorObj = error instanceof Error ? error : new Error('Unknown streaming error');

      if (error instanceof LLMProviderError) {
        throw error;
      }
      throw new LLMProviderError(
        `Ollama streaming failed: ${errorObj.message}`,
        'streaming',
        'NETWORK_ERROR'
      );
    }
  }

  /**
   * List installed models by querying Ollama's /api/tags endpoint.
   * Falls back to the user-configured model if discovery fails or returns nothing,
   * so a manually-entered model is still selectable when the server is unreachable.
   */
  async listModels(): Promise<ModelInfo[]> {
    try {
      const response = await this.request({
        url: `${this.ollamaUrl}/api/tags`,
        operation: 'list models',
        method: 'GET',
        timeoutMs: 15_000
      });

      if (response.status !== 200) {
        return this.fallbackModelList();
      }

      const data = response.json as OllamaTagsResponse | null;
      const models = data?.models;
      if (!Array.isArray(models) || models.length === 0) {
        return this.fallbackModelList();
      }

      return models
        .map((m) => m.name || m.model)
        .filter((id): id is string => !!id)
        .map((id) => this.buildModelInfo(id));
    } catch {
      // Server not reachable — surface the configured model so the UI isn't empty
      return this.fallbackModelList();
    }
  }

  private fallbackModelList(): ModelInfo[] {
    if (!this.currentModel || !this.currentModel.trim()) {
      return [];
    }
    return [this.buildModelInfo(this.currentModel)];
  }

  private buildModelInfo(modelId: string): ModelInfo {
    return {
      id: modelId,
      name: modelId,
      // Report the user-configured num_ctx when set so token budgeting matches what
      // Ollama actually allocates; otherwise a generous default (the true per-model
      // max isn't known here, and the server default depends on VRAM).
      contextWindow: this.contextLength ?? 128000,
      supportsStreaming: true,
      supportsJSON: true, // Ollama supports `format: json` / JSON schema
      supportsImages: this.detectVisionSupport(modelId),
      supportsFunctions: this.detectToolSupport(modelId),
      supportsThinking: isThinkingModelName(modelId),
      pricing: {
        inputPerMillion: 0, // Local models are free
        outputPerMillion: 0,
        currency: 'USD',
        lastUpdated: new Date().toISOString()
      }
    };
  }

  getCapabilities(): ProviderCapabilities {
    return {
      supportsStreaming: true,
      streamingMode: 'streaming',
      supportsJSON: true, // `format` parameter accepts "json" or a JSON schema
      supportsImages: false, // Depends on specific model
      supportsFunctions: true, // Native tool calling via /api/chat `tools`
      supportsThinking: true, // Reasoning models stream native message.thinking (think: true)
      maxContextWindow: 128000, // Varies by model, this is a reasonable default
      supportedFeatures: ['streaming', 'function_calling', 'json_mode', 'local', 'privacy']
    };
  }

  getModelPricing(_modelId: string): Promise<ModelPricing | null> {
    // Local models are free - zero rates
    return Promise.resolve({
      rateInputPerMillion: 0,
      rateOutputPerMillion: 0,
      currency: 'USD'
    });
  }

  async isAvailable(): Promise<boolean> {
    try {
      const response = await this.request({
        url: `${this.ollamaUrl}/api/tags`,
        operation: 'availability check',
        method: 'GET',
        timeoutMs: 10_000
      });
      return response.status === 200;
    } catch {
      return false;
    }
  }

  // Utility methods
  private formatSize(bytes: number): string {
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    if (bytes === 0) return '0 B';
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return Math.round(bytes / Math.pow(1024, i) * 100) / 100 + ' ' + sizes[i];
  }

  protected buildMessages(prompt: string, systemPrompt?: string): OllamaMessage[] {
    const messages: OllamaMessage[] = [];

    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
    }

    messages.push({ role: 'user', content: prompt });

    return messages;
  }

  /**
   * Resolve the top-level `think` request flag. Ollama separates reasoning into
   * `message.thinking` only when this is true; otherwise a thinking model leaks its
   * reasoning as inline <think> tags in content. Explicit user choice wins; otherwise
   * we default thinking-capable models on (so their reasoning renders) and leave others
   * off. Sending the flag to a non-thinking model is a safe no-op (Ollama ignores it).
   */
  private shouldEnableThinking(model: string, options?: GenerateOptions): boolean {
    return options?.enableThinking ?? isThinkingModelName(model);
  }

  /** Build the Ollama `options` object, dropping undefined values */
  private buildOllamaOptions(options?: GenerateOptions): OllamaOptions {
    const ollamaOptions: OllamaOptions = {
      temperature: options?.temperature,
      num_predict: options?.maxTokens,
      // num_ctx: provider-configured context length. When undefined the key is
      // stripped below and Ollama falls back to its own server default.
      num_ctx: this.contextLength,
      // draft_num_predict: speculative decoding. On => draftNumPredict ?? 4 (only speeds up
      // models with built-in MTP tensors; no-op otherwise). Off => 0 (explicitly disable).
      // Undefined toggle => key stripped below, Ollama's own default applies.
      draft_num_predict: this.speculativeDecoding === undefined
        ? undefined
        : (this.speculativeDecoding ? (this.draftNumPredict ?? 4) : 0),
      stop: options?.stopSequences,
      top_p: options?.topP,
      frequency_penalty: options?.frequencyPenalty,
      presence_penalty: options?.presencePenalty
    };
    Object.keys(ollamaOptions).forEach((key) => {
      if (ollamaOptions[key] === undefined) {
        delete ollamaOptions[key];
      }
    });
    return ollamaOptions;
  }

  /**
   * Convert tool schemas to Ollama's native format. Ollama accepts the same
   * `{ type: 'function', function: { name, description, parameters } }` shape as
   * OpenAI, so nested definitions pass through and flat ones are wrapped.
   */
  private convertTools(tools: Tool[]): Array<Record<string, unknown>> {
    return tools.map((tool) => {
      if (tool.function) {
        return {
          type: 'function',
          function: {
            name: tool.function.name,
            description: tool.function.description,
            parameters: tool.function.parameters
          }
        };
      }
      return tool as unknown as Record<string, unknown>;
    });
  }

  /**
   * Convert native Ollama tool calls into the shared ToolCall shape.
   * Ollama returns `arguments` as an object and provides no call id, so we
   * stringify the arguments and synthesize a stable id from position + name.
   */
  private convertOllamaToolCalls(toolCalls: OllamaToolCall[]): ToolCall[] {
    return toolCalls.map((tc, index) => {
      const name = tc.function?.name || '';
      const rawArgs = tc.function?.arguments;
      const args = typeof rawArgs === 'string' ? rawArgs : JSON.stringify(rawArgs ?? {});
      return {
        id: `ollama-tool-${index}-${name}`,
        type: 'function',
        name,
        function: { name, arguments: args },
        sourceFormat: 'native'
      };
    });
  }

  /**
   * Normalize OpenAI-format conversation history into Ollama's native message
   * shape. The OpenAI context builder emits assistant `tool_calls` with
   * `function.arguments` as a JSON string and tool results keyed by
   * `tool_call_id`; native /api/chat expects object arguments and tool results
   * keyed by `tool_name`.
   */
  private normalizeMessagesForOllama(messages: OllamaMessage[]): OllamaMessage[] {
    const idToToolName = new Map<string, string>();

    return messages.map((msg) => {
      if (msg.role === 'assistant' && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
        const toolCalls: OllamaToolCall[] = (msg.tool_calls as Array<Record<string, unknown>>).map((tc) => {
          const fn = (tc.function || {}) as { name?: string; arguments?: unknown };
          const name = fn.name || (tc.name as string) || '';
          if (typeof tc.id === 'string') {
            idToToolName.set(tc.id, name);
          }
          let args = fn.arguments;
          if (typeof args === 'string') {
            try {
              args = JSON.parse(args);
            } catch {
              args = {};
            }
          }
          return { function: { name, arguments: (args as Record<string, unknown>) ?? {} } };
        });
        return { ...msg, tool_calls: toolCalls };
      }

      if (msg.role === 'tool') {
        const toolName = msg.tool_name
          || (typeof msg.tool_call_id === 'string' ? idToToolName.get(msg.tool_call_id) : undefined);
        const normalized: OllamaMessage = { role: 'tool', content: msg.content ?? '' };
        if (toolName) {
          normalized.tool_name = toolName;
        }
        return normalized;
      }

      return msg;
    });
  }

  /** Detect likely vision support from the model name */
  private detectVisionSupport(modelId: string): boolean {
    const visionKeywords = ['vision', 'llava', 'bakllava', 'cogvlm', 'yi-vl', 'moondream', 'minicpm-v'];
    const lower = modelId.toLowerCase();
    return visionKeywords.some((keyword) => lower.includes(keyword));
  }

  /** Detect likely tool/function-calling support from the model name */
  private detectToolSupport(modelId: string): boolean {
    const toolKeywords = [
      'llama3.1', 'llama3.2', 'llama3.3', 'llama4',
      'mistral', 'mixtral', 'nemo', 'firefunction', 'command-r',
      'qwen', 'hermes', 'nous', 'deepseek', 'functionary', 'gorilla',
      'granite', 'phi', 'smollm', 'cogito',
      // Fine-tuned models that emit content-embedded tool calls
      'nexus', 'tools-sft', 'tool-calling'
    ];
    const lower = modelId.toLowerCase();
    return toolKeywords.some((keyword) => lower.includes(keyword));
  }

  protected handleError(error: unknown, operation: string): never {
    if (error instanceof LLMProviderError) {
      throw error;
    }

    let message = `Ollama ${operation} failed`;
    let code = 'UNKNOWN_ERROR';

    const errorLike = error as { message?: string; code?: string } | null;

    if (errorLike?.message) {
      message += `: ${errorLike.message}`;
    }

    if (errorLike?.code === 'ECONNREFUSED') {
      message = 'Cannot connect to Ollama server. Make sure Ollama is running.';
      code = 'CONNECTION_REFUSED';
    } else if (errorLike?.code === 'ENOTFOUND') {
      message = 'Ollama server not found. Check the URL configuration.';
      code = 'SERVER_NOT_FOUND';
    }

    throw new LLMProviderError(message, this.name, code, error instanceof Error ? error : undefined);
  }
}
