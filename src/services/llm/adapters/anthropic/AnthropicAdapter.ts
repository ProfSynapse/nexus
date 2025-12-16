/**
 * Anthropic Claude Adapter with true streaming support
 * Implements Anthropic's SSE streaming protocol
 * Based on official Anthropic streaming documentation
 */

import Anthropic from '@anthropic-ai/sdk';
import { BaseAdapter } from '../BaseAdapter';
import {
  GenerateOptions,
  StreamChunk,
  LLMResponse,
  ModelInfo,
  ProviderCapabilities,
  ModelPricing
} from '../types';
import { ANTHROPIC_MODELS, ANTHROPIC_DEFAULT_MODEL } from './AnthropicModels';
import { ThinkingEffortMapper } from '../../utils/ThinkingEffortMapper';
import { MCPToolExecution } from '../shared/ToolExecutionUtils';

export class AnthropicAdapter extends BaseAdapter {
  readonly name = 'anthropic';
  readonly baseUrl = 'https://api.anthropic.com';

  private client: Anthropic;

  constructor(apiKey: string, model?: string) {
    super(apiKey, model || ANTHROPIC_DEFAULT_MODEL);

    this.client = new Anthropic({
      apiKey: this.apiKey,
      baseURL: this.baseUrl,
      dangerouslyAllowBrowser: true
    });

    this.initializeCache();
  }

  async generateUncached(prompt: string, options?: GenerateOptions): Promise<LLMResponse> {
    return this.withRetry(async () => {
      try {
        // Tool execution requires streaming - use generateStreamAsync instead
        if (options?.tools && options.tools.length > 0) {
          throw new Error('Tool execution requires streaming. Use generateStreamAsync() instead.');
        }

        // Use basic message generation
        return await this.generateWithBasicMessages(prompt, options);
      } catch (error) {
        this.handleError(error, 'generation');
      }
    });
  }

  async* generateStreamAsync(prompt: string, options?: GenerateOptions): AsyncGenerator<StreamChunk, void, unknown> {
    try {
      // Build messages - use conversation history if provided (for tool continuations)
      let messages: any[];
      if (options?.conversationHistory && options.conversationHistory.length > 0) {
        // Use provided conversation history for tool continuations
        messages = options.conversationHistory;
      } else {
        // Build simple messages for initial request
        messages = this.buildMessages(prompt, options?.systemPrompt);
      }

      const requestParams: any = {
        model: this.normalizeModelId(options?.model || this.currentModel),
        max_tokens: options?.maxTokens || 4096,
        messages: messages.filter(msg => msg.role !== 'system'),
        temperature: options?.temperature,
        stream: true
      };

      // Add system message if provided (either from messages or from options)
      const systemMessage = messages.find(msg => msg.role === 'system');
      if (systemMessage) {
        requestParams.system = systemMessage.content;
      } else if (options?.systemPrompt) {
        requestParams.system = options.systemPrompt;
      }

      // Extended thinking mode for Claude 4 models
      if (options?.enableThinking && this.supportsThinking(options?.model || this.currentModel)) {
        const effort = options?.thinkingEffort || 'medium';
        const thinkingParams = ThinkingEffortMapper.getAnthropicParams({ enabled: true, effort });
        requestParams.thinking = {
          type: 'enabled',
          budget_tokens: thinkingParams?.budget_tokens || 16000
        };
      }

      // Add tools if provided
      if (options?.tools && options.tools.length > 0) {
        requestParams.tools = this.convertTools(options.tools);
      }

      // Add web search tool if requested
      if (options?.webSearch) {
        requestParams.tools = requestParams.tools || [];
        requestParams.tools.push({
          type: 'web_search_20250305',
          name: 'web_search',
          max_uses: 5
        });
      }

      // Add beta headers if model requires them (for 1M context window)
      const modelSpec = ANTHROPIC_MODELS.find(m => m.apiName === this.normalizeModelId(options?.model || this.currentModel));
      if (modelSpec?.betaHeaders && modelSpec.betaHeaders.length > 0) {
        requestParams.betas = modelSpec.betaHeaders;
      }

      const stream = this.client.messages.stream(requestParams);

      let usage: any = undefined;
      const toolCalls: Map<number, any> = new Map();
      let thinkingBlockIndex: number | null = null;  // Track thinking block for completion

      for await (const event of stream) {
        if ('type' in event) {
          switch (event.type) {
            case 'message_start':
              usage = (event as any).message.usage;
              break;

            case 'content_block_start':
              const startEvent = event as any;
              if (startEvent.content_block?.type === 'tool_use') {
                // Initialize tool call tracking
                const index = startEvent.index;
                toolCalls.set(index, {
                  id: startEvent.content_block.id,
                  type: 'function',
                  function: {
                    name: startEvent.content_block.name,
                    arguments: ''
                  }
                });
              } else if (startEvent.content_block?.type === 'thinking') {
                // Track thinking block index for completion signaling
                thinkingBlockIndex = startEvent.index;
              }
              break;

            case 'content_block_delta':
              const delta = (event as any).delta;
              const deltaIndex = (event as any).index;

              if (delta.type === 'text_delta' && delta.text) {
                yield {
                  content: delta.text,
                  complete: false
                };
              } else if (delta.type === 'thinking_delta' && delta.thinking) {
                // Stream thinking content as reasoning (displayed in Reasoning accordion)
                yield {
                  content: '',  // Don't mix with regular content
                  reasoning: delta.thinking,
                  reasoningComplete: false,
                  complete: false
                };
              } else if (delta.type === 'input_json_delta' && delta.partial_json) {
                // Accumulate tool input JSON
                const toolCall = toolCalls.get(deltaIndex);
                if (toolCall) {
                  toolCall.function.arguments += delta.partial_json;
                }
              }
              break;
              
            case 'message_delta':
              if ((event as any).usage) {
                usage = (event as any).usage;
              }
              break;
              
            case 'message_stop':
              // Convert accumulated tool calls to array
              const finalToolCalls = toolCalls.size > 0 ? Array.from(toolCalls.values()) : undefined;

              yield {
                content: '',
                complete: true,
                usage: this.extractUsage({ usage }),
                toolCalls: finalToolCalls,
                toolCallsReady: finalToolCalls ? true : undefined
              };
              break;
              
            case 'content_block_stop':
              // Check if this is the thinking block completing
              const stopEvent = event as any;
              if (thinkingBlockIndex !== null && stopEvent.index === thinkingBlockIndex) {
                yield {
                  content: '',
                  reasoning: '',  // No new content, just signaling completion
                  reasoningComplete: true,
                  complete: false
                };
                thinkingBlockIndex = null;  // Reset for potential next thinking block
              }
              // Tool call blocks already tracked in our map
              break;

            default:
              // Handle ping, error, and other events
              if ((event as any).type === 'ping') {
                // Ignore ping events
              } else if ((event as any).type === 'error') {
                console.error('[AnthropicAdapter] Stream error:', (event as any).error);
                throw new Error(`Anthropic stream error: ${(event as any).error.message}`);
              }
              break;
          }
        }
      }
    } catch (error) {
      console.error('[AnthropicAdapter] Streaming error:', error);
      throw error;
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    try {
      return ANTHROPIC_MODELS.map(model => ({
        // For 1M context models, append :1m to make ID unique
        id: model.contextWindow >= 1000000 ? `${model.apiName}:1m` : model.apiName,
        name: model.name,
        contextWindow: model.contextWindow,
        maxOutputTokens: model.maxTokens,
        supportsJSON: model.capabilities.supportsJSON,
        supportsImages: model.capabilities.supportsImages,
        supportsFunctions: model.capabilities.supportsFunctions,
        supportsStreaming: model.capabilities.supportsStreaming,
        supportsThinking: model.capabilities.supportsThinking,
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
    return {
      supportsStreaming: true,
      supportsJSON: true,
      supportsImages: true,
      supportsFunctions: true,
      supportsThinking: true,
      maxContextWindow: 200000,
      supportedFeatures: [
        'messages',
        'extended_thinking',
        'function_calling',
        'web_search',
        'computer_use',
        'vision',
        'streaming'
      ]
    };
  }

  /**
   * Generate using basic message API without tools
   */
  private async generateWithBasicMessages(prompt: string, options?: GenerateOptions): Promise<LLMResponse> {
    const messages = this.buildMessages(prompt, options?.systemPrompt);
    
    const requestParams: any = {
      model: options?.model || this.currentModel,
      max_tokens: options?.maxTokens || 4096,
      messages: messages.filter(msg => msg.role !== 'system'),
      temperature: options?.temperature,
      stop_sequences: options?.stopSequences
    };

    // Add system message if provided
    const systemMessage = messages.find(msg => msg.role === 'system');
    if (systemMessage) {
      requestParams.system = systemMessage.content;
    }

    // Extended thinking mode for Claude 4 models
    if (options?.enableThinking && this.supportsThinking(options?.model || this.currentModel)) {
      const effort = options?.thinkingEffort || 'medium';
      const thinkingParams = ThinkingEffortMapper.getAnthropicParams({ enabled: true, effort });
      requestParams.thinking = {
        type: 'enabled',
        budget_tokens: thinkingParams?.budget_tokens || 16000
      };
    }

    // Add tools if provided
    if (options?.tools && options.tools.length > 0) {
      requestParams.tools = this.convertTools(options.tools);
    }

    // Special tools
    if (options?.webSearch) {
      requestParams.tools = requestParams.tools || [];
      requestParams.tools.push({
        type: 'web_search_20250305',
        name: 'web_search',
        max_uses: 5
      });
    }

    // Add beta headers if model requires them (for 1M context window)
    const modelSpec = ANTHROPIC_MODELS.find(m => m.apiName === this.normalizeModelId(options?.model || this.currentModel));
    if (modelSpec?.betaHeaders && modelSpec.betaHeaders.length > 0) {
      requestParams.betas = modelSpec.betaHeaders;
    }

    const response = await this.client.messages.create(requestParams);
    
    const extractedUsage = this.extractUsage(response);
    const finishReason = this.mapStopReason(response.stop_reason);
    const toolCalls = this.extractToolCalls(response.content);
    const metadata = {
      thinking: this.extractThinking(response),
      stopSequence: response.stop_sequence
    };

    return await this.buildLLMResponse(
      this.extractTextFromContent(response.content),
      response.model,
      extractedUsage,
      metadata,
      finishReason,
      toolCalls
    );
  }

  // Private methods

  /**
   * Normalize model ID by removing :1m suffix to match against apiName
   * The :1m suffix is used to distinguish the 1M context variant in the UI,
   * but both variants use the same API name with different beta headers
   */
  private normalizeModelId(modelId: string): string {
    return modelId.replace(':1m', '');
  }

  private supportsThinking(modelId: string): boolean {
    const model = ANTHROPIC_MODELS.find(m => m.apiName === this.normalizeModelId(modelId));
    return model?.capabilities.supportsThinking || false;
  }

  private convertTools(tools: any[]): any[] {
    return tools.map(tool => {
      if (tool.type === 'function') {
        // Handle both nested (Chat Completions) and flat (Responses API) formats
        const toolDef = tool.function || tool;
        return {
          name: toolDef.name,
          description: toolDef.description,
          input_schema: toolDef.parameters || toolDef.input_schema
        };
      }
      return tool;
    });
  }

  private extractTextFromContent(content: any[]): string {
    return content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('');
  }

  private extractToolCalls(content: any[]): any[] {
    return content
      .filter(block => block.type === 'tool_use')
      .map(block => ({
        id: block.id,
        type: 'function',
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input)
        }
      }));
  }

  private extractThinking(response: any): string | undefined {
    // Extract thinking process from response if available
    const thinkingBlocks = response.content?.filter((block: any) => block.type === 'thinking') || [];
    if (thinkingBlocks.length > 0) {
      return thinkingBlocks.map((block: any) => block.thinking).join('\n');
    }
    return undefined;
  }

  private mapStopReason(reason: string | null): 'stop' | 'length' | 'tool_calls' | 'content_filter' {
    if (!reason) return 'stop';
    
    const reasonMap: Record<string, 'stop' | 'length' | 'tool_calls' | 'content_filter'> = {
      'end_turn': 'stop',
      'max_tokens': 'length',
      'tool_use': 'tool_calls',
      'stop_sequence': 'stop'
    };
    return reasonMap[reason] || 'stop';
  }

  protected extractUsage(response: any): any {
    if (response.usage) {
      return {
        promptTokens: response.usage.input_tokens || 0,
        completionTokens: response.usage.output_tokens || 0,
        totalTokens: (response.usage.input_tokens || 0) + (response.usage.output_tokens || 0)
      };
    }
    return undefined;
  }

  private getCostPer1kTokens(modelId: string): { input: number; output: number } | undefined {
    const model = ANTHROPIC_MODELS.find(m => m.apiName === this.normalizeModelId(modelId));
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