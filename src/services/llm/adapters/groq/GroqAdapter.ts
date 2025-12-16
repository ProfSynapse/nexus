/**
 * Groq Adapter with true streaming support and Ultra-Fast Inference
 * Leverages Groq's high-performance LLM serving infrastructure
 * Uses OpenAI-compatible streaming API with extended usage metrics
 * Based on official Groq SDK streaming documentation
 */

import Groq from 'groq-sdk';
import { BaseAdapter } from '../BaseAdapter';
import { 
  GenerateOptions, 
  StreamChunk, 
  LLMResponse, 
  ModelInfo, 
  ProviderCapabilities,
  ModelPricing
} from '../types';
import { GROQ_MODELS, GROQ_DEFAULT_MODEL } from './GroqModels';
import { MCPToolExecution } from '../shared/ToolExecutionUtils';

export class GroqAdapter extends BaseAdapter {
  readonly name = 'groq';
  readonly baseUrl = 'https://api.groq.com/openai/v1';

  private client: Groq;

  constructor(apiKey: string, model?: string) {
    super(apiKey, model || GROQ_DEFAULT_MODEL);

    this.client = new Groq({
      apiKey: this.apiKey,
      dangerouslyAllowBrowser: true
    });
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
      console.log('[GroqAdapter] Starting streaming response');

      const stream = await this.client.chat.completions.create({
        model: options?.model || this.currentModel,
        messages: this.buildMessages(prompt, options?.systemPrompt),
        temperature: options?.temperature,
        max_completion_tokens: options?.maxTokens,
        top_p: options?.topP,
        stop: options?.stopSequences,
        tools: options?.tools ? this.convertTools(options.tools) : undefined,
        response_format: options?.jsonMode ? { type: 'json_object' } : undefined,
        stream: true
      });

      // Use unified stream processing with automatic tool call accumulation
      yield* this.processStream(stream, {
        debugLabel: 'Groq',
        extractContent: (chunk) => chunk.choices[0]?.delta?.content || null,
        extractToolCalls: (chunk) => chunk.choices[0]?.delta?.tool_calls || null,
        extractFinishReason: (chunk) => chunk.choices[0]?.finish_reason || null,
        extractUsage: (chunk) => {
          // Groq has both standard usage and x_groq metadata
          if ((chunk as any).usage || (chunk as any).x_groq) {
            return {
              usage: (chunk as any).usage,
              x_groq: (chunk as any).x_groq
            };
          }
          return null;
        }
      });

      console.log('[GroqAdapter] Streaming completed');
    } catch (error) {
      console.error('[GroqAdapter] Streaming error:', error);
      throw error;
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    try {
      return GROQ_MODELS.map(model => ({
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
      supportsJSON: true,
      supportsImages: true,
      supportsFunctions: true,
      supportsThinking: false,
      maxContextWindow: 128000,
      supportedFeatures: [
        'messages',
        'function_calling',
        'vision',
        'streaming',
        'json_mode',
        'ultra_fast_inference',
        'extended_metrics'
      ]
    };

    return baseCapabilities;
  }

  /**
   * Generate using standard chat completions
   */
  private async generateWithChatCompletions(prompt: string, options?: GenerateOptions): Promise<LLMResponse> {
    const model = options?.model || this.currentModel;
    
    const chatParams: any = {
      model,
      messages: this.buildMessages(prompt, options?.systemPrompt),
      temperature: options?.temperature,
      max_completion_tokens: options?.maxTokens,
      top_p: options?.topP,
      stop: options?.stopSequences,
      response_format: options?.jsonMode ? { type: 'json_object' } : undefined
    };

    // Add tools if provided
    if (options?.tools) {
      chatParams.tools = this.convertTools(options.tools);
    }

    const response = await this.client.chat.completions.create(chatParams);
    const choice = response.choices[0];
    
    if (!choice) {
      throw new Error('No response from Groq');
    }
    
    let text = choice.message?.content || '';
    const usage = this.extractUsage(response);
    let finishReason = choice.finish_reason || 'stop';

    // If tools were provided and we got tool calls, we need to handle them
    // For now, just return the response as-is since tool execution is complex
    if (options?.tools && choice.message?.tool_calls && choice.message.tool_calls.length > 0) {
      console.log(`[Groq Adapter] Received ${choice.message.tool_calls.length} tool calls, but tool execution not implemented in basic mode`);
      text = text || '[AI requested tool calls but tool execution not available]';
    }

    return this.buildLLMResponse(
      text,
      model,
      usage,
      undefined,
      finishReason as any
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

  private mapFinishReason(reason: string | null): 'stop' | 'length' | 'tool_calls' | 'content_filter' {
    if (!reason) return 'stop';
    
    const reasonMap: Record<string, 'stop' | 'length' | 'tool_calls' | 'content_filter'> = {
      'stop': 'stop',
      'length': 'length',
      'tool_calls': 'tool_calls',
      'content_filter': 'content_filter'
    };
    return reasonMap[reason] || 'stop';
  }

  protected extractUsage(response: any): any {
    const usage = response?.usage;
    if (usage) {
      return {
        promptTokens: usage.prompt_tokens || 0,
        completionTokens: usage.completion_tokens || 0,
        totalTokens: usage.total_tokens || 0,
        // Groq-specific extended metrics
        queueTime: response?.x_groq?.queue_time,
        promptTime: response?.x_groq?.prompt_time,
        completionTime: response?.x_groq?.completion_time
      };
    }
    return undefined;
  }

  private getCostPer1kTokens(modelId: string): { input: number; output: number } | undefined {
    const model = GROQ_MODELS.find(m => m.apiName === modelId);
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