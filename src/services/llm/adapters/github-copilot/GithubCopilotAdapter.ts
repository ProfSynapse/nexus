import { BaseAdapter } from '../BaseAdapter';
import { GenerateOptions, StreamChunk, LLMResponse, ModelInfo, ProviderCapabilities, ModelPricing, Tool, ToolCall } from '../types';
import { GITHUB_COPILOT_DEFAULT_MODEL } from './GithubCopilotModels';
import { ProviderHttpClient, ProviderHttpError } from '../shared/ProviderHttpClient';

const COPILOT_API_ENDPOINT = 'https://api.githubcopilot.com/chat/completions';
const COPILOT_RESPONSES_ENDPOINT = 'https://api.githubcopilot.com/responses';
const COPILOT_MODELS_ENDPOINT = 'https://api.githubcopilot.com/models';

interface CopilotModelDescriptor {
  id: string;
  name?: string;
  context_window?: number;
  contextWindow?: number;
  max_output_tokens?: number;
  maxTokens?: number;
  supported_endpoints?: string[];
}

interface CopilotModelsResponse {
  data?: CopilotModelDescriptor[];
}

interface CopilotSessionTokenResponse {
  token?: string;
}

interface CopilotChatCompletionMessage {
  content?: string;
}

interface CopilotChatCompletionChoice {
  message?: CopilotChatCompletionMessage;
}

interface CopilotChatCompletionResponse {
  choices?: CopilotChatCompletionChoice[];
  model: string;
  usage?: LLMResponse['usage'];
}

interface CopilotRequestMessage extends Record<string, unknown> {
  role: string;
  content?: string;
}

interface CopilotResponsesItem {
  type?: string;
  call_id?: string;
  id?: string;
  name?: string;
  arguments?: string;
}

interface CopilotResponsesApiEvent {
  type?: string;
  delta?: unknown;
  response?: {
    id?: string;
  };
  item?: CopilotResponsesItem;
  output_index?: number;
}

interface CopilotChatTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

interface CopilotSSEChoice {
  delta?: {
    content?: string;
    tool_calls?: Array<{
      id?: string;
      type?: string;
      function?: {
        name?: string;
        arguments?: string;
      };
    }>;
  };
  finish_reason?: string;
}

interface CopilotSSEEvent {
  choices?: CopilotSSEChoice[];
}

export class GithubCopilotAdapter extends BaseAdapter {
  readonly name = 'github-copilot';
  readonly baseUrl = COPILOT_API_ENDPOINT;

  /** Cached supported_endpoints per model ID, populated by syncModels() */
  private modelEndpointMap = new Map<string, string[]>();

  constructor(apiKey?: string, defaultModel?: string) {
    super(apiKey || '', defaultModel || GITHUB_COPILOT_DEFAULT_MODEL);
    this.initializeCache();
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
      supportedFeatures: ['chat']
    };
  }

  async getModelPricing(_modelId: string): Promise<ModelPricing | null> {
    return null;
  }

  async listModels(): Promise<ModelInfo[]> {
    const toModelInfo = (model: CopilotModelDescriptor): ModelInfo => ({
      id: model.id,
      name: model.name || model.id,
      contextWindow: model.context_window || model.contextWindow || 200000,
      maxOutputTokens: model.max_output_tokens || model.maxTokens || 16000,
      supportsJSON: true,
      supportsImages: false,
      supportsFunctions: true,
      supportsStreaming: true,
      supportsThinking: false,
      pricing: { inputPerMillion: 0, outputPerMillion: 0, currency: 'USD', lastUpdated: '' }
    });

    if (this.apiKey) {
      try {
        const syncedModels = await this.syncModels(this.apiKey);
        if (syncedModels && syncedModels.length > 0) {
          return syncedModels.map(toModelInfo);
        }
      } catch {
        // Intentionally swallow discovery failures and fall back to an empty model list.
      }
    }
    return [];
  }

  async syncModels(token: string): Promise<CopilotModelDescriptor[]> {
    const sessionToken = await this.getSessionToken(token);
    const headers = this.getAuthHeaders(sessionToken);

    const response = await ProviderHttpClient.request({
      url: COPILOT_MODELS_ENDPOINT,
      provider: this.name,
      operation: 'syncModels',
      method: 'GET',
      headers
    });
    const models = ((response.json as CopilotModelsResponse).data || []);

    // Cache supported_endpoints per model for routing decisions
    for (const model of models) {
      if (model.id && Array.isArray(model.supported_endpoints)) {
        this.modelEndpointMap.set(model.id, model.supported_endpoints);
      }
    }

    return models;
  }

  private async getSessionToken(ghuToken: string): Promise<string> {
    const headers = {
      'Authorization': `token ${ghuToken}`,
      'Accept': 'application/json',
      'Editor-Version': 'vscode/1.90.0',
      'Editor-Plugin-Version': 'copilot-chat/0.17.1',
      'User-Agent': 'GitHubCopilotChat/0.17.1'
    };

    const response = await ProviderHttpClient.request({
      url: 'https://api.github.com/copilot_internal/v2/token',
      provider: this.name,
      operation: 'getSessionToken',
      method: 'GET',
      headers
    });
    
    const json = response.json as CopilotSessionTokenResponse;
    if (!json.token) throw new Error('Failed to fetch Copilot session token');
    return json.token;
  }

  private getAuthHeaders(sessionToken: string): Record<string, string> {
    return {
      'Authorization': `Bearer ${sessionToken}`,
      'Editor-Version': 'vscode/1.90.0',
      'Editor-Plugin-Version': 'copilot-chat/0.17.1',
      'User-Agent': 'GitHubCopilotChat/0.17.1',
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    };
  }

  /**
   * Determine whether a model requires the Responses API (/responses) instead of
   * Chat Completions (/chat/completions). Checks cached supported_endpoints from
   * syncModels() first, then falls back to a model-ID heuristic for GPT-5+ models.
   */
  private usesResponsesApi(modelId: string): boolean {
    const endpoints = this.modelEndpointMap.get(modelId);
    if (endpoints) {
      return endpoints.includes('/responses');
    }
    // Fallback heuristic: GPT-5+ models (except gpt-5-mini) use /responses
    return modelId.startsWith('gpt-5') && !modelId.startsWith('gpt-5-mini');
  }

  async generateUncached(prompt: string, options?: GenerateOptions): Promise<LLMResponse> {
    if (!this.apiKey) throw new Error('GitHub Copilot requires authentication.');

    if (options?.tools && options.tools.length > 0) {
      throw new Error('Tool execution requires streaming. Use generateStreamAsync() instead.');
    }

    const sessionToken = await this.getSessionToken(this.apiKey);
    const headers = this.getAuthHeaders(sessionToken);
    const messages = this.buildRequestMessages(prompt, options);

    const payload = {
      model: options?.model || this.currentModel,
      messages,
      temperature: options?.temperature ?? 0.5,
      max_tokens: options?.maxTokens,
      top_p: options?.topP,
      stop: options?.stopSequences,
      response_format: options?.jsonMode ? { type: 'json_object' } : undefined,
      stream: false
    };

    const response = await ProviderHttpClient.request({
      url: this.baseUrl,
      provider: this.name,
      operation: 'generateMessage',
      method: 'POST',
      headers,
      body: JSON.stringify(payload)
    });
    
    const data = response.json as CopilotChatCompletionResponse;
    return {
      text: data.choices?.[0]?.message?.content || '',
      model: data.model,
      usage: data.usage
    };
  }

  async *generateStreamAsync(prompt: string, options?: GenerateOptions): AsyncGenerator<StreamChunk, void, unknown> {
    if (!this.apiKey) throw new Error('GitHub Copilot requires authentication.');

    const sessionToken = await this.getSessionToken(this.apiKey);
    const headers = this.getAuthHeaders(sessionToken);
    const modelId = options?.model || this.currentModel;

    if (this.usesResponsesApi(modelId)) {
      yield* this.generateStreamAsyncResponses(headers, prompt, options, modelId);
      return;
    }

    // Chat Completions path (unchanged for non-Responses models)
    const messages = this.buildRequestMessages(prompt, options);
    const tools = options?.tools ? this.convertTools(options.tools) : undefined;

    const payload = {
      model: modelId,
      messages,
      temperature: options?.temperature ?? 0.5,
      max_tokens: options?.maxTokens,
      top_p: options?.topP,
      stop: options?.stopSequences,
      response_format: options?.jsonMode ? { type: 'json_object' } : undefined,
      tools,
      tool_choice: tools && tools.length > 0 ? 'auto' : undefined,
      stream: true
    };

    try {
      const stream = await this.requestStream({
        url: this.baseUrl,
        operation: 'generateStreamAsync',
        method: 'POST',
        headers,
        body: JSON.stringify(payload)
      });

      yield* this.processNodeStream(stream, {
        extractContent: (parsed) => {
          const event = parsed as CopilotSSEEvent;
          return event.choices?.[0]?.delta?.content || null;
        },
        extractToolCalls: (parsed) => {
          const event = parsed as CopilotSSEEvent;
          return event.choices?.[0]?.delta?.tool_calls || null;
        },
        extractFinishReason: (parsed) => {
          const event = parsed as CopilotSSEEvent;
          return event.choices?.[0]?.finish_reason || null;
        },
        accumulateToolCalls: true,
        toolCallThrottling: {
          initialYield: true,
          progressInterval: 50
        }
      });
    } catch (err) {
      if (err instanceof ProviderHttpError) {
        console.error('[Copilot] API error:', err.response.status, JSON.stringify(err.response.data ?? err.response.text));
      }
      throw err;
    }
  }

  /**
   * Streaming generation via the Responses API endpoint (/responses).
   * Used for GPT-5+ models that don't support /chat/completions.
   * Format: { model, input, instructions, stream, tools, tool_choice }
   * SSE events use Responses API format (delta is plain string, different event types).
   */
  private async *generateStreamAsyncResponses(
    headers: Record<string, string>,
    prompt: string,
    options: GenerateOptions | undefined,
    modelId: string
  ): AsyncGenerator<StreamChunk, void, unknown> {
    const messages = this.buildRequestMessages(prompt, options);

    // Extract system message as 'instructions' and remove from input array
    let instructions = '';
    const input: Array<Record<string, unknown>> = [];
    for (const msg of messages) {
      if (msg.role === 'system') {
        instructions += (instructions ? '\n' : '') + (msg.content || '');
      } else {
        input.push(msg);
      }
    }

    const requestBody: Record<string, unknown> = {
      model: modelId,
      input,
      instructions,
      stream: true
    };

    if (options?.maxTokens !== undefined) {
      requestBody.max_output_tokens = options.maxTokens;
    }

    // Convert tools to Responses API flat format
    if (options?.tools && options.tools.length > 0) {
      requestBody.tools = options.tools.map((tool) => {
        const fn = tool.function;
        if (fn) {
          const converted: Record<string, unknown> = {
            type: 'function',
            name: fn.name,
            parameters: fn.parameters || {}
          };
          if (fn.description) converted.description = fn.description;
          return converted;
        }
        return tool;
      });
      requestBody.tool_choice = 'auto';
    }

    try {
      const nodeStream = await this.requestStream({
        url: COPILOT_RESPONSES_ENDPOINT,
        operation: 'generateStreamAsyncResponses',
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody)
      });

      yield* this.processResponsesStream(nodeStream);
    } catch (err) {
      if (err instanceof ProviderHttpError) {
        console.error('[Copilot] Responses API error:', err.response.status, JSON.stringify(err.response.data ?? err.response.text));
      }
      throw err;
    }
  }

  /**
   * Process Responses API SSE events from a Node.js readable stream.
   * Handles the different event structure from /responses (vs /chat/completions).
   * Modeled after OpenAICodexAdapter.processCodexNodeStream().
   */
  private isResponsesApiEvent(value: unknown): value is CopilotResponsesApiEvent {
    return typeof value === 'object' && value !== null;
  }

  private async *processResponsesStream(
    nodeStream: NodeJS.ReadableStream
  ): AsyncGenerator<StreamChunk, void, unknown> {
    const { createParser } = await import('eventsource-parser');

    const eventQueue: StreamChunk[] = [];
    const toolCallsMap = new Map<number, ToolCall>();
    let currentResponseId: string | null = null;
    let isCompleted = false;

    const parser = createParser((sseEvent) => {
      if (sseEvent.type === 'reconnect-interval' || isCompleted) return;
      if (sseEvent.data === '[DONE]') {
        if (!isCompleted) {
          const toolCallsArray = Array.from(toolCallsMap.values());
          eventQueue.push({
            content: '',
            complete: true,
            toolCalls: toolCallsArray.length > 0 ? toolCallsArray : undefined,
            toolCallsReady: toolCallsArray.length > 0,
            metadata: currentResponseId ? { responseId: currentResponseId } : undefined
          });
          isCompleted = true;
        }
        return;
      }

      let event: CopilotResponsesApiEvent;
      try {
        const parsed = JSON.parse(sseEvent.data) as unknown;
        if (!this.isResponsesApiEvent(parsed)) {
          return;
        }
        event = parsed;
      } catch {
        return;
      }

      // Capture response ID
      if (event.response?.id && !currentResponseId) {
        currentResponseId = event.response.id;
      }

      switch (event.type) {
        case 'response.output_text.delta': {
          // delta is a plain string in Responses API
          const text = typeof event.delta === 'string' ? event.delta : null;
          if (text) {
            eventQueue.push({ content: text, complete: false });
          }
          break;
        }

        case 'response.output_item.done': {
          // Completed item — may be a function_call
          if (event.item?.type === 'function_call') {
            toolCallsMap.set(event.output_index || 0, {
              id: event.item.call_id || event.item.id || '',
              type: 'function',
              function: {
                name: event.item.name || '',
                arguments: event.item.arguments || '{}'
              }
            });
          }
          break;
        }

        case 'response.done':
        case 'response.completed': {
          const toolCallsArray = Array.from(toolCallsMap.values());
          eventQueue.push({
            content: '',
            complete: true,
            toolCalls: toolCallsArray.length > 0 ? toolCallsArray : undefined,
            toolCallsReady: toolCallsArray.length > 0,
            metadata: currentResponseId ? { responseId: currentResponseId } : undefined
          });
          isCompleted = true;
          break;
        }

        default:
          // Other events (response.created, function_call_arguments.delta, etc.)
          break;
      }
    });

    try {
      for await (const chunk of nodeStream as AsyncIterable<Buffer>) {
        if (isCompleted) break;
        const text = typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
        parser.feed(text);

        while (eventQueue.length > 0) {
          const nextEvent = eventQueue.shift();
          if (!nextEvent) {
            break;
          }

          yield nextEvent;
          if (nextEvent.complete) {
            isCompleted = true;
            break;
          }
        }
      }

      // Drain remaining events
      while (eventQueue.length > 0) {
        const nextEvent = eventQueue.shift();
        if (!nextEvent) {
          break;
        }
        yield nextEvent;
      }

      if (!isCompleted) {
        yield { content: '', complete: true };
      }
    } catch (error) {
      console.error('[GithubCopilotAdapter] Error processing Responses stream:', error);
      throw error;
    }
  }

  private buildRequestMessages(prompt: string, options?: GenerateOptions): CopilotRequestMessage[] {
    if (options?.conversationHistory && options.conversationHistory.length > 0) {
      return options.conversationHistory as unknown as CopilotRequestMessage[];
    }

    return this.buildMessages(prompt, options?.systemPrompt) as unknown as CopilotRequestMessage[];
  }

  private convertTools(tools: Tool[]): CopilotChatTool[] {
    return tools.map(tool => {
      if (tool.type === 'function' && tool.function) {
        return {
          type: 'function',
          function: {
            name: tool.function.name,
            description: tool.function.description,
            parameters: tool.function.parameters
          }
        };
      }

      throw new Error(`Unsupported tool type: ${tool.type}`);
    });
  }
}
