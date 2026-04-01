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
  LLMProviderError
} from '../types';

interface OllamaMessage {
  role: string;
  content: string;
  [key: string]: unknown;
}

interface OllamaOptions {
  temperature?: number;
  num_predict?: number;
  stop?: string[];
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  [key: string]: unknown;
}

interface OllamaChatResponse {
  message?: {
    content?: string;
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

export class OllamaAdapter extends BaseAdapter {
  readonly name = 'ollama';
  readonly baseUrl: string;
  
  private ollamaUrl: string;

  constructor(ollamaUrl: string, userModel: string) {
    // Ollama doesn't need an API key - set requiresApiKey to false
    // Use user-configured model instead of hardcoded default
    super('', userModel, ollamaUrl, false);

    this.ollamaUrl = ollamaUrl;
    this.baseUrl = ollamaUrl;

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

      // Build options object, removing undefined values
      const ollamaOptions: OllamaOptions = {
        temperature: options?.temperature,
        num_predict: options?.maxTokens,
        stop: options?.stopSequences,
        top_p: options?.topP,
        frequency_penalty: options?.frequencyPenalty,
        presence_penalty: options?.presencePenalty
      };
      Object.keys(ollamaOptions).forEach(key => {
        if (ollamaOptions[key] === undefined) {
          delete ollamaOptions[key];
        }
      });

      // Use /api/chat endpoint (supports messages array and tool calling)
      // requestStream() throws on HTTP errors; no assertOk needed
      const nodeStream = await this.requestStream({
        url: `${this.ollamaUrl}/api/chat`,
        operation: 'streaming generation',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: model,
          messages: messages,
          stream: true,
          options: ollamaOptions
        }),
        timeoutMs: 120_000
      });

      yield* this.processNodeStreamJsonLines(nodeStream, {
        extractChunk: (parsed) => {
          const response = parsed as OllamaChatResponse;
          if (response.message?.content) {
            return { content: response.message.content, complete: false };
          }
          return null;
        },
        extractDone: (parsed) => !!(parsed as OllamaChatResponse).done
      });
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

      // Build options object
      const ollamaOptions: OllamaOptions = {
        temperature: options?.temperature,
        num_predict: options?.maxTokens,
        stop: options?.stopSequences,
        top_p: options?.topP,
        frequency_penalty: options?.frequencyPenalty,
        presence_penalty: options?.presencePenalty
      };

      // Remove undefined values
      Object.keys(ollamaOptions).forEach(key => {
        if (ollamaOptions[key] === undefined) {
          delete ollamaOptions[key];
        }
      });

      // Use /api/chat endpoint (supports messages array and tool calling)
      const response = await this.request<OllamaChatResponse>({
        url: `${this.ollamaUrl}/api/chat`,
        operation: 'generation',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: model,
          messages: messages,
          stream: false,
          options: ollamaOptions
        }),
        timeoutMs: 60_000
      });

      this.assertOk(response, `Ollama API error: ${response.status} - ${response.text || 'Unknown error'}`);

      const data = response.json;
      if (!data) {
        throw new LLMProviderError(
          'Invalid response format from Ollama API: empty response',
          'generation',
          'INVALID_RESPONSE'
        );
      }

      // /api/chat returns message.content instead of response
      if (!data.message?.content) {
        throw new LLMProviderError(
          'Invalid response format from Ollama API: missing message.content field',
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

      const finishReason = data.done ? 'stop' : 'length';
      const metadata = {
        cached: false,
        modelDetails: data.model,
        totalDuration: data.total_duration,
        loadDuration: data.load_duration,
        promptEvalDuration: data.prompt_eval_duration,
        evalDuration: data.eval_duration
      };

      return await this.buildLLMResponse(
        data.message.content,
        model,
        usage,
        metadata,
        finishReason
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

  async listModels(): Promise<ModelInfo[]> {
    // Only return the user-configured model
    // This ensures the UI only shows the model the user specifically configured
    return [{
      id: this.currentModel,
      name: this.currentModel,
      contextWindow: 128000, // Use a reasonable default, not model-specific
      supportsStreaming: true,
      supportsJSON: false, // Ollama doesn't have built-in JSON mode
      supportsImages: this.currentModel.includes('vision') || this.currentModel.includes('llava'),
      supportsFunctions: false,
      supportsThinking: false,
      pricing: {
        inputPerMillion: 0, // Local models are free
        outputPerMillion: 0,
        currency: 'USD',
        lastUpdated: new Date().toISOString()
      }
    }];
  }

  getCapabilities(): ProviderCapabilities {
    return {
      supportsStreaming: true,
      streamingMode: 'streaming',
      supportsJSON: false, // Ollama doesn't have built-in JSON mode
      supportsImages: false, // Depends on specific model
      supportsFunctions: false, // Standard Ollama doesn't support function calling
      supportsThinking: false,
      maxContextWindow: 128000, // Varies by model, this is a reasonable default
      supportedFeatures: ['streaming', 'local', 'privacy']
    };
  }

  async getModelPricing(_modelId: string): Promise<ModelPricing | null> {
    // Local models are free - zero rates
    return {
      rateInputPerMillion: 0,
      rateOutputPerMillion: 0,
      currency: 'USD'
    };
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
