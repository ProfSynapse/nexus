import type { Vault } from 'obsidian';
import { getPrimaryIpcPath } from '../../../../constants/branding';
import { resolveGeminiCliRuntime } from '../../../../utils/geminiCli';
import { BaseAdapter } from '../BaseAdapter';
import { ModelRegistry } from '../ModelRegistry';
import { LLMProviderError } from '../types';
import type { GenerateOptions, LLMResponse, ModelInfo, ModelPricing, ProviderCapabilities, StreamChunk, ToolCall } from '../types';
import { ANTIGRAVITY_PROVIDER, ANTIGRAVITY_TOOLS, asAcpObject, withAntigravitySession } from './AntigravityAcpSession';
import { GOOGLE_GEMINI_CLI_DEFAULT_MODEL } from './GoogleGeminiCliModels';
import { composeAgyModelLabel } from './geminiCliModelNormalize';

function modelVariant(model: string, effort?: string | null): string {
  if (model === GOOGLE_GEMINI_CLI_DEFAULT_MODEL) {
    switch (effort) {
      case 'low':
      case 'medium':
      case 'high':
      case 'xhigh':
        return `${model}-${effort}`;
      case 'max':
        return `${model}-xhigh`;
      default:
        return `${model}-medium`;
    }
  }
  // Older saved selections may still be offered by some accounts.
  return composeAgyModelLabel(model, effort).toLowerCase().replace(/[^a-z0-9.]+/g, '-').replace(/-$/, '');
}

export class AntigravityAcpAdapter extends BaseAdapter {
  readonly name = ANTIGRAVITY_PROVIDER;
  readonly baseUrl = 'antigravity-acp://local';
  private active = new Set<AbortController>();

  constructor(private readonly vault: Vault) {
    super('gemini-cli-local-auth', GOOGLE_GEMINI_CLI_DEFAULT_MODEL, 'antigravity-acp://local', false);
  }

  async generateUncached(prompt: string, options?: GenerateOptions): Promise<LLMResponse> {
    let text = '';
    let terminal: StreamChunk | undefined;
    for await (const chunk of this.generateStreamAsync(prompt, options)) {
      text += chunk.content;
      if (chunk.complete) terminal = chunk;
    }
    return this.buildLLMResponse(text, options?.model ?? this.currentModel, terminal?.usage,
      terminal?.metadata, terminal?.finishReason, terminal?.toolCalls);
  }

  async* generateStreamAsync(prompt: string, options?: GenerateOptions): AsyncGenerator<StreamChunk> {
    const runtime = resolveGeminiCliRuntime(this.vault);
    if (!runtime.geminiPath) {
      throw new LLMProviderError('Install Antigravity CLI (agy) to use this provider.', this.name, 'CONFIGURATION_ERROR');
    }
    const enabled = options?.enableTools !== false && Boolean(options?.tools?.length);
    if (enabled && (!runtime.nodePath || !runtime.vaultPath)) {
      throw new LLMProviderError('Node.js and a desktop vault are required for Nexus MCP.', this.name, 'CONFIGURATION_ERROR');
    }
    const variant = modelVariant(options?.model ?? this.currentModel, options?.thinkingEffort);
    const controller = new AbortController();
    const abort = () => controller.abort();
    options?.abortSignal?.addEventListener('abort', abort, { once: true });
    if (options?.abortSignal?.aborted) abort();
    this.active.add(controller);

    const chunks: StreamChunk[] = [];
    const tools = new Map<string, ToolCall>();
    let wake: (() => void) | undefined;
    let done = false;
    let fault: Error | undefined;
    let textSeen = false;

    const session = withAntigravitySession({
      binary: runtime.geminiPath,
      nodePath: enabled ? runtime.nodePath ?? undefined : undefined,
      ipcPath: enabled ? getPrimaryIpcPath(this.vault.getName(), false) : undefined,
      systemPrompt: options?.systemPrompt,
      signal: controller.signal,
      onUpdate: update => {
        const { text } = asAcpObject(update.content);
        if (typeof text === 'string' && update.sessionUpdate === 'agent_message_chunk') {
          textSeen ||= text.trim().length > 0;
          chunks.push({ content: text, complete: false });
        } else if (typeof text === 'string' && update.sessionUpdate === 'agent_thought_chunk') {
          chunks.push({ content: '', reasoning: text, complete: false });
        } else if (enabled && typeof update.toolCallId === 'string') {
          const existing = tools.get(update.toolCallId);
          const name = typeof update.name === 'string' ? ANTIGRAVITY_TOOLS.get(update.name) : undefined;
          const toolName = name ?? existing?.function.name;
          if (toolName) {
            const input = { ...asAcpObject(update.rawInput ?? existing?.parameters) };
            delete input.toolSummary;
            tools.set(update.toolCallId, {
              id: update.toolCallId, type: 'function', name: toolName,
              function: { name: toolName, arguments: JSON.stringify(input) }, parameters: input,
              providerExecuted: true,
              success: update.status === 'completed' ? true : update.status === 'failed' ? false : existing?.success,
              result: update.rawOutput ?? existing?.result
            });
          }
        }
        wake?.();
      }
    }, async (rpc, opened) => {
      const sessionId = opened.sessionId;
      const models = asAcpObject(opened.models);
      const available = Array.isArray(models.availableModels) ? models.availableModels.map(asAcpObject) : [];
      if (!available.some(model => model.modelId === variant)) {
        throw new LLMProviderError(
          `The signed-in Antigravity account does not offer ${variant}. Select an available Antigravity model in Nexus.`,
          this.name, 'CONFIGURATION_ERROR'
        );
      }
      if (models.currentModelId !== variant) {
        await rpc.request('session/set_model', { sessionId, modelId: variant });
      }
      const result = await rpc.request('session/prompt', {
        sessionId, prompt: [{ type: 'text', text: prompt }]
      });
      if (result.stopReason === 'cancelled') throw new DOMException('Antigravity request cancelled', 'AbortError');
      if (result.stopReason === 'refusal') {
        throw new LLMProviderError('Antigravity refused the request.', this.name, 'PROVIDER_ERROR');
      }
      if (!textSeen && tools.size === 0) {
        throw new LLMProviderError('Antigravity returned an empty response.', this.name, 'PROVIDER_ERROR');
      }
      const usage = asAcpObject(result.usage);
      const cacheReadTokens = typeof usage.cachedReadTokens === 'number' ? usage.cachedReadTokens : 0;
      const cacheWriteTokens = typeof usage.cachedWriteTokens === 'number' ? usage.cachedWriteTokens : 0;
      const inputTokens = typeof usage.inputTokens === 'number' ? usage.inputTokens : 0;
      const completionTokens = typeof usage.outputTokens === 'number' ? usage.outputTokens : 0;
      const totalTokens = typeof usage.totalTokens === 'number'
        ? usage.totalTokens : inputTokens + cacheReadTokens + cacheWriteTokens + completionTokens;
      const promptTokens = totalTokens - completionTokens;
      chunks.push({
        content: '', complete: true,
        finishReason: result.stopReason === 'max_tokens' ? 'length' : 'stop',
        toolCalls: tools.size > 0 ? Array.from(tools.values()) : undefined,
        usage: {
          promptTokens, completionTokens, totalTokens, cacheReadTokens, cacheWriteTokens,
          reasoningTokens: typeof usage.thoughtTokens === 'number' ? usage.thoughtTokens : undefined
        },
        metadata: { localCli: true, providerExecutedTools: true }
      });
    }).catch((error: unknown) => { fault = error instanceof Error ? error : new Error(String(error)); }).finally(() => { done = true; wake?.(); });

    try {
      while (!done || chunks.length > 0) {
        if (chunks.length > 0) yield chunks.shift()!;
        else if (!done) await new Promise<void>(resolve => { wake = resolve; });
      }
      if (fault) throw fault;
    } finally {
      controller.abort();
      await session;
      this.active.delete(controller);
      options?.abortSignal?.removeEventListener('abort', abort);
    }
  }

  listModels(): Promise<ModelInfo[]> {
    return Promise.resolve(ModelRegistry.getProviderModels(this.name).map(model => ModelRegistry.toModelInfo(model)));
  }

  getCapabilities(): ProviderCapabilities {
    return {
      supportsStreaming: true, streamingMode: 'live', supportsJSON: false, supportsImages: false, supportsFunctions: true,
      supportsThinking: true, maxContextWindow: 1048576, supportedFeatures: ['local-cli', 'mcp']
    };
  }

  getModelPricing(modelId: string): Promise<ModelPricing | null> {
    const model = ModelRegistry.findModel(this.name, modelId);
    return Promise.resolve(model ? {
      rateInputPerMillion: model.inputCostPerMillion, rateOutputPerMillion: model.outputCostPerMillion, currency: 'USD'
    } : null);
  }

  abort(): void {
    for (const controller of this.active) controller.abort();
  }

  dispose(): void {
    this.abort();
  }
}
