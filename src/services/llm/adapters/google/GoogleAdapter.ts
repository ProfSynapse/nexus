/**
 * Google Gemini Adapter with true streaming support
 * Implements Google Gemini REST requests with buffered SSE replay.
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
import { ProviderHttpError } from '../shared/ProviderHttpClient';

interface GoogleFunctionCall {
  name?: string;
  args?: unknown;
}

interface GoogleFunctionResponse {
  name?: string;
  response?: {
    results?: unknown[];
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

interface GoogleTextPart {
  text?: string;
  functionCall?: GoogleFunctionCall;
  functionResponse?: GoogleFunctionResponse;
  thought?: string;
  thinking?: string;
  thoughtSignature?: string;
  thought_signature?: string;
  [key: string]: unknown;
}

interface GoogleContent {
  role?: string;
  parts?: GoogleTextPart[];
  [key: string]: unknown;
}

interface GoogleCandidate {
  finishReason?: string;
  content?: {
    parts?: GoogleTextPart[];
  };
  [key: string]: unknown;
}

interface GoogleUsageMetadata {
  promptTokenCount?: number;
  inputTokens?: number;
  candidatesTokenCount?: number;
  outputTokens?: number;
  totalTokenCount?: number;
  totalTokens?: number;
  [key: string]: unknown;
}

interface GoogleGroundingChunk {
  title?: string;
  web?: {
    uri?: string;
  };
  uri?: string;
  publishedDate?: string;
  [key: string]: unknown;
}

interface GoogleResponse {
  candidates?: GoogleCandidate[];
  usageMetadata?: GoogleUsageMetadata;
  usage?: GoogleUsageMetadata;
  groundingMetadata?: {
    webSearchQueries?: unknown[];
    groundingChunks?: GoogleGroundingChunk[];
  };
  functionCalls?: GoogleFunctionResponse[];
  [key: string]: unknown;
}

interface GoogleGenerationConfig {
  temperature?: number;
  maxOutputTokens?: number;
  topK?: number;
  topP?: number;
  thinkingConfig?: {
    thinkingBudget?: number;
  };
}

interface GoogleSystemInstruction {
  parts: { text: string }[];
}

interface GoogleFunctionDeclaration {
  name: string;
  description?: string;
  parameters?: unknown;
}

interface GoogleToolWrapper {
  googleSearch?: Record<string, never>;
  functionDeclarations?: GoogleFunctionDeclaration[];
  [key: string]: unknown;
}

interface GoogleRequestConfig {
  generationConfig?: GoogleGenerationConfig;
  systemInstruction?: GoogleSystemInstruction;
  tools?: GoogleToolWrapper[];
  toolConfig?: {
    functionCallingConfig?: {
      mode?: string;
    };
  };
  [key: string]: unknown;
}

interface GoogleGenerateRequest {
  model: string;
  contents: GoogleContent[];
  config: GoogleRequestConfig;
}

interface GoogleToolInput {
  type?: string;
  function?: {
    name?: string;
    description?: string;
    parameters?: unknown;
    input_schema?: unknown;
  };
  name?: string;
  description?: string;
  parameters?: unknown;
  input_schema?: unknown;
  [key: string]: unknown;
}

interface GoogleStreamToolCall {
  index: number;
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
  thought_signature?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isGoogleResponse(value: unknown): value is GoogleResponse {
  return isRecord(value);
}

function isGoogleCandidate(value: unknown): value is GoogleCandidate {
  return isRecord(value);
}

function isGoogleTextPart(value: unknown): value is GoogleTextPart {
  return isRecord(value);
}

function isGoogleGenerationConfig(value: unknown): value is GoogleGenerationConfig {
  return isRecord(value);
}

function isGoogleUsageMetadata(value: unknown): value is GoogleUsageMetadata {
  return isRecord(value);
}

function getFirstCandidate(response: GoogleResponse): GoogleCandidate | undefined {
  const candidate = response.candidates?.[0];
  return isGoogleCandidate(candidate) ? candidate : undefined;
}

function getCandidateParts(response: GoogleResponse): GoogleTextPart[] {
  return getFirstCandidate(response)?.content?.parts ?? [];
}

export class GoogleAdapter extends BaseAdapter {
  readonly name = 'google';
  readonly baseUrl = 'https://generativelanguage.googleapis.com/v1beta';

  constructor(apiKey: string, model?: string) {
    super(apiKey, model || GOOGLE_DEFAULT_MODEL);
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
    let requestSummary: Record<string, unknown> | undefined;
    try {
      // Validate web search support
      if (options?.webSearch) {
        WebSearchUtils.validateWebSearchRequest('google', options.webSearch);
      }

      // Build contents - use conversation history if provided (for tool continuations)
      let contents: GoogleContent[];
      if (options?.conversationHistory && options.conversationHistory.length > 0) {
        contents = options.conversationHistory as GoogleContent[];
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
      const config: GoogleRequestConfig = {
        generationConfig: {
          // Use temperature 0 when tools are provided for more deterministic function calling
          temperature: (options?.tools && options.tools.length > 0) ? 0 : (options?.temperature ?? 0.7),
          maxOutputTokens: options?.maxTokens || 4096,
          topK: 40,
          topP: 0.95,
          // Enable thinking mode when tools are present or explicitly requested
          // Gemini 2.5 Flash supports 0-24576 token thinking budget
          ...((options?.enableThinking || (options?.tools && options.tools.length > 0)) && {
            thinkingConfig: { thinkingBudget }
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
      const request: GoogleGenerateRequest = {
        model: options?.model || this.currentModel,
        contents: contents,
        config: config
      };

      requestSummary = this.buildStreamingRequestSummary(request, options);

      const nodeStream = await this.requestStream({
        url: this.buildGenerateContentUrl(request.model, true),
        operation: 'streaming generation',
        method: 'POST',
        headers: this.buildGoogleHeaders(),
        body: JSON.stringify(this.buildGenerateContentBody(request)),
        timeoutMs: 120_000
      });

      yield* this.processNodeStream(nodeStream, {
        debugLabel: 'Google',
        extractContent: (chunk) => {
          const candidate = getFirstCandidate(chunk as GoogleResponse);
          if (!candidate) return null;

          // Surface error finish reasons as user-facing content before the stream ends
          const finishReason = candidate.finishReason;
          if (finishReason === 'MALFORMED_FUNCTION_CALL') {
            return '\n\n[Error: MALFORMED_FUNCTION_CALL — Google rejected a tool call due to a ' +
              'schema mismatch. The model generated arguments that don\'t match the tool\'s ' +
              'parameter schema. Common causes: required fields missing from schema, unsupported ' +
              'JSON Schema features (e.g. oneOf, $ref), or overly complex nested objects. ' +
              'Check tool definitions and simplify schemas if needed.]';
          }
          if (finishReason === 'SAFETY') {
            return '\n\n[Error: SAFETY — Google blocked this response due to safety filters. ' +
              'The content was flagged as potentially harmful. Try rephrasing your request.]';
          }
          if (finishReason === 'RECITATION') {
            return '\n\n[Error: RECITATION — Google blocked this response because it contained ' +
              'text too similar to copyrighted material.]';
          }

          return this.extractTextFromParts(candidate.content?.parts || []) || null;
        },
        extractToolCalls: (chunk) => {
          const candidate = getFirstCandidate(chunk as GoogleResponse);
          if (!candidate) return null;

          const parts = candidate.content?.parts || [];
          const toolCalls = parts
            .filter(isGoogleTextPart)
            .filter(part => Boolean(part.functionCall))
            .map((part, index): GoogleStreamToolCall => {
              const functionCall = part.functionCall;
              const toolCall: GoogleStreamToolCall = {
                index,
                id: `${functionCall?.name || 'tool'}_${index}`,
                type: 'function',
                function: {
                  name: functionCall?.name || '',
                  arguments: JSON.stringify(functionCall?.args || {})
                }
              };

              const thoughtSignature = ReasoningPreserver.extractThoughtSignatureFromPart(part);
              if (thoughtSignature) {
                toolCall.thought_signature = thoughtSignature;
              }

              return toolCall;
            });

          return toolCalls.length > 0 ? toolCalls : null;
        },
        extractFinishReason: (chunk) => {
          const finishReason = getFirstCandidate(chunk as GoogleResponse)?.finishReason;
          if (!finishReason) return null;

          // M4: Map Google finish reasons properly.
          // Error content for MALFORMED_FUNCTION_CALL, SAFETY, RECITATION is
          // surfaced in extractContent above; here we signal stream completion.
          switch (finishReason) {
            case 'STOP':
              return 'stop';
            case 'MAX_TOKENS':
              return 'length';
            case 'MALFORMED_FUNCTION_CALL':
            case 'SAFETY':
            case 'RECITATION':
            case 'OTHER':
            default:
              return 'stop';
          }
        },
        extractUsage: (chunk) => {
          const response = chunk as GoogleResponse;
          return isGoogleUsageMetadata(response.usageMetadata) ? response.usageMetadata : null;
        },
        extractReasoning: (chunk) => {
          const candidate = getFirstCandidate(chunk as GoogleResponse);
          if (!candidate) return null;

          const parts = candidate.content?.parts || [];
          const thinkingText = parts
            .map(part => part.thought || part.thinking || '')
            .filter(Boolean)
            .join('');
          if (thinkingText) {
            return { text: thinkingText, complete: false };
          }
          return null;
        },
        accumulateToolCalls: true,
        toolCallThrottling: {
          initialYield: true,
          progressInterval: 50
        }
      });
    } catch (error) {
      this.logStreamingFailure(error, requestSummary);
      console.error('[Google Adapter] ❌❌❌ STREAMING ERROR:', error);
      console.error('[Google Adapter] Error details:', {
        name: error instanceof Error ? error.name : undefined,
        message: error instanceof Error ? error.message : undefined,
        stack: error instanceof Error ? error.stack : undefined
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
      streamingMode: 'streaming',
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

    const request: GoogleGenerateRequest = {
      model: options?.model || this.currentModel,
      contents: [{
        role: 'user',
        parts: [{ text: prompt }]
      }],
      config: {
        generationConfig: {
        temperature: options?.temperature,
        maxOutputTokens: options?.maxTokens,
        topK: 40,
        topP: 0.95
        }
      }
    };

    // Add system instruction if provided
    if (options?.systemPrompt) {
      request.config.systemInstruction = {
        parts: [{ text: options.systemPrompt }]
      };
    }

    // Add web search grounding if requested
    // Google Search grounding uses special googleSearch tool, not a function
    if (options?.webSearch) {
      request.config.tools = [{ googleSearch: {} }];
    }

    const response = await this.request<GoogleResponse>({
      url: this.buildGenerateContentUrl(request.model, false),
      operation: 'generation',
      method: 'POST',
      headers: this.buildGoogleHeaders(),
      body: JSON.stringify(this.buildGenerateContentBody(request)),
      timeoutMs: 60_000
    });
    this.assertOk(response, `Google generation failed: HTTP ${response.status}`);
    const responseJson = response.json;

    const extractedUsage = this.extractUsage(responseJson);
    const finishReason = this.mapFinishReason(getFirstCandidate(responseJson)?.finishReason || null);
    const toolCalls = this.extractToolCalls(responseJson);

    // Extract web search results if web search was enabled
    const webSearchResults = options?.webSearch
      ? this.extractGoogleSources(responseJson)
      : undefined;

    const textContent = this.extractTextFromParts(responseJson.candidates?.[0]?.content?.parts || []);

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
  private convertTools(tools: GoogleToolInput[]): GoogleToolWrapper[] {
    // Gemini uses functionDeclarations wrapper (NOT OpenAI's flat array)
    return [{
      functionDeclarations: tools.map(tool => {
        if (tool.type === 'function') {
          // Handle both nested (Chat Completions) and flat (Responses API) formats
          const toolDef = tool.function || tool;
          return {
            name: toolDef.name || '',
            description: toolDef.description,
            parameters: this.sanitizeSchemaForGoogle(toolDef.parameters || toolDef.input_schema)
          };
        }
        return {
          ...tool
        };
      })
    }];
  }

  /**
   * Sanitize JSON Schema for Google's simplified schema format
   * Delegates to SchemaValidator utility
   */
  private sanitizeSchemaForGoogle(schema: unknown): unknown {
    return SchemaValidator.sanitizeSchemaForGoogle(schema);
  }

  private buildGoogleHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'x-goog-api-key': this.apiKey
    };
  }

  private buildGenerateContentUrl(model: string, stream: boolean): string {
    const encodedModel = encodeURIComponent(model);
    return stream
      ? `${this.baseUrl}/models/${encodedModel}:streamGenerateContent?alt=sse`
      : `${this.baseUrl}/models/${encodedModel}:generateContent`;
  }

  private buildGenerateContentBody(request: GoogleGenerateRequest): Record<string, unknown> {
    return {
      contents: request.contents,
      generationConfig: request.config?.generationConfig,
      systemInstruction: request.config?.systemInstruction,
      tools: request.config?.tools,
      toolConfig: request.config?.toolConfig
    };
  }

  private buildStreamingRequestSummary(
    request: GoogleGenerateRequest,
    options?: GenerateOptions
  ): Record<string, unknown> {
    const contents = request.contents;
    const contentSummary = contents.map((message, index) => {
      const parts = message.parts || [];
      const functionCallNames = parts
        .map(part => part.functionCall?.name)
        .filter((name: unknown): name is string => typeof name === 'string');
      const functionResponseNames = parts
        .map(part => part.functionResponse?.name)
        .filter((name: unknown): name is string => typeof name === 'string');

      return {
        index,
        role: message.role,
        partTypes: parts.map(part => {
          if (part.functionCall) return 'functionCall';
          if (part.functionResponse) return 'functionResponse';
          if (part.text) return 'text';
          if (part.thought || part.thinking || part.thoughtSignature) return 'thinking';
          return 'unknown';
        }),
        functionCallNames,
        functionResponseNames,
        textLength: parts
          .map(part => typeof part.text === 'string' ? part.text.length : 0)
          .reduce((sum: number, len: number) => sum + len, 0)
      };
    });

    const toolNames = Array.isArray(request.config?.tools)
      ? request.config.tools.flatMap(toolWrapper =>
          toolWrapper.functionDeclarations
            ? toolWrapper.functionDeclarations
                .map(tool => tool.name)
                .filter((name): name is string => typeof name === 'string')
            : []
        )
      : [];

    return {
      model: request.model,
      hasSystemPrompt: Boolean(options?.systemPrompt),
      systemPromptLength: options?.systemPrompt?.length || 0,
      promptLength: promptLengthFromContents(contents),
      continuation: Boolean(options?.conversationHistory && options.conversationHistory.length > 0),
      messageCount: contents.length,
      messages: contentSummary,
      toolCount: toolNames.length,
      toolNames,
      thinkingEnabled: Boolean(
        isGoogleGenerationConfig(request.config?.generationConfig) &&
        isRecord(request.config.generationConfig.thinkingConfig)
      ),
      functionCallingMode: request.config?.toolConfig?.functionCallingConfig?.mode
    };
  }

  private logStreamingFailure(error: unknown, requestSummary?: Record<string, unknown>): void {
    if (!(error instanceof ProviderHttpError)) {
      return;
    }

    console.error('[Google Adapter] Streaming request failed', {
      status: error.response.status,
      statusText: error.response.statusText,
      request: requestSummary,
      responseJson: this.sanitizeForLogging(error.response.json),
      responseText: typeof error.response.text === 'string' ? error.response.text.slice(0, 2000) : undefined
    });
  }

  private sanitizeForLogging(value: unknown): unknown {
    if (Array.isArray(value)) {
      return value.slice(0, 10).map(item => this.sanitizeForLogging(item));
    }

    if (!isRecord(value)) {
      if (typeof value === 'string') {
        return value.length > 500 ? `${value.slice(0, 500)}...` : value;
      }
      return value;
    }

    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 20)
        .map(([key, entryValue]) => [
          key,
          typeof entryValue === 'string'
            ? (entryValue.length > 500 ? `${entryValue.slice(0, 500)}...` : entryValue)
            : this.sanitizeForLogging(entryValue)
        ])
    );
  }

  private extractToolCalls(response: GoogleResponse): GoogleStreamToolCall[] {
    // Extract from response.candidates[0].content.parts
    const parts = getCandidateParts(response);
    const toolCalls: GoogleStreamToolCall[] = [];

    for (const part of parts) {
      if (part.functionCall) {
        toolCalls.push({
          id: `${part.functionCall.name || 'tool'}_${Date.now()}`,
          type: 'function',
          function: {
            name: part.functionCall.name || '',
            arguments: JSON.stringify(part.functionCall.args || {})
          }
        });
      }
    }

    return toolCalls;
  }

  private extractTextFromParts(parts: GoogleTextPart[]): string {
    return parts
      .filter(part => part.text)
      .map(part => part.text || '')
      .join('');
  }

  /**
   * Extract search results from Google response
   * Google may include sources in grounding chunks or tool results
   */
  private extractGoogleSources(response: GoogleResponse): SearchResult[] {
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
          } catch {
            // Ignore malformed function response payloads while keeping other sources.
          }
        }
      }

      return sources;
    } catch {
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
      'MALFORMED_FUNCTION_CALL': 'stop',
      'OTHER': 'stop'
    };
    return reasonMap[reason] || 'stop';
  }

  protected extractUsage(response: unknown): { promptTokens: number; completionTokens: number; totalTokens: number } | undefined {
    if (!isGoogleResponse(response)) {
      return undefined;
    }

    const usage = isGoogleUsageMetadata(response.usageMetadata) ? response.usageMetadata
      : isGoogleUsageMetadata(response.usage) ? response.usage
      : undefined;
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

function promptLengthFromContents(contents: GoogleContent[]): number {
  return contents.reduce((total, message) => {
    const parts = message.parts || [];
    const partLength = parts.reduce((sum: number, part) => {
      return sum + (typeof part.text === 'string' ? part.text.length : 0);
    }, 0);
    return total + partLength;
  }, 0);
}
