import { BaseAdapter } from '../BaseAdapter';
import { GenerateOptions, StreamChunk, LLMResponse, ModelInfo, ProviderCapabilities, ModelPricing } from '../types';
import { GITHUB_COPILOT_MODELS, GITHUB_COPILOT_DEFAULT_MODEL } from './GithubCopilotModels';
import { ProviderHttpClient } from '../shared/ProviderHttpClient';
import { BufferedSSEStreamProcessor } from '../../streaming/BufferedSSEStreamProcessor';
import { LLMProviderConfig } from '../../../../types';

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
      id: model.apiName || model.id,
      name: model.name || model.id,
      contextWindow: model.contextWindow || 200000,
      maxOutputTokens: model.maxTokens || 64000,
      supportsJSON: model.capabilities ? model.capabilities.supportsJSON : true,
      supportsImages: model.capabilities ? model.capabilities.supportsImages : true,
      supportsFunctions: model.capabilities ? model.capabilities.supportsFunctions : true,
      supportsStreaming: model.capabilities ? model.capabilities.supportsStreaming : true,
      supportsThinking: model.capabilities ? model.capabilities.supportsThinking : false,
      pricing: { inputPerMillion: 0, outputPerMillion: 0, currency: 'USD', lastUpdated: '' }
    });

    if (this.apiKey) {
      try {
        const syncedModels = await this.syncModels(this.apiKey);
        if (syncedModels && syncedModels.length > 0) {
          const merged = GITHUB_COPILOT_MODELS.map(base => {
            const found = syncedModels.find((m: any) => m.id === base.apiName);
            return found ? { ...base, ...found } : base;
          });
          return merged.map(toModelInfo);
        }
      } catch (err) {}
    }
    return GITHUB_COPILOT_MODELS.map(toModelInfo);
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

    const sessionToken = await this.getSessionToken(this.apiKey);
    const headers = this.getAuthHeaders(sessionToken);
    
    // Fallback standard options to prevent type errors on options?.messages
    const messages = options && 'messages' in options ? (options as any).messages : [{ role: 'user', content: prompt }];

    const payload = {
      model: options?.model || this.currentModel,
      messages: messages,
      temperature: options?.temperature ?? 0.5,
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

    const messages = options && 'messages' in options ? (options as any).messages : [{ role: 'user', content: prompt }];

    const payload = {
      model: options?.model || this.currentModel,
      messages: messages,
      temperature: options?.temperature ?? 0.5,
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
      extractToolCalls: () => null,
      extractFinishReason: (parsed) => parsed.choices?.[0]?.finish_reason || null
    });
  }
}
