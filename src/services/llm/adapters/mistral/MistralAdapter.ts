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
  ModelPricing
} from '../types';
import { MISTRAL_MODELS, MISTRAL_DEFAULT_MODEL } from './MistralModels';
import { MCPToolExecution } from '../shared/ToolExecutionUtils';

export class MistralAdapter extends BaseAdapter {
  readonly name = 'mistral';
  readonly baseUrl = 'https://api.mistral.ai';

  constructor(apiKey: string, model?: string) {
    super(apiKey, model || MISTRAL_DEFAULT_MODEL);
    this.initializeCache();
  }

  async generateUncached(prompt: string, options?: GenerateOptions): Promise<LLMResponse> {
    try {
      const model = options?.model || this.currentModel;
      
      // Tool execution requires streaming - use generateStreamAsync instead
      if (options?.tools && options.tools.length > 0) {
        throw new Error('Tool execution requires streaming. Use generateStreamAsync() instead.');
      }

      // Use basic chat completions
      return await this.generateWithChatCompletions(prompt, options);
    } catch (error) {
      throw this.handleError(error, 'generation');
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
          messages: options?.conversationHistory && options.conversationHistory.length > 0
            ? options.conversationHistory
            : this.buildMessages(prompt, options?.systemPrompt),
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
        extractContent: (chunk) => chunk.choices?.[0]?.delta?.content || null,
        extractToolCalls: (chunk) => chunk.choices?.[0]?.delta?.tool_calls || null,
        extractFinishReason: (chunk) => chunk.choices?.[0]?.finish_reason || null,
        extractUsage: (chunk) => chunk.usage || null,
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

    // Build request body with snake_case keys matching the Mistral REST API
    const requestBody: Record<string, unknown> = {
      model,
      messages: options?.conversationHistory && options.conversationHistory.length > 0
        ? options.conversationHistory
        : this.buildMessages(prompt, options?.systemPrompt),
      temperature: options?.temperature,
      max_tokens: options?.maxTokens,
      top_p: options?.topP,
      stop: options?.stopSequences
    };

    // Add tools if provided
    if (options?.tools) {
      requestBody.tools = this.convertTools(options.tools);
    }

    const response = await this.request<any>({
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
  private convertTools(tools: any[]): any[] {
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

  private extractToolCalls(message: any): any[] {
    return message?.toolCalls || [];
  }

  private extractMessageContent(content: any): string {
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

  protected extractUsage(response: any): any {
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
