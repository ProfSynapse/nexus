import { BaseAdapter } from '../BaseAdapter';
import { GenerateOptions, StreamChunk, LLMResponse, ModelInfo, ProviderCapabilities, ModelPricing, Tool } from '../types';
import { GITHUB_COPILOT_DEFAULT_MODEL } from './GithubCopilotModels';
import { ProviderHttpClient } from '../shared/ProviderHttpClient';

const COPILOT_API_ENDPOINT = 'https://api.githubcopilot.com/chat/completions';
const COPILOT_MODELS_ENDPOINT = 'https://api.githubcopilot.com/models';

interface CopilotModelMetadata {
  id: string;
  name?: string;
  context_window?: number;
  contextWindow?: number;
  max_output_tokens?: number;
  maxTokens?: number;
}

interface CopilotToolCallDelta {
  index?: number;
  id?: string;
  type?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
  reasoning_details?: unknown[];
  thought_signature?: string;
}

interface CopilotResponseChoice {
  message?: {
    content?: string | null;
  };
  delta?: {
    content?: string | null;
    tool_calls?: CopilotToolCallDelta[];
  };
  finish_reason?: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function getOptionalString(value: unknown): string | undefined {
  return isString(value) ? value : undefined;
}

function getOptionalNumber(value: unknown): number | undefined {
  return isFiniteNumber(value) ? value : undefined;
}

function parseModelMetadata(value: unknown): CopilotModelMetadata | null {
  if (!isRecord(value)) {
    return null;
  }

  const id = getOptionalString(value.id);
  if (!id) {
    return null;
  }

  return {
    id,
    name: getOptionalString(value.name),
    context_window: getOptionalNumber(value.context_window),
    contextWindow: getOptionalNumber(value.contextWindow),
    max_output_tokens: getOptionalNumber(value.max_output_tokens),
    maxTokens: getOptionalNumber(value.maxTokens)
  };
}

function parseModelsPayload(value: unknown): CopilotModelMetadata[] {
  if (!isRecord(value) || !Array.isArray(value.data)) {
    return [];
  }

  return value.data
    .map(parseModelMetadata)
    .filter((model): model is CopilotModelMetadata => model !== null);
}

function getSessionTokenFromPayload(value: unknown): string | null {
  if (!isRecord(value)) {
    return null;
  }

  return getOptionalString(value.token) ?? null;
}

function parseToolCallDelta(value: unknown): CopilotToolCallDelta | null {
  if (!isRecord(value)) {
    return null;
  }

  const toolCall: CopilotToolCallDelta = {
    index: getOptionalNumber(value.index),
    id: getOptionalString(value.id),
    type: getOptionalString(value.type),
    thought_signature: getOptionalString(value.thought_signature)
  };

  if (Array.isArray(value.reasoning_details)) {
    toolCall.reasoning_details = value.reasoning_details;
  }

  if (isRecord(value.function)) {
    toolCall.function = {
      name: getOptionalString(value.function.name),
      arguments: getOptionalString(value.function.arguments)
    };
  }

  return toolCall;
}

function parseResponseChoice(value: unknown): CopilotResponseChoice | null {
  if (!isRecord(value)) {
    return null;
  }

  const choice: CopilotResponseChoice = {};

  if (isRecord(value.message)) {
    const content = value.message.content;
    if (content === null || isString(content)) {
      choice.message = { content };
    }
  }

  if (isRecord(value.delta)) {
    const delta: CopilotResponseChoice['delta'] = {};
    const content = value.delta.content;
    if (content === null || isString(content)) {
      delta.content = content;
    }

    if (Array.isArray(value.delta.tool_calls)) {
      delta.tool_calls = value.delta.tool_calls
        .map(parseToolCallDelta)
        .filter((toolCall): toolCall is CopilotToolCallDelta => toolCall !== null);
    }

    choice.delta = delta;
  }

  const finishReason = value.finish_reason;
  if (finishReason === null || isString(finishReason)) {
    choice.finish_reason = finishReason;
  }

  return choice;
}

function getFirstResponseChoice(value: unknown): CopilotResponseChoice | undefined {
  if (!isRecord(value) || !Array.isArray(value.choices) || value.choices.length === 0) {
    return undefined;
  }

  return parseResponseChoice(value.choices[0]) ?? undefined;
}

function getResponseModel(value: unknown): string {
  if (!isRecord(value)) {
    return '';
  }

  return getOptionalString(value.model) ?? '';
}

function getResponseUsage(value: unknown): LLMResponse['usage'] | undefined {
  if (!isRecord(value) || !isRecord(value.usage)) {
    return undefined;
  }

  return value.usage as LLMResponse['usage'];
}

export class GithubCopilotAdapter extends BaseAdapter {
  readonly name = 'github-copilot';
  readonly baseUrl = COPILOT_API_ENDPOINT;

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
    const toModelInfo = (model: CopilotModelMetadata): ModelInfo => ({
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
        // Ignore model sync failures and preserve the empty-list fallback.
      }
    }
    return [];
  }

  async syncModels(token: string): Promise<CopilotModelMetadata[]> {
    const sessionToken = await this.getSessionToken(token);
    const headers = this.getAuthHeaders(sessionToken);

    const response = await ProviderHttpClient.request({
      url: COPILOT_MODELS_ENDPOINT,
      provider: this.name,
      operation: 'syncModels',
      method: 'GET',
      headers
    });

    return parseModelsPayload(response.json);
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

    const sessionToken = getSessionTokenFromPayload(response.json);
    if (!sessionToken) {
      throw new Error('Failed to fetch Copilot session token');
    }

    return sessionToken;
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

    const firstChoice = getFirstResponseChoice(response.json);
    return {
      text: firstChoice?.message?.content || '',
      model: getResponseModel(response.json),
      usage: getResponseUsage(response.json)
    };
  }

  async *generateStreamAsync(prompt: string, options?: GenerateOptions): AsyncGenerator<StreamChunk, void, unknown> {
    if (!this.apiKey) throw new Error('GitHub Copilot requires authentication.');

    const sessionToken = await this.getSessionToken(this.apiKey);
    const headers = this.getAuthHeaders(sessionToken);
    const messages = this.buildRequestMessages(prompt, options);
    const tools = options?.tools ? this.convertTools(options.tools) : undefined;

    const payload = {
      model: options?.model || this.currentModel,
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

    const stream = await this.requestStream({
      url: this.baseUrl,
      operation: 'generateStreamAsync',
      method: 'POST',
      headers,
      body: JSON.stringify(payload)
    });

    yield* this.processNodeStream(stream, {
      extractContent: (parsed) => getFirstResponseChoice(parsed)?.delta?.content ?? null,
      extractToolCalls: (parsed) => getFirstResponseChoice(parsed)?.delta?.tool_calls ?? null,
      extractFinishReason: (parsed) => getFirstResponseChoice(parsed)?.finish_reason ?? null,
      accumulateToolCalls: true,
      toolCallThrottling: {
        initialYield: true,
        progressInterval: 50
      }
    });
  }

  private buildRequestMessages(prompt: string, options?: GenerateOptions): unknown[] {
    if (Array.isArray(options?.conversationHistory) && options.conversationHistory.length > 0) {
      return options.conversationHistory;
    }

    return this.buildMessages(prompt, options?.systemPrompt);
  }

  private convertTools(tools: Tool[]): Array<Record<string, unknown>> {
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
