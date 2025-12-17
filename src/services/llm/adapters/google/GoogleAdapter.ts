/**
 * Google Gemini Adapter with true streaming support
 * Implements Google Gemini streaming protocol using generateContentStream
 * Based on official Google Gemini JavaScript SDK documentation
 *
 * MOBILE COMPATIBILITY (Dec 2025):
 * The @google/genai SDK uses gaxios which requires Node.js 'os' module.
 * SDK import is now lazy (dynamic) to avoid bundling Node.js dependencies.
 * This allows the plugin to load on mobile, but Google provider won't work there.
 */

import { BaseAdapter } from '../BaseAdapter';
import {
  GenerateOptions,
  StreamChunk,
  LLMResponse,
  ModelInfo,
  ProviderCapabilities,
  ModelPricing,
  SearchResult
} from '../types';
import { GOOGLE_MODELS, GOOGLE_DEFAULT_MODEL } from './GoogleModels';
import { WebSearchUtils } from '../../utils/WebSearchUtils';
import { ReasoningPreserver } from '../shared/ReasoningPreserver';
import { SchemaValidator } from '../../utils/SchemaValidator';
import { ThinkingEffortMapper } from '../../utils/ThinkingEffortMapper';
import { MCPToolExecution } from '../shared/ToolExecutionUtils';

// Type-only import for TypeScript (doesn't affect bundling)
import type { GoogleGenAI as GoogleGenAIType } from '@google/genai';

export class GoogleAdapter extends BaseAdapter {
  readonly name = 'google';
  readonly baseUrl = 'https://generativelanguage.googleapis.com/v1';

  private client: GoogleGenAIType | null = null;
  private clientPromise: Promise<GoogleGenAIType> | null = null;

  constructor(apiKey: string, model?: string) {
    super(apiKey, model || GOOGLE_DEFAULT_MODEL);
    this.initializeCache();
  }

  /**
   * Lazy-load the Google GenAI SDK to avoid bundling Node.js dependencies
   * This allows the plugin to load on mobile (though Google won't work there)
   */
  private async getClient(): Promise<GoogleGenAIType> {
    if (this.client) {
      return this.client;
    }

    if (!this.clientPromise) {
      this.clientPromise = (async () => {
        const { GoogleGenAI } = await import('@google/genai');
        this.client = new GoogleGenAI({ apiKey: this.apiKey });
        return this.client;
      })();
    }

    return this.clientPromise;
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
    let request: any;
    try {
      // Validate web search support
      if (options?.webSearch) {
        WebSearchUtils.validateWebSearchRequest('google', options.webSearch);
      }

      // Build contents - use conversation history if provided (for tool continuations)
      let contents: any[];
      if (options?.conversationHistory && options.conversationHistory.length > 0) {
        contents = options.conversationHistory;
      } else {
        // Ensure prompt is not empty
        if (!prompt || !prompt.trim()) {
          prompt = 'Continue the conversation';
        }
        contents = [{
          role: 'user',
          parts: [{ text: prompt }]
        }];
      }

      // Determine thinking budget based on options or tools
      const effort = options?.thinkingEffort || 'medium';
      const googleThinkingParams = ThinkingEffortMapper.getGoogleParams({ enabled: true, effort });
      const thinkingBudget = googleThinkingParams?.thinkingBudget || 8192;

      // Build config object with all generation settings
      const config: any = {
        generationConfig: {
          // Use temperature 0 when tools are provided for more deterministic function calling
          temperature: (options?.tools && options.tools.length > 0) ? 0 : (options?.temperature ?? 0.7),
          maxOutputTokens: options?.maxTokens || 4096,
          topK: 40,
          topP: 0.95,
          // Enable thinking mode when tools are present or explicitly requested
          // Gemini 2.5 Flash supports 0-24576 token thinking budget
          ...((options?.enableThinking || (options?.tools && options.tools.length > 0)) && {
            thinkingBudget
          })
        }
      };

      // Add system instruction if provided (inside config)
      if (options?.systemPrompt) {
        config.systemInstruction = {
          parts: [{ text: options.systemPrompt }]
        };
      }

      // Add web search grounding if requested (must be before other tools)
      if (options?.webSearch) {
        config.tools = config.tools || [];
        config.tools.push({ googleSearch: {} });
      }

      // Add tools if provided (inside config)
      if (options?.tools && options.tools.length > 0) {
        const convertedTools = this.convertTools(options.tools);

        // Merge with existing tools array if web search was added
        if (config.tools && config.tools.length > 0) {
          config.tools.push(...convertedTools);
        } else {
          config.tools = convertedTools;
        }

        // Validate each tool schema before sending to Google
        let validationFailures = 0;
        for (const toolWrapper of config.tools) {
          const functionDeclarations = toolWrapper.functionDeclarations;
          if (functionDeclarations) {
            for (const tool of functionDeclarations) {
              const validation = SchemaValidator.validateGoogleSchema(tool.parameters, tool.name);
              if (!validation.valid) {
                validationFailures++;
                console.error(`[Google Adapter] ⚠️ Schema validation failed for tool "${tool.name}":`);
                console.error(`[Google Adapter]    ${validation.error}`);
                console.error(`[Google Adapter]    This may cause MALFORMED_FUNCTION_CALL errors`);
              }
            }
          }
        }

        if (validationFailures > 0) {
          console.error(`[Google Adapter] ❌ ${validationFailures} tool(s) have schema validation issues`);
        }

        // Add function calling config - let model decide when to use tools
        config.toolConfig = {
          functionCallingConfig: {
            mode: 'AUTO' // Model decides when tools are appropriate
          }
        };

      }

      // Build final request with config wrapper
      const request: any = {
        model: options?.model || this.currentModel,
        contents: contents,
        config: config
      };

      let response;
      try {
        const client = await this.getClient();
        response = await client.models.generateContentStream(request);
      } catch (error: any) {
        throw error;
      }

      let usage: any = undefined;
      const toolCallAccumulator: Map<string, any> = new Map();

      for await (const chunk of response) {
        // Extract text from parts
        const parts = chunk.candidates?.[0]?.content?.parts || [];
        const finishReason = chunk.candidates?.[0]?.finishReason;

        // Handle malformed function call
        if (finishReason === 'MALFORMED_FUNCTION_CALL') {
          console.error('[Google Adapter] ❌ MALFORMED_FUNCTION_CALL detected!');
          console.error('[Google Adapter] This means one or more tool schemas violate Google\'s JSON Schema requirements');
          console.error('[Google Adapter] Common causes:');
          console.error('[Google Adapter]   1. Schema contains "default", "examples", "minLength", "maxLength", "pattern", or other unsupported properties');
          console.error('[Google Adapter]   2. Schema is too deeply nested (max depth: 10 levels)');
          console.error('[Google Adapter]   3. "required" array references properties that don\'t exist in "properties"');
          console.error('[Google Adapter]   4. Too many tools provided (Google recommends max 10-20)');
          console.error('[Google Adapter] Check schema validation warnings above for specific issues');
          console.error('[Google Adapter] Full response:', JSON.stringify(chunk, null, 2));

          // Provide helpful error message to user
          yield {
            content: '\n\n⚠️ **Google Gemini Schema Error**\n\nGoogle returned `MALFORMED_FUNCTION_CALL` - this means one or more tool schemas contain unsupported properties.\n\nCheck the console for detailed validation errors. Common issues:\n- Tool schemas contain `default` values (not supported by Google)\n- Schemas use `minLength`, `maxLength`, or `pattern` properties\n- Too many tools provided at once\n\nThe schemas have been automatically sanitized, but some tools may need schema updates.',
            complete: true
          };
          return;
        }

        for (const part of parts) {
          // Handle thinking/reasoning content (Gemini 2.0+ with thinking enabled)
          if (part.thought || part.thinking) {
            const thinkingText = part.thought || part.thinking;
            yield {
              content: '',
              complete: false,
              reasoning: thinkingText,
              reasoningComplete: false
            };
          }

          if (part.text) {
            yield {
              content: part.text,
              complete: false
            };
          }

          // Accumulate function calls with thought signature preservation (Gemini 3.0+)
          if (part.functionCall) {
            const toolId = part.functionCall.name + '_' + Date.now();
            const toolCall: any = {
              id: toolId,
              type: 'function',
              function: {
                name: part.functionCall.name,
                arguments: JSON.stringify(part.functionCall.args || {})
              }
            };

            // Preserve thought signature using centralized utility
            const thoughtSignature = ReasoningPreserver.extractThoughtSignatureFromPart(part);
            if (thoughtSignature) {
              toolCall.thought_signature = thoughtSignature;
            }

            toolCallAccumulator.set(toolId, toolCall);
          }
        }

        // Extract usage information if available
        if (chunk.usageMetadata) {
          usage = chunk.usageMetadata;
        }
      }

      // Final chunk with usage information and tool calls
      const finalToolCalls = toolCallAccumulator.size > 0
        ? Array.from(toolCallAccumulator.values())
        : undefined;

      yield {
        content: '',
        complete: true,
        usage: this.extractUsage({ usageMetadata: usage }),
        toolCalls: finalToolCalls,
        toolCallsReady: finalToolCalls && finalToolCalls.length > 0 ? true : undefined
      };
    } catch (error: any) {
      console.error('[Google Adapter] ❌❌❌ STREAMING ERROR:', error);
      console.error('[Google Adapter] Error details:', {
        name: error?.name,
        message: error?.message,
        stack: error?.stack
      });
      throw error;
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    try {
      return GOOGLE_MODELS.map(model => ({
        id: model.apiName,
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
      maxContextWindow: 2097152,
      supportedFeatures: [
        'messages',
        'function_calling',
        'vision',
        'streaming',
        'json_mode',
        'thinking_mode'
      ]
    };
  }

  /**
   * Generate using basic message API without tools
   */
  private async generateWithBasicMessages(prompt: string, options?: GenerateOptions): Promise<LLMResponse> {
    // Validate web search support
    if (options?.webSearch) {
      WebSearchUtils.validateWebSearchRequest('google', options.webSearch);
    }

    const request: any = {
      model: options?.model || this.currentModel,
      contents: [{
        role: 'user',
        parts: [{ text: prompt }]
      }],
      generationConfig: {
        temperature: options?.temperature,
        maxOutputTokens: options?.maxTokens,
        topK: 40,
        topP: 0.95
      }
    };

    // Add system instruction if provided
    if (options?.systemPrompt) {
      request.systemInstruction = {
        parts: [{ text: options.systemPrompt }]
      };
    }

    // Add web search grounding if requested
    // Google Search grounding uses special googleSearch tool, not a function
    if (options?.webSearch) {
      request.tools = [{ googleSearch: {} }];
    }

    const client = await this.getClient();
    const response = await client.models.generateContent(request);

    const extractedUsage = this.extractUsage(response);
    const finishReason = this.mapFinishReason(response.candidates?.[0]?.finishReason);
    const toolCalls = this.extractToolCalls(response);

    // Extract web search results if web search was enabled
    const webSearchResults = options?.webSearch
      ? this.extractGoogleSources(response)
      : undefined;

    const textContent = this.extractTextFromParts(response.candidates?.[0]?.content?.parts || []);

    return await this.buildLLMResponse(
      textContent,
      options?.model || this.currentModel,
      extractedUsage,
      { webSearchResults },
      finishReason,
      toolCalls
    );
  }

  // Private methods
  private convertTools(tools: any[]): any[] {
    // Gemini uses functionDeclarations wrapper (NOT OpenAI's flat array)
    return [{
      functionDeclarations: tools.map(tool => {
        if (tool.type === 'function') {
          // Handle both nested (Chat Completions) and flat (Responses API) formats
          const toolDef = tool.function || tool;
          return {
            name: toolDef.name,
            description: toolDef.description,
            parameters: this.sanitizeSchemaForGoogle(toolDef.parameters || toolDef.input_schema)
          };
        }
        return tool;
      })
    }];
  }

  /**
   * Sanitize JSON Schema for Google's simplified schema format
   * Delegates to SchemaValidator utility
   */
  private sanitizeSchemaForGoogle(schema: any): any {
    return SchemaValidator.sanitizeSchemaForGoogle(schema);
  }

  private extractToolCalls(response: any): any[] {
    // Extract from response.candidates[0].content.parts
    const parts = response.candidates?.[0]?.content?.parts || [];
    const toolCalls: any[] = [];

    for (const part of parts) {
      if (part.functionCall) {
        toolCalls.push({
          id: part.functionCall.name + '_' + Date.now(),
          type: 'function',
          function: {
            name: part.functionCall.name,
            arguments: JSON.stringify(part.functionCall.args || {})
          }
        });
      }
    }

    return toolCalls;
  }

  private extractTextFromParts(parts: any[]): string {
    return parts
      .filter(part => part.text)
      .map(part => part.text)
      .join('');
  }

  /**
   * Extract search results from Google response
   * Google may include sources in grounding chunks or tool results
   */
  private extractGoogleSources(response: any): SearchResult[] {
    try {
      const sources: SearchResult[] = [];

      // Check for grounding metadata (Google's web search citations)
      if (response.groundingMetadata?.webSearchQueries) {
        const groundingChunks = response.groundingMetadata.groundingChunks || [];
        for (const chunk of groundingChunks) {
          const result = WebSearchUtils.validateSearchResult({
            title: chunk.title || 'Unknown Source',
            url: chunk.web?.uri || chunk.uri,
            date: chunk.publishedDate
          });
          if (result) sources.push(result);
        }
      }

      // Check for function call results (if google_search tool was used)
      const functionCalls = response.functionCalls || [];
      for (const call of functionCalls) {
        if (call.name === 'google_search' && call.response) {
          try {
            const searchData = call.response;
            if (searchData.results && Array.isArray(searchData.results)) {
              const extractedSources = WebSearchUtils.extractSearchResults(searchData.results);
              sources.push(...extractedSources);
            }
          } catch (error) {
          }
        }
      }

      return sources;
    } catch (error) {
      return [];
    }
  }

  private mapFinishReason(reason: string | null): 'stop' | 'length' | 'tool_calls' | 'content_filter' {
    if (!reason) return 'stop';
    
    const reasonMap: Record<string, 'stop' | 'length' | 'tool_calls' | 'content_filter'> = {
      'STOP': 'stop',
      'MAX_TOKENS': 'length',
      'SAFETY': 'content_filter',
      'RECITATION': 'content_filter',
      'OTHER': 'stop'
    };
    return reasonMap[reason] || 'stop';
  }

  protected extractUsage(response: any): any {
    const usage = response.usageMetadata || response.usage;
    if (usage) {
      return {
        promptTokens: usage.promptTokenCount || usage.inputTokens || 0,
        completionTokens: usage.candidatesTokenCount || usage.outputTokens || 0,
        totalTokens: usage.totalTokenCount || usage.totalTokens || 0
      };
    }
    return undefined;
  }

  private getCostPer1kTokens(modelId: string): { input: number; output: number } | undefined {
    const model = GOOGLE_MODELS.find(m => m.apiName === modelId);
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