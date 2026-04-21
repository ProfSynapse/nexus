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
 * Desktop only: uses OAuth callback server integration, but outbound requests use requestUrl.
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

/** Timeout for token refresh requests (30 seconds) */
const TOKEN_REFRESH_TIMEOUT_MS = 30_000;

/** Timeout for streaming inference requests (2 minutes) */
const STREAMING_REQUEST_TIMEOUT_MS = 120_000;

/** Two-tool architecture tool names (must match ToolManager slugs) */
const TOOL_NAMES = { discover: 'getTools', execute: 'useTools' } as const;

interface CodexResponsesEvent {
  type?: string;
  response?: {
    id?: string;
  };
  text?: string;
  delta?: string | {
    text?: string;
    content?: string;
  };
  content?: string;
  output_index?: number;
  item_id?: string;
  part?: {
    type?: string;
    text?: string;
  };
  item?: {
    type?: string;
    call_id?: string;
    id?: string;
    name?: string;
    arguments?: string;
    content?: Array<{
      type?: string;
      text?: string;
    }>;
  };
}

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
    super(tokens.accessToken, 'gpt-5.4', CODEX_API_ENDPOINT, false);
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
   *
   * NOTE: This duplicates the refresh logic in OpenAICodexOAuthProvider.refreshToken().
   * The duplication is intentional so the adapter can refresh tokens during
   * inference without depending on the OAuth UI flow implementation.
   */
  private async performTokenRefresh(): Promise<void> {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: OAUTH_CLIENT_ID,
      refresh_token: this.tokens.refreshToken
    });

    const response = await this.request<Record<string, unknown>>({
      url: OAUTH_TOKEN_ENDPOINT,
      operation: 'token refresh',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: body.toString(),
      timeoutMs: TOKEN_REFRESH_TIMEOUT_MS
    });

    if (!response.ok) {
      throw new LLMProviderError(
        `Token refresh failed (HTTP ${response.status}): ${response.text.slice(0, 200)}`,
        this.name,
        'AUTHENTICATION_ERROR'
      );
    }

    const tokenData = response.json;
    if (!tokenData) {
      throw new LLMProviderError(
        `Token refresh returned malformed response: ${response.text.slice(0, 200)}`,
        this.name,
        'AUTHENTICATION_ERROR'
      );
    }

    // Validate expires_in — default to 10 days if missing or invalid
    const rawExpiresIn = tokenData.expires_in;
    const expiresIn = (typeof rawExpiresIn === 'number' && rawExpiresIn > 0)
      ? rawExpiresIn
      : 864000;

    // Update internal token state
    this.tokens = {
      accessToken: tokenData.access_token as string,
      refreshToken: (tokenData.refresh_token as string) || this.tokens.refreshToken, // Rotation: use new if provided
      expiresAt: Date.now() + (expiresIn * 1000),
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
      this.handleError(error, 'generation');
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
          + `Call ${TOOL_NAMES.discover} first to discover available tools, then call ${TOOL_NAMES.execute} to execute them.\n\n`;
        const existingInstructions = typeof requestBody.instructions === 'string'
          ? requestBody.instructions
          : '';
        requestBody.instructions = toolPreamble + existingInstructions;

      }

      // requestStream() throws ProviderHttpError for non-2xx, caught by handleError below
      const nodeStream = await this.requestStream({
        url: CODEX_API_ENDPOINT,
        operation: 'streaming generation',
        method: 'POST',
        headers: this.buildCodexHeaders(),
        body: JSON.stringify(requestBody),
        timeoutMs: STREAMING_REQUEST_TIMEOUT_MS
      });

      yield* this.processCodexNodeStream(nodeStream);

    } catch (error) {
      this.handleError(error, 'streaming generation');
    }
  }

  /**
   * Extract text content from a Codex SSE event.
   * The Responses API uses several event shapes for text delivery.
   */
  private extractDeltaText(event: CodexResponsesEvent): string | null {
    // Shape 1a: { delta: "text" } — Codex Responses API output_text.delta
    // The delta field is the text string itself, not a nested object
    if (typeof event.delta === 'string' && event.delta) {
      return event.delta;
    }

    // Shape 1b: { delta: { text: "..." } } — alternative nested delta format
    const delta = typeof event.delta === 'object' ? event.delta : undefined;
    if (delta && typeof delta === 'object') {
      if (typeof delta.text === 'string' && delta.text) return delta.text;
      if (typeof delta.content === 'string' && delta.content) return delta.content;
    }

    // Shape 2: { text: "..." } at top level — output_text.done event
    // (Skip for done events to avoid duplicating the full text)
    const eventType = event.type;
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
   * Process Codex Responses API events from a Node.js readable stream.
   * Reads SSE events incrementally as they arrive from the wire.
   * Uses the same Responses API event format as OpenAI (not Chat Completions).
   */
  private async* processCodexNodeStream(nodeStream: NodeJS.ReadableStream): AsyncGenerator<StreamChunk, void, unknown> {
    const { createParser } = await import('eventsource-parser');

    const eventQueue: StreamChunk[] = [];
    const toolCallsMap = new Map<number, ToolCall>();
    let currentResponseId: string | null = null;
    let isCompleted = false;
    const textSeenByOutputIndex = new Set<number>();
    const finalizedTextItemIds = new Set<string>();

    const parser = createParser((sseEvent) => {
      if (sseEvent.type === 'reconnect-interval' || isCompleted) return;
      if (sseEvent.data === '[DONE]') {
        isCompleted = true;
        return;
      }

      let event: CodexResponsesEvent;
      try {
        event = JSON.parse(sseEvent.data) as CodexResponsesEvent;
      } catch {
        return;
      }

      if (event.response?.id && !currentResponseId) {
        currentResponseId = event.response.id;
      }

      switch (event.type) {
        case 'response.output_text.delta':
          // Text delta — extractDeltaText handles all shapes
          {
            const text = this.extractDeltaText(event);
            if (text) {
              if (typeof event.output_index === 'number') {
                textSeenByOutputIndex.add(event.output_index);
              }
              eventQueue.push({ content: text, complete: false });
            }
          }
          break;

        case 'response.content_part.added':
          // Some Responses streams emit assistant text by first adding an
          // output_text part to a message item, sometimes without a
          // corresponding output_text.delta event.
          if (event.part?.type === 'output_text' && event.part.text) {
            if (typeof event.output_index === 'number') {
              textSeenByOutputIndex.add(event.output_index);
            }
            eventQueue.push({ content: event.part.text, complete: false });
          }
          break;

        case 'response.output_item.done':
          // Completed item — may be a function_call
          if (event.item?.type === 'function_call') {
            toolCallsMap.set(event.output_index || 0, {
              id: event.item.call_id || event.item.id || '',
              type: 'function',
              function: {
                name: event.item.name || '',
                arguments: event.item.arguments || '{}'
              }
            });
          } else if (event.item?.type === 'message' && event.item.content) {
            // The Responses API can finalize assistant text on the completed
            // message item itself. We need to surface that text if it never
            // arrived as output_text.delta events.
            const outputIndex = typeof event.output_index === 'number' ? event.output_index : -1;
            const itemId = event.item.id;
            const shouldEmitMessageText = !textSeenByOutputIndex.has(outputIndex) &&
              !(itemId && finalizedTextItemIds.has(itemId));

            if (shouldEmitMessageText) {
              for (const contentPart of event.item.content) {
                const isTextPart = contentPart.type === 'output_text' || contentPart.type === 'text';
                if (isTextPart && contentPart.text) {
                  eventQueue.push({ content: contentPart.text, complete: false });
                }
              }
            }
          }
          break;

        case 'response.output_text.done':
          // Finalized text can also arrive as a single terminal event. Emit it
          // so callers do not miss assistant text when no deltas were streamed.
          if (event.text) {
            const outputIndex = typeof event.output_index === 'number' ? event.output_index : -1;
            const shouldEmitDoneText = !textSeenByOutputIndex.has(outputIndex) &&
              !(event.item_id && finalizedTextItemIds.has(event.item_id));

            if (!shouldEmitDoneText) {
              break;
            }

            if (outputIndex >= 0) {
              textSeenByOutputIndex.add(outputIndex);
            }
            if (event.item_id) {
              finalizedTextItemIds.add(event.item_id);
            }
            eventQueue.push({ content: event.text, complete: false });
          }
          break;

        case 'response.done':
        case 'response.completed': {
          const metadata = currentResponseId ? { responseId: currentResponseId } : undefined;
          const toolCallsArray = Array.from(toolCallsMap.values());
          eventQueue.push({
            content: '',
            complete: true,
            toolCalls: toolCallsArray.length > 0 ? toolCallsArray : undefined,
            toolCallsReady: toolCallsArray.length > 0,
            metadata
          });
          isCompleted = true;
          break;
        }

        default:
          // Other Responses API events (function_call_arguments.delta, etc.) — no action needed
          break;
      }
    });

    try {
      for await (const chunk of nodeStream as AsyncIterable<Buffer>) {
        if (isCompleted) break;
        const text = typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
        parser.feed(text);

        while (eventQueue.length > 0) {
          const evt = eventQueue.shift();
          if (!evt) {
            break;
          }
          yield evt;
          if (evt.complete) { isCompleted = true; break; }
        }
      }

      // Drain remaining events
      while (eventQueue.length > 0) {
        const evt = eventQueue.shift();
        if (!evt) {
          break;
        }
        yield evt;
      }

      if (!isCompleted) {
        yield { content: '', complete: true };
      }
    } catch (error) {
      console.error('[OpenAICodexAdapter] Error processing Codex stream:', error);
      throw error;
    }
  }

  /**
   * List available Codex models from the static model registry.
   */
  listModels(): Promise<ModelInfo[]> {
    const codexModels = ModelRegistry.getProviderModels('openai-codex');
    return Promise.resolve(codexModels.map(model => ModelRegistry.toModelInfo(model)));
  }

  /**
   * Get provider capabilities.
   */
  getCapabilities(): ProviderCapabilities {
    return {
      supportsStreaming: true,
      streamingMode: 'streaming',
      supportsJSON: true,
      supportsImages: true,
      supportsFunctions: true,
      supportsThinking: true,
      maxContextWindow: 1050000,
      supportedFeatures: [
        'streaming',
        'json_mode',
        'image_input',
        'tool_calling',
        'thinking_models',
        'subscription_based',
        'oauth_required'
      ]
    };
  }

  /**
   * Get model pricing — Codex models are subscription-based ($0 per token).
   */
  getModelPricing(modelId: string): Promise<ModelPricing | null> {
    const models = ModelRegistry.getProviderModels('openai-codex');
    const model = models.find(m => m.apiName === modelId);
    if (!model) return Promise.resolve(null);

    return Promise.resolve({
      rateInputPerMillion: 0,
      rateOutputPerMillion: 0,
      currency: 'USD'
    });
  }

  /**
   * Override isAvailable to check OAuth token validity instead of API key.
   */
  isAvailable(): Promise<boolean> {
    return Promise.resolve(!!(
      this.tokens.accessToken &&
      this.tokens.refreshToken &&
      this.tokens.accountId
    ));
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
