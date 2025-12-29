/**
 * Ollama LLM Adapter
 * Provides local, privacy-focused LLM models via Ollama
 * Local LLM provider for text generation
 */

import { requestUrl } from 'obsidian';
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
      let messages: any[];
      if (options?.conversationHistory && options.conversationHistory.length > 0) {
        messages = options.conversationHistory;
      } else {
        messages = this.buildMessages(prompt, options?.systemPrompt);
      }

      // Build options object, removing undefined values
      const ollamaOptions: any = {
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
      const response = await fetch(`${this.ollamaUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: model,
          messages: messages,
          stream: true,
          options: ollamaOptions
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new LLMProviderError(
          `Ollama API error: ${response.status} ${response.statusText} - ${errorText}`,
          'streaming',
          'API_ERROR'
        );
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new LLMProviderError(
          'No response body available for streaming',
          'streaming',
          'NO_RESPONSE_BODY'
        );
      }

      const decoder = new TextDecoder();
      let fullContent = '';

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const chunk = decoder.decode(value);
          const lines = chunk.split('\n').filter(line => line.trim());

          for (const line of lines) {
            try {
              const data = JSON.parse(line);

              // /api/chat returns message.content instead of response
              if (data.message?.content) {
                fullContent += data.message.content;
                yield { content: data.message.content, complete: false };
              }

              if (data.done) {
                yield {
                  content: '',
                  complete: true,
                  usage: {
                    promptTokens: data.prompt_eval_count || 0,
                    completionTokens: data.eval_count || 0,
                    totalTokens: (data.prompt_eval_count || 0) + (data.eval_count || 0)
                  }
                };
              }
            } catch (parseError) {
              // Skip invalid JSON lines
              continue;
            }
          }
        }
      } finally {
        reader.releaseLock();
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
      let messages: any[];
      if (options?.conversationHistory && options.conversationHistory.length > 0) {
        messages = options.conversationHistory;
      } else {
        messages = this.buildMessages(prompt, options?.systemPrompt);
      }

      // Build options object
      const ollamaOptions: any = {
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
      const response = await fetch(`${this.ollamaUrl}/api/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: model,
          messages: messages,
          stream: false,
          options: ollamaOptions
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new LLMProviderError(
          `Ollama API error: ${response.status} ${response.statusText} - ${errorText}`,
          'generation',
          'API_ERROR'
        );
      }

      const data = await response.json();

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

      // Check for pre-built conversation history (tool continuations)
      let messages: any[];
      if (options?.conversationHistory && options.conversationHistory.length > 0) {
        messages = options.conversationHistory;
      } else {
        messages = this.buildMessages(prompt, options?.systemPrompt);
      }

      // Build options object
      const ollamaOptions: any = {
        temperature: options?.temperature,
        num_predict: options?.maxTokens,
        stop: options?.stopSequences,
        top_p: options?.topP
      };

      // Remove undefined values
      Object.keys(ollamaOptions).forEach(key => {
        if (ollamaOptions[key] === undefined) {
          delete ollamaOptions[key];
        }
      });

      // Use /api/chat endpoint (supports messages array and tool calling)
      const response = await fetch(`${this.ollamaUrl}/api/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: model,
          messages: messages,
          stream: true,
          options: ollamaOptions
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new LLMProviderError(
          `Ollama API error: ${response.status} ${response.statusText} - ${errorText}`,
          'streaming',
          'API_ERROR'
        );
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new LLMProviderError(
          'No response body available for streaming',
          'streaming',
          'NO_RESPONSE_BODY'
        );
      }

      let fullText = '';
      let usage: TokenUsage = {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0
      };
      let finishReason: 'stop' | 'length' = 'stop';
      let metadata: Record<string, unknown> = {};

      try {
        const decoder = new TextDecoder();

        while (true) {
          const { done, value } = await reader.read();

          if (done) break;

          const chunk = decoder.decode(value);
          const lines = chunk.split('\n').filter(line => line.trim());

          for (const line of lines) {
            try {
              const data = JSON.parse(line);

              // /api/chat returns message.content instead of response
              if (data.message?.content) {
                fullText += data.message.content;
              }

              if (data.done) {
                usage = {
                  promptTokens: data.prompt_eval_count || 0,
                  completionTokens: data.eval_count || 0,
                  totalTokens: (data.prompt_eval_count || 0) + (data.eval_count || 0)
                };

                metadata = {
                  modelDetails: data.model,
                  totalDuration: data.total_duration,
                  loadDuration: data.load_duration,
                  promptEvalDuration: data.prompt_eval_duration,
                  evalDuration: data.eval_duration
                };

                finishReason = 'stop';
                break;
              }
            } catch (parseError) {
              // Skip invalid JSON lines
              continue;
            }
          }
        }
      } finally {
        reader.releaseLock();
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
        finishReason: finishReason,
        metadata: {
          ...metadata,
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
      supportsJSON: false, // Ollama doesn't have built-in JSON mode
      supportsImages: false, // Depends on specific model
      supportsFunctions: false, // Standard Ollama doesn't support function calling
      supportsThinking: false,
      maxContextWindow: 128000, // Varies by model, this is a reasonable default
      supportedFeatures: ['streaming', 'local', 'privacy']
    };
  }

  async getModelPricing(modelId: string): Promise<ModelPricing | null> {
    // Local models are free - zero rates
    return {
      rateInputPerMillion: 0,
      rateOutputPerMillion: 0,
      currency: 'USD'
    };
  }

  async isAvailable(): Promise<boolean> {
    try {
      const response = await requestUrl({
        url: `${this.ollamaUrl}/api/tags`,
        method: 'GET'
      });
      return response.status === 200;
    } catch (error) {
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

  protected buildMessages(prompt: string, systemPrompt?: string): any[] {
    const messages = [];
    
    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
    }
    
    messages.push({ role: 'user', content: prompt });
    
    return messages;
  }

  protected handleError(error: any, operation: string): never {
    if (error instanceof LLMProviderError) {
      throw error;
    }

    let message = `Ollama ${operation} failed`;
    let code = 'UNKNOWN_ERROR';

    if (error?.message) {
      message += `: ${error.message}`;
    }

    if (error?.code === 'ECONNREFUSED') {
      message = 'Cannot connect to Ollama server. Make sure Ollama is running.';
      code = 'CONNECTION_REFUSED';
    } else if (error?.code === 'ENOTFOUND') {
      message = 'Ollama server not found. Check the URL configuration.';
      code = 'SERVER_NOT_FOUND';
    }

    throw new LLMProviderError(message, this.name, code, error);
  }
}