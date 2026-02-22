/**
 * OpenAI Codex Adapter
 * Location: src/services/llm/adapters/openai-codex/OpenAICodexAdapter.ts
 *
 * LLM adapter that routes inference to the Codex endpoint using OAuth tokens
 * obtained via the PKCE flow against auth.openai.com. The Codex API uses a
 * custom SSE streaming format (Responses API style), not the standard Chat
 * Completions format.
 *
 * Key differences from standard OpenAI adapter:
 * - Auth: OAuth Bearer token + ChatGPT-Account-Id header (not API key)
 * - Endpoint: chatgpt.com/backend-api/codex/responses (not api.openai.com)
 * - Request body: { input: [...], stream: true, store: false } (Responses API)
 * - SSE events: delta.text / delta.content (not choices[].delta.content)
 * - Token refresh: proactive refresh when access_token nears expiry
 * - Cost: $0 (subscription-based, not per-token)
 *
 * Desktop only: uses Node.js https module to bypass browser CORS restrictions.
 *
 * Used by: AdapterRegistry (initializes this adapter when openai-codex is
 * enabled with OAuth state), StreamingOrchestrator (for streaming inference).
 */

import { BaseAdapter } from '../BaseAdapter';
import {
  GenerateOptions,
  StreamChunk,
  LLMResponse,
  ModelInfo,
  ProviderCapabilities,
  ModelPricing,
  LLMProviderError,
  ToolCall
} from '../types';
import { ModelRegistry } from '../ModelRegistry';
import { BRAND_NAME } from '../../../../constants/branding';

/** Codex API endpoint (requires ChatGPT subscription) */
const CODEX_API_ENDPOINT = 'https://chatgpt.com/backend-api/codex/responses';

/** OpenAI OAuth token endpoint for refresh */
const OAUTH_TOKEN_ENDPOINT = 'https://auth.openai.com/oauth/token';

/** OAuth client ID (same as used during PKCE flow) */
const OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';

/** Proactive refresh threshold: refresh if token expires within 5 minutes */
const TOKEN_REFRESH_THRESHOLD_MS = 5 * 60 * 1000;

/**
 * OAuth token state managed by the adapter.
 * Mirrors the fields persisted in OAuthState on LLMProviderConfig.oauth.
 */
export interface CodexOAuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  accountId: string;
}

/**
 * Callback to persist refreshed tokens back to plugin settings.
 * The adapter calls this after a successful token refresh so the
 * new tokens survive across plugin restarts.
 */
export type TokenPersistCallback = (tokens: CodexOAuthTokens) => void;

export class OpenAICodexAdapter extends BaseAdapter {
  readonly name = 'openai-codex';
  readonly baseUrl = CODEX_API_ENDPOINT;

  private tokens: CodexOAuthTokens;
  private onTokenRefresh?: TokenPersistCallback;
  private refreshInProgress: Promise<void> | null = null;

  /**
   * @param tokens - Current OAuth token state (access token, refresh token, expiry, account ID)
   * @param onTokenRefresh - Optional callback invoked after successful token refresh to persist new tokens
   */
  constructor(tokens: CodexOAuthTokens, onTokenRefresh?: TokenPersistCallback) {
    // Pass accessToken as apiKey for BaseAdapter compatibility; baseUrl is the Codex endpoint
    super(tokens.accessToken, 'gpt-5.3-codex', CODEX_API_ENDPOINT, false);
    this.tokens = { ...tokens };
    this.onTokenRefresh = onTokenRefresh;
    this.initializeCache();
  }

  /**
   * Ensure the access token is fresh before making a request.
   * Uses a deduplication lock to prevent concurrent refresh attempts.
   */
  private async ensureFreshToken(): Promise<void> {
    const timeUntilExpiry = this.tokens.expiresAt - Date.now();

    if (timeUntilExpiry > TOKEN_REFRESH_THRESHOLD_MS) {
      return; // Token is still fresh
    }

    // Deduplicate: if a refresh is already in flight, wait for it
    if (this.refreshInProgress) {
      await this.refreshInProgress;
      return;
    }

    this.refreshInProgress = this.performTokenRefresh();
    try {
      await this.refreshInProgress;
    } finally {
      this.refreshInProgress = null;
    }
  }

  /**
   * Execute the OAuth token refresh against auth.openai.com.
   * Updates internal state and invokes the persistence callback.
   */
  private async performTokenRefresh(): Promise<void> {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: OAUTH_CLIENT_ID,
      refresh_token: this.tokens.refreshToken
    });

    // Use Node.js https to bypass browser CORS restrictions
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const httpsModule = require('https') as typeof import('https');
    const bodyStr = body.toString();
    const parsedUrl = new URL(OAUTH_TOKEN_ENDPOINT);

    const { statusCode, data } = await new Promise<{ statusCode: number; data: string }>(
      (resolve, reject) => {
        let responseData = '';
        const req = httpsModule.request(
          {
            hostname: parsedUrl.hostname,
            path: parsedUrl.pathname,
            method: 'POST',
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
              'Content-Length': Buffer.byteLength(bodyStr)
            }
          },
          (res) => {
            res.on('data', (chunk: Buffer) => { responseData += chunk.toString(); });
            res.on('end', () => resolve({ statusCode: res.statusCode ?? 0, data: responseData }));
          }
        );
        req.on('error', reject);
        req.write(bodyStr);
        req.end();
      }
    );

    if (statusCode < 200 || statusCode >= 300) {
      throw new LLMProviderError(
        `Token refresh failed (HTTP ${statusCode}): ${data}`,
        this.name,
        'AUTHENTICATION_ERROR'
      );
    }

    const tokenData = JSON.parse(data);

    // Update internal token state
    this.tokens = {
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token || this.tokens.refreshToken, // Rotation: use new if provided
      expiresAt: Date.now() + (tokenData.expires_in * 1000),
      accountId: this.tokens.accountId // Account ID doesn't change on refresh
    };

    // Update the apiKey field used by BaseAdapter
    this.apiKey = this.tokens.accessToken;

    // Persist the refreshed tokens
    if (this.onTokenRefresh) {
      this.onTokenRefresh(this.tokens);
    }
  }

  /**
   * Build the request headers for the Codex API.
   */
  private buildCodexHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.tokens.accessToken}`,
      'ChatGPT-Account-Id': this.tokens.accountId,
      'originator': 'opencode',
      'User-Agent': `claudesidian-mcp/${BRAND_NAME}`
    };
  }

  /**
   * Convert the plugin's message format to the Codex input array format.
   * Codex expects: { role: string, content: string }[]
   */
  private buildCodexInput(
    prompt: string,
    systemPrompt?: string,
    conversationHistory?: Array<Record<string, unknown>>
  ): Array<Record<string, unknown>> {
    // If conversation history is provided, use it directly.
    // Items may be role-based messages ({role, content}) or Responses API
    // items ({type: "function_call"|"function_call_output", ...}).
    if (conversationHistory && conversationHistory.length > 0) {
      return conversationHistory;
    }

    // Otherwise build from prompt + optional system prompt
    const input: Array<Record<string, unknown>> = [];
    if (systemPrompt) {
      input.push({ role: 'system', content: systemPrompt });
    }
    input.push({ role: 'user', content: prompt });
    return input;
  }

  /**
   * Generate a non-streaming response.
   * Note: The Codex endpoint requires stream: true, so we collect
   * all SSE chunks and return the assembled result.
   */
  async generateUncached(prompt: string, options?: GenerateOptions): Promise<LLMResponse> {
    try {
      await this.ensureFreshToken();

      const model = options?.model || this.currentModel;
      let fullText = '';
      let collectedToolCalls: ToolCall[] = [];

      // Codex requires streaming; collect all chunks
      for await (const chunk of this.generateStreamAsync(prompt, options)) {
        if (chunk.content) {
          fullText += chunk.content;
        }
        if (chunk.toolCalls && chunk.toolCalls.length > 0) {
          collectedToolCalls = chunk.toolCalls;
        }
      }

      const hasToolCalls = collectedToolCalls.length > 0;
      return this.buildLLMResponse(
        fullText,
        model,
        { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, // Codex doesn't report usage
        {},
        hasToolCalls ? 'tool_calls' : 'stop',
        hasToolCalls ? collectedToolCalls : undefined
      );
    } catch (error) {
      throw this.handleError(error, 'generation');
    }
  }

  /**
   * Generate a streaming response from the Codex endpoint.
   * Reads SSE events and extracts text deltas from the Responses API format.
   */
  async* generateStreamAsync(
    prompt: string,
    options?: GenerateOptions
  ): AsyncGenerator<StreamChunk, void, unknown> {
    try {
      await this.ensureFreshToken();

      const model = options?.model || this.currentModel;
      const input = this.buildCodexInput(
        prompt,
        options?.systemPrompt,
        options?.conversationHistory
      );

      const requestBody: Record<string, unknown> = {
        model,
        input,
        stream: true,
        store: false
      };

      // Always include instructions — Codex API requires this field on every request
      // (including tool continuation calls which pass conversationHistory)
      requestBody.instructions = options?.systemPrompt || '';

      if (options?.temperature !== undefined) {
        requestBody.temperature = options.temperature;
      }
      if (options?.maxTokens !== undefined) {
        requestBody.max_output_tokens = options.maxTokens;
      }

      // Convert tools from Chat Completions format to Responses API flat format
      // Codex expects: { type: "function", name: "...", parameters: {...} }
      // Chat Completions sends: { type: "function", function: { name: "...", parameters: {...} } }
      if (options?.tools && options.tools.length > 0) {
        requestBody.tools = options.tools.map((tool) => {
          const fn = tool.function as Record<string, unknown> | undefined;
          if (fn) {
            const converted: Record<string, unknown> = {
              type: 'function',
              name: fn.name,
              parameters: fn.parameters || {}
            };
            // Only include optional fields if they have values
            // (null/undefined fields can cause API errors)
            if (fn.description) converted.description = fn.description;
            if (fn.strict !== undefined && fn.strict !== null) converted.strict = fn.strict;
            return converted;
          }
          // Already in Responses API format
          return tool;
        });

        // Tell the API to allow tool calls (default may be "none" for some models)
        requestBody.tool_choice = 'auto';

        // Prepend Codex-specific tool instruction to ensure the model uses tools
        // rather than responding with plain text describing what it would do
        const toolPreamble = 'You are an AI assistant with tool access. '
          + 'Fulfill user requests by calling tools immediately — do NOT describe what you will do. '
          + 'Call getTools first to discover available tools, then call useTools to execute them.\n\n';
        requestBody.instructions = toolPreamble + (requestBody.instructions || '');

        console.log('[Codex] tools being sent:', JSON.stringify(requestBody.tools).slice(0, 500));
      } else {
        console.log('[Codex] NO tools in options:', options?.tools);
      }

      console.log('[Codex] request body keys:', Object.keys(requestBody), 'has tools:', !!requestBody.tools, 'input items:', Array.isArray(requestBody.input) ? requestBody.input.length : 'n/a');
      console.log('[Codex] request body tools count:', Array.isArray(requestBody.tools) ? requestBody.tools.length : 0);

      // Use Node.js https to bypass browser CORS restrictions
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const httpsModule = require('https') as typeof import('https');
      const bodyStr = JSON.stringify(requestBody);
      const headers = this.buildCodexHeaders();
      const parsedUrl = new URL(CODEX_API_ENDPOINT);

      const { statusCode, nodeRes } = await new Promise<{
        statusCode: number;
        nodeRes: import('http').IncomingMessage;
      }>((resolve, reject) => {
        const req = httpsModule.request(
          {
            hostname: parsedUrl.hostname,
            path: parsedUrl.pathname,
            method: 'POST',
            headers: { ...headers, 'Content-Length': Buffer.byteLength(bodyStr) }
          },
          (res) => resolve({ statusCode: res.statusCode ?? 0, nodeRes: res })
        );
        req.on('error', reject);
        req.write(bodyStr);
        req.end();
      });

      console.log('[Codex] generateStreamAsync statusCode:', statusCode, 'instructions:', JSON.stringify(requestBody.instructions));

      // Error handling for non-2xx responses
      if (statusCode >= 400) {
        // Use event-listener pattern instead of async iteration — async iteration on
        // Node.js IncomingMessage hangs in Electron's renderer process
        const errorBody = await new Promise<string>((resolve, reject) => {
          let data = '';
          nodeRes.on('data', (c: Buffer) => { data += c.toString(); });
          nodeRes.on('end', () => resolve(data));
          nodeRes.on('error', reject);
        });

        // Detect expired/invalid token specifically
        if (statusCode === 401 || statusCode === 403) {
          throw new LLMProviderError(
            `Codex API authentication failed (HTTP ${statusCode}). Token may be expired or revoked. Please reconnect via OAuth.`,
            this.name,
            'AUTHENTICATION_ERROR'
          );
        }

        // Rate limit — throw specific code so StreamingOrchestrator can fall back
        if (statusCode === 429) {
          throw new LLMProviderError(
            `Codex rate limited (HTTP 429). ${errorBody}`,
            this.name,
            'RATE_LIMIT_ERROR'
          );
        }

        throw new LLMProviderError(
          `Codex API error (HTTP ${statusCode}): ${errorBody}`,
          this.name,
          'HTTP_ERROR'
        );
      }

      // Parse SSE stream from the Node.js IncomingMessage
      // The Codex API returns SSE with data: {json} lines containing
      // response events in the Responses API format.
      yield* this.parseNodeSSEStream(nodeRes);

    } catch (error) {
      throw this.handleError(error, 'streaming generation');
    }
  }

  /**
   * Parse a Codex SSE stream from a Node.js IncomingMessage.
   *
   * The Codex Responses API emits events like:
   *   data: {"type":"response.output_text.delta","delta":{"text":"Hello"}}
   *   data: {"type":"response.output_text.done","text":"Hello world"}
   *   data: {"type":"response.completed",...}
   *   data: [DONE]
   *
   * We extract text deltas and yield StreamChunks.
   */
  private async* parseNodeSSEStream(
    nodeRes: import('http').IncomingMessage
  ): AsyncGenerator<StreamChunk, void, unknown> {
    let buffer = '';
    const toolCallsMap = new Map<number, ToolCall>();
    let currentResponseId: string | undefined;

    // Use event-listener queue instead of async iteration — async iteration on
    // Node.js IncomingMessage hangs in Electron's renderer process
    const chunkQueue: string[] = [];
    let streamEnded = false;
    let streamError: Error | null = null;
    let chunkWaiter: (() => void) | null = null;

    const notifyWaiter = () => {
      if (chunkWaiter) {
        const resolve = chunkWaiter;
        chunkWaiter = null;
        resolve();
      }
    };

    nodeRes.on('data', (chunk: Buffer) => {
      console.log('[Codex] SSE chunk received, length:', chunk.toString().length, 'preview:', chunk.toString().slice(0, 100));
      chunkQueue.push(chunk.toString());
      notifyWaiter();
    });
    nodeRes.on('end', () => {
      console.log('[Codex] SSE stream ended');
      streamEnded = true;
      notifyWaiter();
    });
    nodeRes.on('error', (err: Error) => {
      streamError = err;
      notifyWaiter();
    });

    while (!streamEnded || chunkQueue.length > 0) {
      if (streamError) throw streamError;
      if (chunkQueue.length === 0) {
        await new Promise<void>(resolve => { chunkWaiter = resolve; });
        continue;
      }
      const rawChunk = chunkQueue.shift()!;
      buffer += rawChunk;

      // Process complete lines from the buffer
      const lines = buffer.split('\n');
      // Keep the last (potentially incomplete) line in the buffer
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();

        if (!trimmed || trimmed.startsWith(':')) {
          // Empty line or SSE comment — skip
          continue;
        }

        if (!trimmed.startsWith('data: ')) {
          continue;
        }

        const jsonStr = trimmed.slice(6).trim();

        if (jsonStr === '[DONE]') {
          const finalToolCalls = toolCallsMap.size > 0 ? Array.from(toolCallsMap.values()) : undefined;
          const metadata = currentResponseId ? { responseId: currentResponseId } : undefined;
          yield {
            content: '',
            complete: true,
            toolCalls: finalToolCalls,
            toolCallsReady: finalToolCalls ? true : undefined,
            metadata
          };
          return;
        }

        let event: Record<string, unknown>;
        try {
          event = JSON.parse(jsonStr);
        } catch {
          // Malformed JSON — skip this line
          continue;
        }

        const eventType = event.type as string | undefined;

        // Capture response ID for stateful continuations (Responses API)
        const responseObj = event.response as Record<string, unknown> | undefined;
        if (responseObj?.id && typeof responseObj.id === 'string' && !currentResponseId) {
          currentResponseId = responseObj.id;
        }

        // Accumulate completed function calls
        if (eventType === 'response.output_item.done') {
          const item = event.item as Record<string, unknown> | undefined;
          if (item && item.type === 'function_call') {
            const index = (event.output_index as number) || 0;
            toolCallsMap.set(index, {
              id: (item.call_id as string) || (item.id as string) || '',
              type: 'function',
              function: {
                name: (item.name as string) || '',
                arguments: (item.arguments as string) || '{}'
              }
            });
          }
        }

        // Arguments are streamed incrementally; we capture the complete call in output_item.done
        if (eventType === 'response.function_call_arguments.delta') {
          continue;
        }

        // Extract text delta from various event shapes
        const delta = this.extractDeltaText(event);
        if (delta) {
          yield { content: delta, complete: false };
        }

        // Detect completion event
        if (eventType === 'response.completed' || eventType === 'response.done') {
          const finalToolCalls = toolCallsMap.size > 0 ? Array.from(toolCallsMap.values()) : undefined;
          const metadata = currentResponseId ? { responseId: currentResponseId } : undefined;
          yield {
            content: '',
            complete: true,
            toolCalls: finalToolCalls,
            toolCallsReady: finalToolCalls ? true : undefined,
            metadata
          };
          return;
        }
      }
    }

    // If stream ended without explicit [DONE], emit completion
    const finalToolCalls = toolCallsMap.size > 0 ? Array.from(toolCallsMap.values()) : undefined;
    const metadata = currentResponseId ? { responseId: currentResponseId } : undefined;
    console.log('[Codex] SSE stream: emitting fallback complete');
    yield {
      content: '',
      complete: true,
      toolCalls: finalToolCalls,
      toolCallsReady: finalToolCalls ? true : undefined,
      metadata
    };
  }

  /**
   * Extract text content from a Codex SSE event.
   * The Responses API uses several event shapes for text delivery.
   */
  private extractDeltaText(event: Record<string, unknown>): string | null {
    // Shape 1a: { delta: "text" } — Codex Responses API output_text.delta
    // The delta field is the text string itself, not a nested object
    if (typeof event.delta === 'string' && event.delta) {
      return event.delta;
    }

    // Shape 1b: { delta: { text: "..." } } — alternative nested delta format
    const delta = event.delta as Record<string, unknown> | undefined;
    if (delta && typeof delta === 'object') {
      if (typeof delta.text === 'string' && delta.text) return delta.text;
      if (typeof delta.content === 'string' && delta.content) return delta.content;
    }

    // Shape 2: { text: "..." } at top level — output_text.done event
    // (Skip for done events to avoid duplicating the full text)
    const eventType = event.type as string | undefined;
    if (eventType === 'response.output_text.done') {
      return null; // Full text is a recap, not a delta
    }

    // Shape 3: { content: "..." } at top level — some event variants
    if (typeof event.content === 'string' && event.content) {
      return event.content;
    }

    return null;
  }

  /**
   * List available Codex models from the static model registry.
   */
  async listModels(): Promise<ModelInfo[]> {
    const codexModels = ModelRegistry.getProviderModels('openai-codex');
    return codexModels.map(model => ModelRegistry.toModelInfo(model));
  }

  /**
   * Get provider capabilities.
   */
  getCapabilities(): ProviderCapabilities {
    return {
      supportsStreaming: true,
      supportsJSON: true,
      supportsImages: true,
      supportsFunctions: true,
      supportsThinking: false,
      maxContextWindow: 400000,
      supportedFeatures: [
        'streaming',
        'json_mode',
        'image_input',
        'tool_calling',
        'subscription_based',
        'oauth_required'
      ]
    };
  }

  /**
   * Get model pricing — Codex models are subscription-based ($0 per token).
   */
  async getModelPricing(modelId: string): Promise<ModelPricing | null> {
    const models = ModelRegistry.getProviderModels('openai-codex');
    const model = models.find(m => m.apiName === modelId);
    if (!model) return null;

    return {
      rateInputPerMillion: 0,
      rateOutputPerMillion: 0,
      currency: 'USD'
    };
  }

  /**
   * Override isAvailable to check OAuth token validity instead of API key.
   */
  async isAvailable(): Promise<boolean> {
    return !!(
      this.tokens.accessToken &&
      this.tokens.refreshToken &&
      this.tokens.accountId
    );
  }

  /**
   * Get the current token state (for diagnostics or UI display).
   * Masks sensitive values.
   */
  getTokenStatus(): {
    hasAccessToken: boolean;
    hasRefreshToken: boolean;
    hasAccountId: boolean;
    expiresAt: number;
    isExpired: boolean;
    needsRefresh: boolean;
  } {
    const now = Date.now();
    return {
      hasAccessToken: !!this.tokens.accessToken,
      hasRefreshToken: !!this.tokens.refreshToken,
      hasAccountId: !!this.tokens.accountId,
      expiresAt: this.tokens.expiresAt,
      isExpired: now >= this.tokens.expiresAt,
      needsRefresh: (this.tokens.expiresAt - now) < TOKEN_REFRESH_THRESHOLD_MS
    };
  }

  /**
   * Update the OAuth tokens (e.g., after an external refresh or reconnect).
   */
  updateTokens(tokens: CodexOAuthTokens): void {
    this.tokens = { ...tokens };
    this.apiKey = tokens.accessToken;
  }
}
