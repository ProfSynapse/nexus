/**
 * LM Studio Adapter
 * Provides local LLM models via LM Studio's OpenAI-compatible API
 * Supports model auto-discovery, streaming, and function calling
 *
 * Uses the standard /v1/chat/completions API for reliable conversation handling.
 * Supports multiple tool calling formats (native tool_calls, [TOOL_CALLS], XML, etc.)
 * via ToolCallContentParser.
 */

import { Notice } from 'obsidian';
import { BaseAdapter } from '../BaseAdapter';
import {
  GenerateOptions,
  StreamChunk,
  LLMResponse,
  ModelInfo,
  ProviderCapabilities,
  ModelPricing,
  TokenUsage,
  LLMProviderError,
  ToolCall
} from '../types';
import { ToolCallContentParser } from './ToolCallContentParser';
import { usesCustomToolFormat } from '../../../chat/builders/ContextBuilderFactory';
import { isThinkingModelName } from '../shared/thinkingModels';

/** OpenAI-compatible chat completion response shape from LM Studio */
interface ChatCompletionResponse {
  id?: string;
  model?: string;
  choices?: Array<{
    message?: {
      content?: string;
      // LM Studio surfaces reasoning-model thinking in a dedicated field (same shape
      // as DeepSeek) rather than inline <think> tags — we route it to StreamChunk.reasoning.
      reasoning_content?: string;
      tool_calls?: unknown[];
    };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

/** OpenAI-compatible model list response shape from LM Studio */
interface ModelListResponse {
  data?: Array<{
    id: string;
    context_length?: number;
    max_tokens?: number;
  }>;
}

interface ChatMessage {
  role: string;
  content: string;
  tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
  tool_call_id?: string;
}

interface ResponsesInputItem {
  role?: string;
  content?: string;
  type?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  output?: string;
}

type LMStudioStreamChunk = ChatCompletionResponse & {
  choices?: Array<{
    delta?: {
      content?: string;
      // Incremental reasoning tokens for thinking models (streamed before content).
      reasoning_content?: string;
      tool_calls?: Array<{ id?: string; type?: string; function?: { name?: string; arguments?: string } }>;
    };
    finish_reason?: string;
  }>;
  usage?: ChatCompletionResponse['usage'];
};

/** Optional load-time + per-request tuning applied automatically before chat. */
export interface LMStudioLoadConfig {
  contextLength?: number;
  flashAttention?: boolean;
  draftModel?: string;
}

export class LMStudioAdapter extends BaseAdapter {
  readonly name = 'lmstudio';
  readonly baseUrl: string;

  private serverUrl: string;
  private loadConfig?: LMStudioLoadConfig;
  /**
   * (target::draft) pairs LM Studio rejected as incompatible (different tokenizer).
   * Speculative decoding requires the draft and target to share a vocabulary; once a
   * pair fails we stop attaching draft_model for that target so chat never re-breaks.
   */
  private incompatibleDrafts = new Set<string>();

  constructor(serverUrl: string, loadConfig?: LMStudioLoadConfig) {
    // LM Studio doesn't need an API key - set requiresApiKey to false
    super('', '', serverUrl, false);

    this.serverUrl = serverUrl;
    this.baseUrl = serverUrl;
    this.loadConfig = loadConfig;

    this.initializeCache();
  }

  /**
   * Ensure the target model is loaded at the user-configured context length before chatting.
   * Uses LM Studio's native REST API (verified against lmstudio.ai/docs/developer/rest):
   * GET /api/v1/models reads the live loaded state, POST /api/v1/models/load (re)loads. A
   * cheap GET runs every call, but the expensive RELOAD only fires when the model isn't
   * already loaded at the desired context — so a settings save (which rebuilds this adapter)
   * no longer reloads an already-correct model on every chat. The live GET is self-sufficient
   * across rebuilds; no cross-instance state needed.
   *
   * Load-body params (verified against a live server, not just the public REST docs):
   *  - context_length — honored by both engines; the one that actually matters.
   *  - flash_attention — documented to affect ONLY the llama.cpp engine; on MLX it's a no-op
   *    and the loaded instance never reports it back, so we pass it through (harmless on gguf)
   *    but NEVER compare it — gating on it would force an infinite reload loop on MLX.
   *  - parallel: 1 — omitted from the public docs but the server DOES honor it (echo_load_config
   *    confirms parallel:1). Speculative decoding on MLX requires a NON-batched (parallel:1)
   *    instance, so a configured draft forces it. (If the chat still routes to a pre-existing
   *    batched instance, generateStream's in-stream error fallback drops the draft and recovers.)
   *
   * We scan ALL loaded instances (LM Studio can hold several) and skip the load only when a
   * suitable one already exists, so we neither reload every turn nor pile up duplicate
   * instances. Best-effort: any failure falls back to JIT loading so chat is never blocked.
   */
  private async ensureModelLoaded(model: string): Promise<void> {
    const cfg = this.loadConfig;
    // Only a configured context length warrants a pre-load. Flash is best-effort and the
    // draft attaches per chat request, so neither alone forces a load.
    if (!cfg || cfg.contextLength === undefined || !model) return;
    const needsNonBatched = !!cfg.draftModel; // speculative decoding requires parallel:1 on MLX

    try {
      const listRes = await this.request({
        url: `${this.serverUrl}/api/v1/models`,
        operation: 'list models',
        method: 'GET',
        timeoutMs: 10_000
      });
      if (listRes.status !== 200) return; // native API unavailable — leave JIT default

      const data = listRes.json as {
        models?: Array<{ key?: string; loaded_instances?: Array<{ config?: { context_length?: number; parallel?: number } }> }>;
      } | null;
      const entry = data?.models?.find(m => m.key === model);
      if (!entry) return; // unknown model key — don't fight it

      // A suitable instance already loaded? Then skip — no reload, no duplicate. Match on
      // context_length (flash deliberately ignored: MLX no-op) and, when a draft is configured,
      // require a non-batched (parallel:1) instance so speculative decoding can attach.
      const suitable = (entry.loaded_instances ?? []).some(inst => {
        const c = inst.config;
        if (!c || c.context_length !== cfg.contextLength) return false;
        return !needsNonBatched || c.parallel === 1;
      });
      if (suitable) return;

      const body: Record<string, unknown> = { model, context_length: cfg.contextLength };
      if (cfg.flashAttention !== undefined) body.flash_attention = cfg.flashAttention;
      if (needsNonBatched) body.parallel = 1;

      await this.request({
        url: `${this.serverUrl}/api/v1/models/load`,
        operation: 'load model',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        timeoutMs: 120_000
      });
    } catch {
      // Best-effort — proceed with whatever LM Studio has loaded
    }
  }

  /** Stable key for a (target, configured-draft) pair. */
  private draftKey(model: string): string {
    return `${model}::${this.loadConfig?.draftModel ?? ''}`;
  }

  /**
   * Whether to attach draft_model for this target. False if no draft is configured,
   * or if this exact (target, draft) pair was previously rejected as incompatible.
   */
  private shouldUseDraft(model: string): boolean {
    return !!this.loadConfig?.draftModel && !this.incompatibleDrafts.has(this.draftKey(model));
  }

  /**
   * Detect LM Studio's draft-model rejection from an error body/message. draft_model is
   * the only "draft"/"speculative" thing we send, so those keywords are a strong signal.
   */
  private isDraftModelError(text: string | undefined): boolean {
    return !!text && /draft|speculativ/i.test(text);
  }

  /**
   * Remember an incompatible (target, draft) pair so we stop attaching the draft, and
   * tell the user once why speculative decoding turned itself off for this model. The
   * reason differs: LM Studio rejects a draft either because the engine/mode doesn't
   * support it (e.g. batched MLX) or because the tokenizers don't match.
   */
  private markDraftIncompatible(model: string, errorText?: string): void {
    const key = this.draftKey(model);
    if (this.incompatibleDrafts.has(key)) return; // already handled/notified
    this.incompatibleDrafts.add(key);
    const draft = this.loadConfig?.draftModel ?? '';
    const unsupported = !!errorText && /not supported|batched|unsupported/i.test(errorText);
    const reason = unsupported
      ? `this model can't use speculative decoding on the MLX engine (vision models aren't supported, and the target must load non-batched)`
      : `the draft model "${draft}" has a different tokenizer — pick a same-family draft`;
    new Notice(`Speculative decoding turned off for "${model}": ${reason}.`, 8000);
  }

  /**
   * Generate response without caching using /v1/chat/completions
   * Uses Obsidian's requestUrl to bypass CORS
   */
  async generateUncached(prompt: string, options?: GenerateOptions): Promise<LLMResponse> {
    const model = options?.model || this.currentModel;

    await this.ensureModelLoaded(model);

    let messages: ChatMessage[];
    if (options?.conversationHistory && options.conversationHistory.length > 0) {
      messages = options.conversationHistory as unknown as ChatMessage[];
    } else {
      messages = this.buildMessages(prompt, options?.systemPrompt);
    }

    const requestBody: Record<string, unknown> = {
      model: model,
      messages: messages,
      stream: false,
      temperature: options?.temperature,
      max_tokens: options?.maxTokens,
      top_p: options?.topP,
      frequency_penalty: options?.frequencyPenalty,
      presence_penalty: options?.presencePenalty,
      stop: options?.stopSequences
    };

    const skipToolSchemas = LMStudioAdapter.usesToolCallsContentFormat(model);
    if (options?.tools && options.tools.length > 0 && !skipToolSchemas) {
      requestBody.tools = this.convertTools(options.tools);
    }

    // Speculative decoding: per-request draft model (LM Studio auto-loads it)
    const usedDraft = this.shouldUseDraft(model);
    if (usedDraft) {
      requestBody.draft_model = this.loadConfig?.draftModel;
    }

    if (options?.jsonMode) {
      requestBody.response_format = { type: 'json_object' };
    }

    Object.keys(requestBody).forEach(key => {
      if (requestBody[key] === undefined) {
        delete requestBody[key];
      }
    });

    const doRequest = () => this.request({
      url: `${this.serverUrl}/v1/chat/completions`,
      operation: 'generation',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
      timeoutMs: 60_000
    });

    let response = await doRequest();

    // Soft guardrail: if the only-difference draft_model triggered a rejection (tokenizer
    // mismatch, or an engine that doesn't support it), drop it and retry so the chat
    // degrades gracefully (one notice) instead of failing.
    if (usedDraft && response.status !== 200 && this.isDraftModelError(response.text)) {
      this.markDraftIncompatible(model, response.text);
      delete requestBody.draft_model;
      response = await doRequest();
    }

    this.assertOk(response, `LM Studio API error: ${response.status} - ${response.text || 'Unknown error'}`);

    const data = response.json as ChatCompletionResponse | null;
    if (!data) {
      throw new LLMProviderError(
        'Invalid response format from LM Studio API: missing body',
        'generation',
        'INVALID_RESPONSE'
      );
    }

    if (!data?.choices || !data.choices[0]) {
      throw new LLMProviderError(
        'Invalid response format from LM Studio API: missing choices',
        'generation',
        'INVALID_RESPONSE'
      );
    }

    const choice = data.choices[0];
    let content = choice.message?.content || '';
    let toolCalls = (choice.message?.tool_calls || []) as ToolCall[];
    // Reasoning models return their thinking in a dedicated field — surface it as metadata.reasoning.
    const reasoning = choice.message?.reasoning_content;

    if (ToolCallContentParser.hasToolCallsFormat(content)) {
      const parsed = ToolCallContentParser.parse(content);
      if (parsed.hasToolCalls) {
        if (toolCalls.length === 0) {
          toolCalls = parsed.toolCalls;
        }
        content = parsed.cleanContent;
      }
    }

    const usage: TokenUsage = {
      promptTokens: data.usage?.prompt_tokens || 0,
      completionTokens: data.usage?.completion_tokens || 0,
      totalTokens: data.usage?.total_tokens || 0
    };

    return await this.buildLLMResponse(
      content,
      model,
      usage,
      {
        cached: false,
        model: data.model,
        id: data.id,
        ...(typeof reasoning === 'string' && reasoning.length > 0 ? { reasoning } : {})
      },
      toolCalls.length > 0 ? 'tool_calls' : this.mapFinishReason(choice.finish_reason),
      toolCalls
    );
  }

  /**
   * Generate streaming response using /v1/chat/completions
   * Supports multiple tool calling formats via ToolCallContentParser
   */
  async* generateStreamAsync(prompt: string, options?: GenerateOptions): AsyncGenerator<StreamChunk, void, unknown> {
    const model = options?.model || this.currentModel;

    await this.ensureModelLoaded(model);

    // Check for pre-built conversation history (tool continuations)
    let messages: ChatMessage[];
    if (options?.conversationHistory && options.conversationHistory.length > 0) {
      messages = options.conversationHistory as unknown as ChatMessage[];
    } else {
      messages = this.buildMessages(prompt, options?.systemPrompt);
    }

    const requestBody: Record<string, unknown> = {
      model: model,
      messages: messages,
      stream: true,
      temperature: options?.temperature,
      max_tokens: options?.maxTokens,
      top_p: options?.topP,
      frequency_penalty: options?.frequencyPenalty,
      presence_penalty: options?.presencePenalty,
      stop: options?.stopSequences
    };

    // Add tools if provided
    const skipToolSchemas = LMStudioAdapter.usesToolCallsContentFormat(model);
    if (options?.tools && options.tools.length > 0 && !skipToolSchemas) {
      requestBody.tools = this.convertTools(options.tools);
    }

    // Speculative decoding: per-request draft model (LM Studio auto-loads it)
    const usedDraft = this.shouldUseDraft(model);
    if (usedDraft) {
      requestBody.draft_model = this.loadConfig?.draftModel;
    }

    // Remove undefined values
    Object.keys(requestBody).forEach(key => {
      if (requestBody[key] === undefined) {
        delete requestBody[key];
      }
    });

    // Stream once. If a draft_model rejection surfaces (HTTP or in-stream) BEFORE any real
    // output, drop the draft, notify once, and retry without speculative decoding so the chat
    // still produces output. Any non-empty chunk means we're committed to this attempt.
    let producedRealOutput = false;
    try {
      for await (const chunk of this.streamChatOnce(requestBody)) {
        if (chunk.content || chunk.reasoning || (chunk.toolCalls && chunk.toolCalls.length > 0)) {
          producedRealOutput = true;
        }
        yield chunk;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (usedDraft && !producedRealOutput && this.isDraftModelError(msg)) {
        this.markDraftIncompatible(model, msg);
        delete requestBody.draft_model;
        yield* this.streamChatOnce(requestBody);
      } else {
        throw err;
      }
    }
  }

  /**
   * Open one streaming chat completion for the given request body and yield processed chunks.
   * Throws on BOTH transport/HTTP errors and fatal in-stream error frames: LM Studio delivers
   * a rejected draft_model as an {"error": {...}} event over an HTTP 200 stream (notably MLX's
   * "Speculative decoding is not supported for batched MLX models"), which extractError turns
   * into a thrown LLMProviderError instead of a silent, empty stream. The caller retries
   * without the draft on such a failure.
   */
  private async* streamChatOnce(requestBody: Record<string, unknown>): AsyncGenerator<StreamChunk, void, unknown> {
    const nodeStream = await this.requestStream({
      url: `${this.serverUrl}/v1/chat/completions`,
      operation: 'streaming generation',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
      timeoutMs: 120_000
    });

    let accumulatedContent = '';
    let hasToolCallsFormat = false;

    for await (const chunk of this.processNodeStream(nodeStream, {
      debugLabel: 'LM Studio',
      extractContent: (parsed) => (parsed as LMStudioStreamChunk).choices?.[0]?.delta?.content || null,
      // Thinking models stream their reasoning in delta.reasoning_content (separate from
      // content). Route it to the shared reasoning channel so it renders as a thinking block.
      extractReasoning: (parsed) => {
        const reasoning = (parsed as LMStudioStreamChunk).choices?.[0]?.delta?.reasoning_content;
        return typeof reasoning === 'string' && reasoning.length > 0 ? { text: reasoning, complete: false } : null;
      },
      extractError: (parsed) => {
        const err = (parsed as { error?: unknown }).error;
        if (!err) return null;
        if (typeof err === 'string') return err;
        const message = (err as { message?: unknown }).message;
        return typeof message === 'string' ? message : 'LM Studio streaming error';
      },
      extractToolCalls: (parsed) => (parsed as LMStudioStreamChunk).choices?.[0]?.delta?.tool_calls || null,
      extractFinishReason: (parsed) => (parsed as LMStudioStreamChunk).choices?.[0]?.finish_reason || null,
      extractUsage: (parsed) => (parsed as LMStudioStreamChunk).usage,
      accumulateToolCalls: true,
      toolCallThrottling: {
        initialYield: true,
        progressInterval: 50
      }
    })) {
      if (chunk.content) {
        accumulatedContent += chunk.content;
      }

      if (!hasToolCallsFormat && ToolCallContentParser.hasToolCallsFormat(accumulatedContent)) {
        hasToolCallsFormat = true;
      }

      if (hasToolCallsFormat) {
        if (chunk.complete) {
          const parsed = ToolCallContentParser.parse(accumulatedContent);
          yield {
            content: parsed.cleanContent,
            complete: true,
            toolCalls: parsed.hasToolCalls ? parsed.toolCalls : undefined,
            toolCallsReady: parsed.hasToolCalls,
            usage: chunk.usage
          };
        }
      } else {
        yield chunk;
      }
    }
  }

  /**
   * Convert tools to Responses API format
   */
  private convertToolsForResponsesApi(tools: Array<{ function?: { name?: string; description?: string; parameters?: unknown } }>): Array<Record<string, unknown>> {
    return tools.map((tool) => {
      if (tool.function) {
        return {
          type: 'function',
          name: tool.function.name,
          description: tool.function.description,
          parameters: tool.function.parameters
        };
      }
      return tool;
    });
  }

  /**
   * Convert Chat Completions format messages to Responses API input
   *
   * Chat Completions format:
   * - { role: 'user', content: '...' }
   * - { role: 'assistant', content: '...', tool_calls: [...] }
   * - { role: 'tool', tool_call_id: '...', content: '...' }
   *
   * Responses API input:
   * - { role: 'user', content: '...' }
   * - { role: 'assistant', content: '...' } OR function_call items
   * - { type: 'function_call_output', call_id: '...', output: '...' }
   */
  private convertChatCompletionsToResponsesInput(messages: ChatMessage[], systemPrompt?: string): ResponsesInputItem[] {
    const input: ResponsesInputItem[] = [];

    // Add system prompt first if provided
    if (systemPrompt) {
      input.push({ role: 'system', content: systemPrompt });
    }

    for (const msg of messages) {
      if (msg.role === 'user') {
        input.push({ role: 'user', content: msg.content || '' });
      } else if (msg.role === 'assistant') {
        if (msg.tool_calls && msg.tool_calls.length > 0) {
          // Add text content if present
          if (msg.content && msg.content.trim()) {
            input.push({ role: 'assistant', content: msg.content });
          }
          // Convert tool_calls to function_call items
            for (const tc of msg.tool_calls) {
              input.push({
                type: 'function_call',
                call_id: tc.id,
              name: tc.function?.name || '',
              arguments: tc.function?.arguments || '{}'
            });
          }
        } else {
          // Plain assistant message
          input.push({ role: 'assistant', content: msg.content || '' });
        }
      } else if (msg.role === 'tool') {
        // Convert tool result to function_call_output
        input.push({
          type: 'function_call_output',
          call_id: msg.tool_call_id,
          output: msg.content || '{}'
        });
      } else if (msg.role === 'system') {
        // System messages (shouldn't be here but handle gracefully)
        input.push({ role: 'system', content: msg.content || '' });
      }
    }

    return input;
  }

  /**
   * List available models. Prefers LM Studio's native /api/v1/models because it
   * reports the REAL context window (the loaded instance's context_length and the
   * model's max_context_length). The OpenAI-compat /v1/models omits context_length,
   * which forced a 4096 fallback and made the chat context meter divide by 4096 —
   * e.g. a ~1.6k-token prompt showed ~39% of what was actually a 16k window.
   * Falls back to /v1/models if the native API is unavailable (older LM Studio).
   */
  async listModels(): Promise<ModelInfo[]> {
    const native = await this.listModelsNative();
    if (native) return native;
    return this.listModelsOpenAI();
  }

  /** Build a ModelInfo with shared defaults; only id + contextWindow vary by source. */
  private toModelInfo(modelId: string, contextWindow: number, maxOutputTokens: number): ModelInfo {
    return {
      id: modelId,
      name: modelId,
      contextWindow,
      maxOutputTokens,
      supportsJSON: true,
      supportsImages: this.detectVisionSupport(modelId),
      supportsFunctions: this.detectToolSupport(modelId),
      supportsStreaming: true,
      supportsThinking: LMStudioAdapter.detectThinkingSupport(modelId),
      pricing: {
        inputPerMillion: 0, // Local models are free
        outputPerMillion: 0,
        currency: 'USD',
        lastUpdated: new Date().toISOString()
      }
    };
  }

  /**
   * Native /api/v1/models — reports true context windows. Returns null (not []) on
   * any failure so the caller can fall back to the OpenAI endpoint.
   */
  private async listModelsNative(): Promise<ModelInfo[] | null> {
    try {
      const res = await this.request({
        url: `${this.serverUrl}/api/v1/models`,
        operation: 'list models',
        method: 'GET',
        timeoutMs: 15_000
      });
      if (res.status !== 200) return null;

      const data = res.json as {
        models?: Array<{
          key?: string;
          max_context_length?: number;
          loaded_instances?: Array<{ config?: { context_length?: number } }>;
        }>;
      } | null;
      if (!data?.models || !Array.isArray(data.models)) return null;

      return data.models
        .filter(m => typeof m.key === 'string' && m.key)
        .map(m => {
          // Denominator the meter measures against, in priority order:
          // 1. the loaded instance's actual context (ground truth when loaded),
          // 2. the user-configured context from the card (what we WILL load at),
          // 3. the model's max, 4. conservative default.
          const loadedCtx = m.loaded_instances?.[0]?.config?.context_length;
          const contextWindow = loadedCtx || this.loadConfig?.contextLength || m.max_context_length || 4096;
          return this.toModelInfo(m.key as string, contextWindow, 2048);
        });
    } catch {
      return null;
    }
  }

  /** OpenAI-compat /v1/models fallback (ids only — context_length usually absent). */
  private async listModelsOpenAI(): Promise<ModelInfo[]> {
    try {
      const response = await this.request({
        url: `${this.serverUrl}/v1/models`,
        operation: 'list models',
        method: 'GET',
        timeoutMs: 15_000
      });
      if (response.status !== 200) return [];

      const data = response.json as ModelListResponse | null;
      if (!data?.data || !Array.isArray(data.data)) return [];

      return data.data.map(model =>
        this.toModelInfo(model.id, model.context_length || this.loadConfig?.contextLength || 4096, model.max_tokens || 2048)
      );
    } catch {
      // Server not reachable - silently return empty (app probably not running)
      return [];
    }
  }

  getCapabilities(): ProviderCapabilities {
    return {
      supportsStreaming: true,
      streamingMode: 'streaming',
      supportsJSON: true, // Most models support JSON mode
      supportsImages: false, // Depends on specific model
      supportsFunctions: true, // Many models support function calling via OpenAI-compatible API
      supportsThinking: true, // Reasoning models stream native delta.reasoning_content
      maxContextWindow: 128000, // Varies by model, reasonable default
      supportedFeatures: ['streaming', 'function_calling', 'json_mode', 'local', 'privacy']
    };
  }

  getModelPricing(_modelId: string): Promise<ModelPricing | null> {
    // Local models are free - zero rates
    const pricing: ModelPricing = {
      rateInputPerMillion: 0,
      rateOutputPerMillion: 0,
      currency: 'USD'
    };

    return Promise.resolve(pricing);
  }

  async isAvailable(): Promise<boolean> {
    try {
      const response = await this.request({
        url: `${this.serverUrl}/v1/models`,
        operation: 'availability check',
        method: 'GET',
        timeoutMs: 10_000
      });
      return response.status === 200;
    } catch {
      return false;
    }
  }

  /**
   * Convert tools from Chat Completions format to ensure compatibility
   * Handles both flat and nested tool formats
   */
  private convertTools(tools: Array<{ name?: string; function?: { name?: string; description?: string; parameters?: unknown } }>): Array<Record<string, unknown>> {
    return tools.map((tool) => {
      // If already in flat format {type, name, description, parameters}, return as-is
      if (tool.name && !tool.function) {
        return tool;
      }

      // If in nested format {type, function: {name, description, parameters}}, flatten it
      if (tool.function) {
        return {
          type: 'function',
          function: {
            name: tool.function.name,
            description: tool.function.description,
            parameters: tool.function.parameters
          }
        };
      }

      return tool;
    });
  }

  /**
   * Detect reasoning/thinking models by name so the UI offers the thinking toggle.
   * Rendering itself doesn't depend on this — reasoning_content is routed whenever the
   * model emits it — but this drives capability display. Shared with the Ollama adapter.
   */
  static detectThinkingSupport(modelId: string): boolean {
    return isThinkingModelName(modelId);
  }

  /**
   * Detect if a model supports vision based on name patterns
   */
  private detectVisionSupport(modelId: string): boolean {
    const visionKeywords = ['vision', 'llava', 'bakllava', 'cogvlm', 'yi-vl', 'moondream'];
    const lowerModelId = modelId.toLowerCase();
    return visionKeywords.some(keyword => lowerModelId.includes(keyword));
  }

  /**
   * Detect if a model supports tool/function calling based on name patterns
   * Many newer models support function calling
   *
   * Note: Models with "nexus" or "tools" in the name likely use [TOOL_CALLS] format
   * which is automatically parsed by this adapter
   */
  private detectToolSupport(modelId: string): boolean {
    const toolSupportedKeywords = [
      'gpt', 'mistral', 'mixtral', 'hermes', 'nous', 'qwen',
      'deepseek', 'dolphin', 'functionary', 'gorilla',
      // Fine-tuned models that use [TOOL_CALLS] format
      'nexus', 'tools-sft', 'tool-calling'
    ];
    const lowerModelId = modelId.toLowerCase();
    return toolSupportedKeywords.some(keyword => lowerModelId.includes(keyword));
  }

  /**
   * Check if a model uses custom tool call format (<tool_call> or [TOOL_CALLS])
   * These are fine-tuned models that have internalized tool schemas and don't need
   * tool schemas passed via the API - they output tool calls as content.
   *
   * Delegates to centralized check in ContextBuilderFactory for consistency.
   */
  static usesToolCallsContentFormat(modelId: string): boolean {
    return usesCustomToolFormat(modelId);
  }

  /**
   * Map OpenAI finish reasons to our standard types
   */
  private mapFinishReason(reason: string | undefined): 'stop' | 'length' | 'tool_calls' | 'content_filter' {
    if (!reason) return 'stop';

    switch (reason) {
      case 'stop':
        return 'stop';
      case 'length':
      case 'max_tokens':
        return 'length';
      case 'tool_calls':
      case 'function_call':
        return 'tool_calls';
      case 'content_filter':
        return 'content_filter';
      default:
        return 'stop';
    }
  }

  protected buildMessages(prompt: string, systemPrompt?: string): ChatMessage[] {
    const messages: ChatMessage[] = [];

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

    let message = `LM Studio ${operation} failed`;
    let code = 'UNKNOWN_ERROR';

    if (error instanceof Error && error.message) {
      message += `: ${error.message}`;
    }

    const errorCode = error && typeof error === 'object' ? (error as { code?: string }).code : undefined;
    if (errorCode === 'ECONNREFUSED') {
      message = 'Cannot connect to LM Studio server. Make sure LM Studio is running and the server is started.';
      code = 'CONNECTION_REFUSED';
    } else if (errorCode === 'ENOTFOUND') {
      message = 'LM Studio server not found. Check the URL configuration.';
      code = 'SERVER_NOT_FOUND';
    }

    throw new LLMProviderError(message, this.name, code, error instanceof Error ? error : undefined);
  }
}
