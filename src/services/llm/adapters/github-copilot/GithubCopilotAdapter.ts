import { BaseAdapter } from '../BaseAdapter';
import { GenerateOptions, StreamChunk, LLMResponse, ModelInfo, ProviderCapabilities, ModelPricing, Tool } from '../types';
import { GITHUB_COPILOT_MODELS, GITHUB_COPILOT_DEFAULT_MODEL } from './GithubCopilotModels';
import { ProviderHttpClient } from '../shared/ProviderHttpClient';

const COPILOT_API_ENDPOINT = 'https://api.githubcopilot.com/chat/completions';
const COPILOT_MODELS_ENDPOINT = 'https://api.githubcopilot.com/models';

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

  async getModelPricing(modelId: string): Promise<ModelPricing | null> {
    return null;
  }

  async listModels(): Promise<ModelInfo[]> {
    const toModelInfo = (model: any): ModelInfo => ({
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
      } catch (err) {}
    }
    return [];
  }

  async syncModels(token: string): Promise<any[]> {
    const sessionToken = await this.getSessionToken(token);
    const headers = this.getAuthHeaders(sessionToken);

    const response = await ProviderHttpClient.request({
      url: COPILOT_MODELS_ENDPOINT,
      provider: this.name,
      operation: 'syncModels',
      method: 'GET',
      headers
    });
    return (response.json as any).data || [];
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
    
    const json = response.json as any;
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
    
    const data = response.json as any;
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
      extractContent: (parsed) => parsed.choices?.[0]?.delta?.content || null,
      extractToolCalls: (parsed) => parsed.choices?.[0]?.delta?.tool_calls || null,
      extractFinishReason: (parsed) => parsed.choices?.[0]?.finish_reason || null
      ,
      accumulateToolCalls: true,
      toolCallThrottling: {
        initialYield: true,
        progressInterval: 50
      }
    });
  }

  private buildRequestMessages(prompt: string, options?: GenerateOptions): any[] {
    if (options?.conversationHistory && options.conversationHistory.length > 0) {
      return options.conversationHistory;
    }

    return this.buildMessages(prompt, options?.systemPrompt);
  }

  private convertTools(tools: Tool[]): any[] {
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
