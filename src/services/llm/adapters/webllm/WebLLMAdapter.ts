/**
 * WebLLMAdapter
 *
 * Adapter for running LLMs locally via WebGPU using MLC.ai's WebLLM.
 * Provides fully offline inference after initial model download.
 *
 * Features:
 * - WebGPU-accelerated inference
 * - Streaming responses
 * - Tool calling via [TOOL_CALLS] format
 * - No external API required
 *
 * Note: Uses main-thread execution instead of Web Workers because
 * Obsidian's sandboxed Electron environment blocks CDN imports in workers.
 * WebGPU handles GPU compute, so main thread execution doesn't block UI.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║  ⚠️ KNOWN LIMITATION: TOOL CONTINUATIONS DISABLED (Dec 2025)              ║
 * ╠═══════════════════════════════════════════════════════════════════════════╣
 * ║  Tool calling works for the FIRST generation only. Multi-turn tool        ║
 * ║  continuations (ping-pong pattern) cause a hard Electron/WebGPU crash.    ║
 * ║                                                                            ║
 * ║  SYMPTOMS:                                                                 ║
 * ║  - First generation completes successfully with tool call                 ║
 * ║  - Tool execution works fine                                              ║
 * ║  - Second generation (continuation) crashes Obsidian renderer process    ║
 * ║  - Crash happens during prefill phase of stream iteration                ║
 * ║  - No JavaScript error is caught - it's a hard renderer crash            ║
 * ║                                                                            ║
 * ║  INVESTIGATION DONE (Dec 6, 2025):                                         ║
 * ║  1. Generation lock mechanism - prevents concurrent GPU ops               ║
 * ║  2. KV cache reset timing - before/after/skip - all crash                 ║
 * ║  3. Non-streaming API for continuations - also crashes                    ║
 * ║  4. Longer delays (1s+) between generations - still crashes              ║
 * ║  5. Skipping ALL resets - crashes during prefill                          ║
 * ║                                                                            ║
 * ║  LIKELY CAUSE:                                                             ║
 * ║  WebGPU resource management issue in WebLLM on Apple Silicon.             ║
 * ║  The second prefill operation corrupts GPU memory or hits an             ║
 * ║  unhandled edge case in the WebGPU -> Metal translation layer.           ║
 * ║  See: https://github.com/mlc-ai/web-llm/issues/647                        ║
 * ║                                                                            ║
 * ║  WORKAROUND:                                                               ║
 * ║  Tool continuations are blocked with a user-friendly error message.       ║
 * ║  Users should use Ollama or LM Studio for tool-calling workflows.         ║
 * ║                                                                            ║
 * ║  TO RE-ENABLE:                                                             ║
 * ║  1. Update to newer WebLLM version when available                         ║
 * ║  2. Remove the isToolContinuation check in generateStreamAsync()          ║
 * ║  3. Test thoroughly on multiple macOS/GPU configurations                  ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 */

import { Vault } from 'obsidian';
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
} from '../types';
import { ToolCallContentParser } from '../shared/ToolCallContentParser';
import { WebLLMEngine, GenerationResult } from './WebLLMEngine';
import { WebLLMModelManager } from './WebLLMModelManager';
import { WebLLMVRAMDetector } from './WebLLMVRAMDetector';
import {
  WebLLMModelSpec,
  WebLLMState,
  WebLLMStatus,
  WebLLMError,
  ChatMessage,
} from './types';
import { WEBLLM_MODELS, getWebLLMModel, getModelsForVRAM } from './WebLLMModels';

// Unique instance counter for debugging adapter recreation issues
let webllmAdapterInstanceCount = 0;

export class WebLLMAdapter extends BaseAdapter {
  readonly name = 'webllm';
  readonly baseUrl = ''; // Local model - no external URL

  private engine: WebLLMEngine;
  private modelManager: WebLLMModelManager;
  private state: WebLLMState;
  private vault: Vault;
  private instanceId: number;

  mcpConnector?: any; // For tool execution support

  constructor(vault: Vault, mcpConnector?: any) {
    // WebLLM doesn't need an API key
    super('', '', '', false);

    this.instanceId = ++webllmAdapterInstanceCount;

    this.vault = vault;
    this.mcpConnector = mcpConnector;
    // Use shared singleton engine - critical for multiple adapter instances
    // This ensures the GPU-loaded model is shared across all adapters
    this.engine = WebLLMEngine.getSharedInstance();
    this.modelManager = new WebLLMModelManager(vault);

    this.state = {
      status: 'unavailable',
      loadedModel: null,
    };

    this.initializeCache();
  }

  // ============================================================================
  // Initialization
  // ============================================================================

  /**
   * Initialize the WebLLM adapter
   * Checks WebGPU availability
   */
  async initialize(): Promise<void> {
    // Check WebGPU availability
    const vramInfo = await WebLLMVRAMDetector.detect();
    this.state.vramInfo = vramInfo;

    if (!vramInfo.webGPUSupported) {
      this.state.status = 'unavailable';
      return;
    }

    this.state.status = 'available';
  }

  /**
   * Load a model into GPU memory
   */
  async loadModel(
    modelSpec: WebLLMModelSpec,
    onProgress?: (progress: number, stage: string) => void
  ): Promise<void> {
    if (this.state.status === 'unavailable') {
      throw new WebLLMError('WebGPU not available', 'WEBGPU_NOT_SUPPORTED');
    }

    this.state.status = 'loading';

    try {
      // Initialize model via main-thread engine
      const result = await this.engine.initModel(modelSpec, {
        onProgress: (progress) => {
          this.state.loadProgress = progress.progress;
          if (onProgress) {
            onProgress(progress.progress, progress.stage);
          }
        },
      });

      this.state.status = 'ready';
      this.state.loadedModel = modelSpec.id;
      this.currentModel = modelSpec.apiName;
    } catch (error) {
      this.state.status = 'error';
      this.state.error = error instanceof Error ? error.message : 'Unknown error';
      throw error;
    }
  }

  /**
   * Unload the current model from GPU memory
   */
  async unloadModel(): Promise<void> {
    if (this.state.loadedModel) {
      await this.engine.unloadModel();
      this.state.status = 'available';
      this.state.loadedModel = null;
      this.currentModel = '';
    }
  }

  // ============================================================================
  // Generation (BaseAdapter implementation)
  // ============================================================================

  /**
   * Generate response without caching
   */
  async generateUncached(prompt: string, options?: GenerateOptions): Promise<LLMResponse> {
    await this.ensureModelLoadedAsync();

    const messages = this.buildMessages(prompt, options?.systemPrompt);

    try {
      this.state.status = 'generating';

      const result = await this.engine.generate(messages, {
        temperature: options?.temperature,
        maxTokens: options?.maxTokens,
        topP: options?.topP,
        stopSequences: options?.stopSequences,
      });

      this.state.status = 'ready';

      let content = result.content;
      let toolCalls: any[] = [];

      // Check for [TOOL_CALLS] format
      if (ToolCallContentParser.hasToolCallsFormat(content)) {
        const parsed = ToolCallContentParser.parse(content);
        if (parsed.hasToolCalls) {
          content = parsed.cleanContent;
          toolCalls = parsed.toolCalls;
        }
      }

      const usage: TokenUsage = {
        promptTokens: result.usage.promptTokens,
        completionTokens: result.usage.completionTokens,
        totalTokens: result.usage.totalTokens,
      };

      return await this.buildLLMResponse(
        content,
        this.currentModel,
        usage,
        { cached: false },
        toolCalls.length > 0 ? 'tool_calls' : this.mapFinishReason(result.finishReason),
        toolCalls
      );
    } catch (error) {
      this.state.status = 'ready';
      throw this.handleError(error, 'generation');
    }
  }

  /**
   * Generate streaming response
   */
  async* generateStreamAsync(
    prompt: string,
    options?: GenerateOptions
  ): AsyncGenerator<StreamChunk, void, unknown> {
    await this.ensureModelLoadedAsync();

    // Check for pre-built conversation history (tool continuations)
    let messages: ChatMessage[];
    if (options?.conversationHistory && options.conversationHistory.length > 0) {
      messages = options.conversationHistory;
    } else {
      messages = this.buildMessages(prompt, options?.systemPrompt);
    }

    // CRITICAL: Reset adapter state to 'ready' before starting new generation
    // This ensures clean state regardless of previous generation's outcome
    // The engine handles the actual locking via generationLock
    if (this.state.status === 'generating') {
      this.state.status = 'ready';
    }

    const isToolContinuation = !!(options?.conversationHistory?.length);

    this.state.status = 'generating';

    try {

      let accumulatedContent = '';
      let hasToolCallsFormat = false;
      let finalUsage: TokenUsage | undefined;
      let chunkCount = 0;

      for await (const response of this.engine.generateStream(messages, {
        temperature: options?.temperature,
        maxTokens: options?.maxTokens,
        topP: options?.topP,
        stopSequences: options?.stopSequences,
        isToolContinuation, // Pass flag to skip resetChat on continuations
      })) {
        // Check if this is a chunk or final result
        if ('tokenCount' in response && !('usage' in response)) {
          // This is a StreamChunk from the engine
          const chunk = response;
          chunkCount++;
          accumulatedContent += chunk.content;

          // Check for [TOOL_CALLS] format early in stream
          if (!hasToolCallsFormat && ToolCallContentParser.hasToolCallsFormat(accumulatedContent)) {
            hasToolCallsFormat = true;
          }

          // If [TOOL_CALLS] detected, buffer chunks (don't show raw JSON to user)
          if (!hasToolCallsFormat) {
            yield {
              content: chunk.content,
              complete: false,
            };
          }
        } else if ('usage' in response) {
          // This is a GenerationResult (final)
          const complete = response as GenerationResult;

          finalUsage = {
            promptTokens: complete.usage.promptTokens,
            completionTokens: complete.usage.completionTokens,
            totalTokens: complete.usage.totalTokens,
          };

          // Handle [TOOL_CALLS] format at completion
          if (hasToolCallsFormat) {
            const parsed = ToolCallContentParser.parse(accumulatedContent);

            if (parsed.hasToolCalls) {
              yield {
                content: parsed.cleanContent,
                complete: true,
                toolCalls: parsed.toolCalls,
                toolCallsReady: true,
                usage: finalUsage,
              };
            } else {
              // Parsing failed - yield raw content
              yield {
                content: accumulatedContent,
                complete: true,
                usage: finalUsage,
              };
            }
          } else {
            yield {
              content: '',
              complete: true,
              usage: finalUsage,
            };
          }
        }
      }
    } catch (error) {

      if (error instanceof WebLLMError) {
        throw error;
      }

      throw new LLMProviderError(
        `WebLLM streaming failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'webllm',
        'GENERATION_FAILED'
      );
    } finally {
      // CRITICAL: Always reset adapter status in finally block
      // This ensures clean state even if the generator is abandoned (not fully consumed)
      this.state.status = 'ready';
    }
  }

  // ============================================================================
  // Model Information
  // ============================================================================

  /**
   * List available models (based on VRAM)
   */
  async listModels(): Promise<ModelInfo[]> {
    const vramInfo = this.state.vramInfo || await WebLLMVRAMDetector.detect();
    const availableModels = getModelsForVRAM(vramInfo.estimatedVRAM);

    return availableModels.map(model => ({
      id: model.id,
      name: model.name,
      contextWindow: model.contextWindow,
      maxOutputTokens: model.maxTokens,
      supportsJSON: model.capabilities.supportsJSON,
      supportsImages: model.capabilities.supportsImages,
      supportsFunctions: model.capabilities.supportsFunctions,
      supportsStreaming: model.capabilities.supportsStreaming,
      supportsThinking: model.capabilities.supportsThinking,
      pricing: {
        inputPerMillion: 0, // Free - local
        outputPerMillion: 0,
        currency: 'USD',
        lastUpdated: new Date().toISOString(),
      },
    }));
  }

  /**
   * Get adapter capabilities
   */
  getCapabilities(): ProviderCapabilities {
    return {
      supportsStreaming: true,
      supportsJSON: true,
      supportsImages: false,
      supportsFunctions: true, // Via [TOOL_CALLS] format
      supportsThinking: false,
      maxContextWindow: 4096, // Must match WASM library (ctx4k)
      supportedFeatures: ['streaming', 'function_calling', 'local', 'privacy', 'offline'],
    };
  }

  /**
   * Get model pricing (always free for local models)
   */
  async getModelPricing(modelId: string): Promise<ModelPricing | null> {
    return {
      rateInputPerMillion: 0,
      rateOutputPerMillion: 0,
      currency: 'USD',
    };
  }

  /**
   * Check if adapter is available
   */
  async isAvailable(): Promise<boolean> {
    return this.state.status !== 'unavailable';
  }

  // ============================================================================
  // State & Status
  // ============================================================================

  /**
   * Get current adapter state
   */
  getState(): WebLLMState {
    return { ...this.state };
  }

  /**
   * Get current status
   */
  getStatus(): WebLLMStatus {
    return this.state.status;
  }

  /**
   * Check if model is loaded
   */
  isModelLoaded(): boolean {
    return this.state.loadedModel !== null;
  }

  /**
   * Check if a model uses [TOOL_CALLS] content format
   * All Nexus fine-tuned models use this format (legacy identifiers included for compatibility)
   */
  static usesToolCallsContentFormat(modelId: string): boolean {
    const contentFormatKeywords = ['nexus', 'tools-sft', 'claudesidian'];
    const lowerModelId = modelId.toLowerCase();
    return contentFormatKeywords.some(keyword => lowerModelId.includes(keyword));
  }

  // ============================================================================
  // Model Management Delegation
  // ============================================================================

  /**
   * Get model manager for download/install operations
   */
  getModelManager(): WebLLMModelManager {
    return this.modelManager;
  }

  /**
   * Get VRAM info
   */
  getVRAMInfo() {
    return this.state.vramInfo;
  }

  // ============================================================================
  // Helper Methods
  // ============================================================================

  /**
   * Ensure a model is loaded before generation
   * Will auto-load the default model if not already loaded
   */
  private async ensureModelLoadedAsync(): Promise<void> {
    const engineLoaded = this.engine?.isModelLoaded();

    if (this.state.status === 'unavailable') {
      throw new LLMProviderError(
        'WebGPU not available',
        'webllm',
        'WEBGPU_NOT_SUPPORTED'
      );
    }

    // If engine has model loaded, we're good - trust the shared engine state
    // This handles: tool continuation, multiple adapter instances, etc.
    if (engineLoaded) {
      // Sync adapter state with engine state
      const engineModelId = this.engine.getCurrentModelId();
      if (engineModelId && !this.state.loadedModel) {
        this.state.loadedModel = engineModelId;
        this.state.status = 'ready';
      }
      return;
    }

    // Also check if status is ready (normal case)
    if (this.state.loadedModel && this.state.status === 'ready') {
      return;
    }

    // If currently loading, wait
    if (this.state.status === 'loading') {
      // Wait for loading to complete (poll every 500ms, max 60s)
      for (let i = 0; i < 120; i++) {
        await new Promise(resolve => setTimeout(resolve, 500));
        // Use type assertion to break TypeScript's type narrowing (status can change async)
        const currentStatus = this.state.status as WebLLMStatus;
        if (currentStatus === 'ready') return;
        if (currentStatus === 'error') throw new LLMProviderError(
          this.state.error || 'Model loading failed',
          'webllm',
          'MODEL_LOAD_FAILED'
        );
      }
      throw new LLMProviderError('Model loading timeout', 'webllm', 'MODEL_LOAD_TIMEOUT');
    }

    // No model loaded - try to auto-load the default model
    // Get the default/first available model
    const modelSpec = WEBLLM_MODELS[0];
    if (!modelSpec) {
      throw new LLMProviderError(
        'No WebLLM models available',
        'webllm',
        'NO_MODELS_AVAILABLE'
      );
    }

    // WebLLM handles its own model caching via browser Cache API / IndexedDB
    // No need to check if model is "installed" locally - just load it
    // First load will download from HuggingFace, subsequent loads use cache
    await this.loadModel(modelSpec);
  }

  /**
   * Sync version for compatibility (throws if not loaded)
   */
  private ensureModelLoaded(): void {
    if (!this.state.loadedModel) {
      throw new LLMProviderError(
        'No model loaded. Model will be auto-loaded on first generation.',
        'webllm',
        'MODEL_NOT_LOADED'
      );
    }

    if (this.state.status === 'unavailable') {
      throw new LLMProviderError(
        'WebGPU not available',
        'webllm',
        'WEBGPU_NOT_SUPPORTED'
      );
    }
  }

  /**
   * Build chat messages from prompt and system prompt
   */
  protected buildMessages(prompt: string, systemPrompt?: string): ChatMessage[] {
    const messages: ChatMessage[] = [];

    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
    }

    messages.push({ role: 'user', content: prompt });

    return messages;
  }

  /**
   * Map WebLLM finish reason to standard type
   */
  private mapFinishReason(reason: string): 'stop' | 'length' | 'tool_calls' | 'content_filter' {
    switch (reason) {
      case 'stop':
        return 'stop';
      case 'length':
        return 'length';
      case 'abort':
        return 'stop';
      default:
        return 'stop';
    }
  }

  /**
   * Handle and normalize errors
   */
  protected handleError(error: any, operation: string): never {
    if (error instanceof LLMProviderError) {
      throw error;
    }

    if (error instanceof WebLLMError) {
      throw new LLMProviderError(
        error.message,
        'webllm',
        error.code,
        error
      );
    }

    throw new LLMProviderError(
      `WebLLM ${operation} failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      'webllm',
      'UNKNOWN_ERROR',
      error
    );
  }

  // ============================================================================
  // Cleanup
  // ============================================================================

  /**
   * Clean up resources
   */
  async dispose(): Promise<void> {
    await this.engine.dispose();
    this.state.status = 'unavailable';
    this.state.loadedModel = null;
  }
}
