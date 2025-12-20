/**
 * WebLLMEngine - Main thread WebLLM engine wrapper
 *
 * Runs WebLLM in the main thread instead of a worker to avoid
 * Obsidian's sandboxed Electron restrictions that block local module bundling.
 *
 * WebGPU handles the actual GPU compute, so main thread execution
 * doesn't block the UI during inference.
 *
 * Loads WebLLM from CDN (esm.run) - this is the cleanest solution because
 * WebLLM is designed for browsers and esm.run serves browser-compatible ESM.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║  MULTI-GENERATION CRASH INVESTIGATION NOTES (Dec 6, 2025)                 ║
 * ╠═══════════════════════════════════════════════════════════════════════════╣
 * ║  PROBLEM: Second generation (tool continuation) crashes Electron renderer ║
 * ║                                                                            ║
 * ║  CRASH LOCATION:                                                           ║
 * ║  - engine.chat.completions.create() succeeds                              ║
 * ║  - Stream object is created                                               ║
 * ║  - Crash happens during `for await (const chunk of stream)` iteration     ║
 * ║  - Specifically during WebLLM's prefill phase (processing input tokens)  ║
 * ║  - No JavaScript error is caught - hard renderer process crash            ║
 * ║                                                                            ║
 * ║  TESTED MITIGATIONS (all failed):                                          ║
 * ║  ┌─────────────────────────────────────────────────────────────────────┐  ║
 * ║  │ 1. Generation lock mechanism                                        │  ║
 * ║  │    - Added acquireGenerationLock() / releaseGenerationLock()       │  ║
 * ║  │    - Ensures sequential access to GPU                               │  ║
 * ║  │    - Result: Lock acquired, crash still happens during iteration   │  ║
 * ║  ├─────────────────────────────────────────────────────────────────────┤  ║
 * ║  │ 2. KV cache reset BEFORE generation                                 │  ║
 * ║  │    - await this.resetChat() before each generation                  │  ║
 * ║  │    - 100-300ms delay after reset                                    │  ║
 * ║  │    - Result: Reset completes, crash still happens during prefill   │  ║
 * ║  ├─────────────────────────────────────────────────────────────────────┤  ║
 * ║  │ 3. KV cache reset AFTER generation                                  │  ║
 * ║  │    - Reset in finally block after each generation                   │  ║
 * ║  │    - Result: First gen resets successfully, second gen crashes     │  ║
 * ║  ├─────────────────────────────────────────────────────────────────────┤  ║
 * ║  │ 4. NO KV cache resets at all                                        │  ║
 * ║  │    - Skipped all resetChat() calls                                  │  ║
 * ║  │    - Result: Still crashes - not reset-related                      │  ║
 * ║  ├─────────────────────────────────────────────────────────────────────┤  ║
 * ║  │ 5. Non-streaming API for continuations                              │  ║
 * ║  │    - Used stream: false for second generation                       │  ║
 * ║  │    - Result: Also crashes - not streaming-specific                  │  ║
 * ║  ├─────────────────────────────────────────────────────────────────────┤  ║
 * ║  │ 6. Longer delays between generations                                │  ║
 * ║  │    - 1000ms wait before second generation                           │  ║
 * ║  │    - 300ms after KV reset                                           │  ║
 * ║  │    - Result: Still crashes - not timing-related                     │  ║
 * ║  └─────────────────────────────────────────────────────────────────────┘  ║
 * ║                                                                            ║
 * ║  ENVIRONMENT:                                                              ║
 * ║  - macOS with Apple Silicon (M4)                                          ║
 * ║  - 24GB unified memory                                                    ║
 * ║  - WebGPU -> Metal translation layer                                      ║
 * ║  - WebLLM v0.2.80 via CDN (esm.run)                                       ║
 * ║  - Model: Nexus-Electron-Q3.0.2 (Qwen3-8B, 16K context, q4f16)           ║
 * ║                                                                            ║
 * ║  HYPOTHESIS:                                                               ║
 * ║  WebGPU resource management bug in WebLLM or browser WebGPU->Metal layer ║
 * ║  The second prefill allocates GPU buffers that conflict with state from  ║
 * ║  the first generation, causing memory corruption or invalid GPU state.   ║
 * ║  Similar issues reported: https://github.com/mlc-ai/web-llm/issues/647   ║
 * ║                                                                            ║
 * ║  CURRENT WORKAROUND:                                                       ║
 * ║  Tool continuations are blocked in WebLLMAdapter.generateStreamAsync()   ║
 * ║  Users see friendly error message suggesting Ollama/LM Studio             ║
 * ║                                                                            ║
 * ║  FUTURE FIX OPTIONS:                                                       ║
 * ║  1. Wait for WebLLM upstream fix                                          ║
 * ║  2. Try engine.unload() + reload between generations (slow)              ║
 * ║  3. Compile custom WASM with different memory management                  ║
 * ║  4. Test on different browser/Electron versions                           ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 */

import { WebLLMModelSpec, WebLLMError } from './types';
import { WEBLLM_MODELS, HF_BASE_URL } from './WebLLMModels';
import { prefetchModel, isModelPrefetched } from './WebLLMCachePrefetcher';

// Type imports for TypeScript (these are erased at runtime)
import type * as WebLLMTypes from '@mlc-ai/web-llm';

export interface EngineProgress {
  progress: number;
  stage: 'downloading' | 'loading' | 'compiling';
  message: string;
}

export interface GenerationResult {
  content: string;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  finishReason: string;
}

export interface StreamChunk {
  content: string;
  tokenCount: number;
}

// Lazy-loaded WebLLM module
let webllm: typeof WebLLMTypes | null = null;

// Singleton engine instance - shared across all WebLLMAdapter instances
// This ensures the model stays loaded in GPU memory even when multiple adapters exist
let sharedEngineInstance: WebLLMEngine | null = null;

// Extend Window interface to include our patch tracking flag
interface NexusWindow extends Window {
  __nexus_wasm_patched?: boolean;
}

/**
 * Patch WebAssembly.instantiate to inject FFI stub functions
 *
 * Custom-compiled WASMs may import TVM FFI functions that the CDN version
 * of web-llm doesn't provide. We intercept WebAssembly.instantiate and
 * inject no-op stubs into the imports object.
 *
 * This is necessary because:
 * 1. Web-llm is loaded from CDN (esm.run), so we can't patch node_modules
 * 2. The stubs must be in the WASM import object, not just on window
 * 3. These are GPU stream management functions not used by WebGPU
 */
function patchWebAssemblyInstantiate(): void {
  const win = window as NexusWindow;

  // Check if we've already patched
  if (win.__nexus_wasm_patched) {
    return;
  }

  // Store original functions
  const originalInstantiate = WebAssembly.instantiate.bind(WebAssembly);
  const originalInstantiateStreaming = WebAssembly.instantiateStreaming?.bind(WebAssembly);

  // FFI stub functions - these are for CUDA/ROCm features not used by WebGPU
  // Add more stubs here as needed when new LinkErrors appear
  const ffiStubs: Record<string, () => number> = {
    TVMFFIEnvSetStream: () => 0,      // GPU stream management
    TVMFFIEnvGetStream: () => 0,      // GPU stream management
    TVMFFIEnvCheckSignals: () => 0,   // Interrupt/signal handling
  };

  // Type for WebAssembly module environment with FFI stubs
  type FFIEnv = Record<string, unknown> & Record<string, () => number>;

  // Helper to inject stubs into imports
  function injectStubs(imports: WebAssembly.Imports | undefined): WebAssembly.Imports {
    if (!imports) {
      return { env: { ...ffiStubs } };
    }

    // Clone imports to avoid mutating the original
    const patchedImports: WebAssembly.Imports = {};

    for (const namespace of Object.keys(imports)) {
      patchedImports[namespace] = { ...imports[namespace] };
    }

    // Inject stubs into 'env' namespace (where TVM FFI functions live)
    if (!patchedImports.env) {
      patchedImports.env = {};
    }

    const env = patchedImports.env as FFIEnv;

    // Add stubs only if not already present
    for (const [name, stub] of Object.entries(ffiStubs)) {
      if (!(name in env)) {
        env[name] = stub;
      }
    }

    return patchedImports;
  }

  // Patch WebAssembly.instantiate
  WebAssembly.instantiate = function(
    source: BufferSource | WebAssembly.Module,
    imports?: WebAssembly.Imports
  ): Promise<WebAssembly.WebAssemblyInstantiatedSource | WebAssembly.Instance> {
    const patchedImports = injectStubs(imports);
    return originalInstantiate(source, patchedImports);
  } as typeof WebAssembly.instantiate;

  // Patch WebAssembly.instantiateStreaming if available
  if (originalInstantiateStreaming) {
    WebAssembly.instantiateStreaming = function(
      source: Response | PromiseLike<Response>,
      imports?: WebAssembly.Imports
    ): Promise<WebAssembly.WebAssemblyInstantiatedSource> {
      const patchedImports = injectStubs(imports);
      return originalInstantiateStreaming(source, patchedImports);
    };
  }

  // Mark as patched
  win.__nexus_wasm_patched = true;
}

/**
 * Load WebLLM dynamically from CDN at runtime
 *
 * Uses jsDelivr's esm.run service which serves browser-compatible ESM modules.
 * This works in Electron's renderer because it has full browser capabilities.
 */
async function loadWebLLM(): Promise<typeof WebLLMTypes> {
  if (webllm) {
    return webllm;
  }

  // Patch WebAssembly.instantiate BEFORE loading WebLLM
  // This ensures the stubs are injected when WASM is instantiated
  patchWebAssemblyInstantiate();

  try {
    // Dynamic import from jsDelivr's esm.run service
    // This serves ESM modules that work in browser contexts
    // @ts-ignore - TypeScript doesn't understand CDN URLs, but Electron's renderer can import them
    const module = await import('https://esm.run/@mlc-ai/web-llm');

    webllm = module as typeof WebLLMTypes;

    if (!webllm.CreateMLCEngine) {
      throw new Error('CreateMLCEngine not found in module');
    }

    return webllm;
  } catch (error) {
    console.error('[WebLLMEngine] Failed to load WebLLM from CDN:', error);
    throw new WebLLMError(
      `Failed to load WebLLM: ${error instanceof Error ? error.message : String(error)}`,
      'MODULE_LOAD_FAILED',
      error
    );
  }
}

/**
 * Check if we should use stock WebLLM model for testing
 * Set to true to test with stock Mistral model instead of custom Nexus model
 */
const USE_STOCK_MODEL_FOR_TESTING = false; // Updated config with missing gen params

/**
 * Stock WebLLM model ID for testing
 * Uses official WebLLM model that's known to work
 */
const STOCK_TEST_MODEL_ID = 'Mistral-7B-Instruct-v0.3-q4f16_1-MLC';

/**
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║  CREATE WEBLLM CONFIG FOR NEXUS MODELS                                     ║
 * ╠═══════════════════════════════════════════════════════════════════════════╣
 * ║  This function creates the WebLLM AppConfig for a given model.            ║
 * ║                                                                            ║
 * ║  When adding new models to WebLLMModels.ts, this function will            ║
 * ║  automatically pick them up - no changes needed here!                      ║
 * ║                                                                            ║
 * ║  The config registers all models from WEBLLM_MODELS with WebLLM,          ║
 * ║  allowing runtime selection between them.                                  ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 */
function createNexusAppConfig(selectedModel?: WebLLMModelSpec): WebLLMTypes.AppConfig | undefined {
  if (USE_STOCK_MODEL_FOR_TESTING) {
    // Return undefined to use WebLLM's built-in model list
    return undefined;
  }

  // Build model list from all available Nexus models
  const modelList = WEBLLM_MODELS
    .filter(m => m.modelLibUrl) // Only include models with WASM libraries
    .map(model => ({
      model: `${HF_BASE_URL}/${model.huggingFaceRepo}/resolve/main/`,
      model_id: model.apiName,
      model_lib: model.modelLibUrl!,
      overrides: {
        context_window_size: model.contextWindow,
      },
    }));

  if (modelList.length === 0) {
    console.error('[WebLLMEngine] No valid models found in WEBLLM_MODELS');
    return undefined;
  }

  const targetModel = selectedModel || WEBLLM_MODELS[0];

  return { model_list: modelList };
}

export class WebLLMEngine {
  private engine: WebLLMTypes.MLCEngine | null = null;
  private isGenerating = false;
  private currentModelId: string | null = null;
  private abortController: AbortController | null = null;
  private generationLock: Promise<void> = Promise.resolve();
  private generationLockRelease: (() => void) | null = null;
  private hasGeneratedOnce = false; // Track if we've done at least one generation

  /**
   * Get the shared singleton engine instance
   * This ensures all WebLLMAdapter instances share the same GPU-loaded model
   */
  static getSharedInstance(): WebLLMEngine {
    if (!sharedEngineInstance) {
      sharedEngineInstance = new WebLLMEngine();
    }
    return sharedEngineInstance;
  }

  /**
   * Acquire the generation lock - ensures only one generation at a time
   * This prevents race conditions when tool continuations start before previous generation cleanup
   */
  private async acquireGenerationLock(): Promise<void> {
    // Wait for any existing generation to complete
    await this.generationLock;

    // Create a new lock
    this.generationLock = new Promise<void>((resolve) => {
      this.generationLockRelease = resolve;
    });
  }

  /**
   * Release the generation lock
   */
  private releaseGenerationLock(): void {
    if (this.generationLockRelease) {
      this.generationLockRelease();
      this.generationLockRelease = null;
    }
  }

  /**
   * Initialize the engine with a model
   */
  async initModel(
    modelSpec: WebLLMModelSpec,
    options?: {
      onProgress?: (progress: EngineProgress) => void;
    }
  ): Promise<{ modelId: string; contextWindow: number; maxTokens: number }> {
    console.log('[WebLLMEngine] initModel CALLED for:', modelSpec?.apiName || 'undefined');
    // If same model already loaded, skip
    if (this.engine && this.currentModelId === modelSpec.apiName) {
      return {
        modelId: modelSpec.apiName,
        contextWindow: modelSpec.contextWindow, // Use model's actual context window
        maxTokens: modelSpec.maxTokens,
      };
    }

    // Unload existing model if different
    if (this.engine && this.currentModelId !== modelSpec.apiName) {
      try {
        await this.unloadModel();
      } catch (unloadError) {
        // Ignore unload errors
      }
    }

    // Use stock model for testing, or custom model for production
    const modelIdToLoad = USE_STOCK_MODEL_FOR_TESTING ? STOCK_TEST_MODEL_ID : modelSpec.apiName;

    try {
      // Pre-fetch model files to cache (handles HuggingFace XetHub redirects)
      // This is critical because WebLLM's Cache.add() fails on redirects
      if (!USE_STOCK_MODEL_FOR_TESTING) {
        console.log('[WebLLMEngine] Checking if model is prefetched...');
        const alreadyPrefetched = await isModelPrefetched(modelSpec);
        console.log('[WebLLMEngine] Prefetch check result:', alreadyPrefetched);
        if (!alreadyPrefetched) {
          if (options?.onProgress) {
            options.onProgress({
              progress: 0,
              stage: 'downloading',
              message: 'Pre-fetching model files...',
            });
          }
          await prefetchModel(modelSpec, (prefetchProgress) => {
            if (options?.onProgress) {
              options.onProgress({
                progress: prefetchProgress.percentage,
                stage: 'downloading',
                message: `Downloading ${prefetchProgress.currentFile} (${prefetchProgress.completedFiles}/${prefetchProgress.totalFiles})`,
              });
            }
          });
        }
      }

      // Load WebLLM at runtime (not bundled)
      const webllmLib = await loadWebLLM();

      // Progress callback adapter with error protection
      const progressCallback = (report: WebLLMTypes.InitProgressReport) => {
        try {
          if (options?.onProgress) {
            const stage = report.text?.includes('Loading') ? 'loading' :
                          report.text?.includes('Download') ? 'downloading' : 'compiling';
            options.onProgress({
              progress: report.progress || 0,
              stage: stage as EngineProgress['stage'],
              message: report.text || '',
            });
          }
        } catch (progressError) {
          // Ignore progress callback errors
        }
      };

      // Create custom app config for Nexus model (or undefined to use built-in list)
      const appConfig = createNexusAppConfig();

      // Validate config before proceeding
      if (!appConfig?.model_list?.length) {
        throw new WebLLMError(
          'No models configured. Please check WebLLMModels.ts configuration.',
          'CONFIG_INVALID'
        );
      }

      // Create the MLC engine with timeout protection
      const enginePromise = webllmLib.CreateMLCEngine(modelIdToLoad, {
        appConfig,
        initProgressCallback: progressCallback,
      });

      // Add a timeout to prevent infinite hangs (5 minute timeout for large models)
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('Model loading timed out after 5 minutes')), 5 * 60 * 1000);
      });

      this.engine = await Promise.race([enginePromise, timeoutPromise]);

      this.currentModelId = modelIdToLoad;

      return {
        modelId: modelSpec.apiName,
        contextWindow: modelSpec.contextWindow, // Must match WASM (ctx4k = 4096)
        maxTokens: modelSpec.maxTokens,
      };
    } catch (error) {
      // Clean up any partial state
      this.engine = null;
      this.currentModelId = null;

      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error('[WebLLMEngine] Failed to load model:', errorMessage);
      console.error('[WebLLMEngine] Full error:', error);

      // Check for common error types
      if (errorMessage.includes('out of memory') || errorMessage.includes('OOM')) {
        throw new WebLLMError(
          'GPU out of memory. Try closing other GPU-intensive apps or use a smaller model.',
          'GPU_OOM',
          error
        );
      }

      if (errorMessage.includes('WebGPU') || errorMessage.includes('GPU')) {
        throw new WebLLMError(
          'WebGPU error. Your GPU may not be supported or drivers need updating.',
          'WEBGPU_ERROR',
          error
        );
      }

      if (errorMessage.includes('network') || errorMessage.includes('fetch') || errorMessage.includes('404')) {
        throw new WebLLMError(
          'Failed to download model files. Check your internet connection.',
          'NETWORK_ERROR',
          error
        );
      }

      throw new WebLLMError(
        `Failed to initialize model: ${errorMessage}`,
        'LOAD_FAILED',
        error
      );
    }
  }

  /**
   * Generate a response (non-streaming)
   */
  async generate(
    messages: { role: string; content: string }[],
    options?: {
      temperature?: number;
      maxTokens?: number;
      topP?: number;
      stopSequences?: string[];
    }
  ): Promise<GenerationResult> {
    if (!this.engine) {
      throw new WebLLMError('Engine not initialized', 'GENERATION_FAILED');
    }

    if (this.isGenerating) {
      throw new WebLLMError('Generation already in progress', 'GENERATION_FAILED');
    }

    this.isGenerating = true;

    try {
      // Clear KV cache before generation to prevent OOM
      await this.resetChat();

      const response = await this.engine.chat.completions.create({
        messages: messages as WebLLMTypes.ChatCompletionMessageParam[],
        temperature: options?.temperature ?? 0.7,
        max_tokens: options?.maxTokens ?? 2048,
        top_p: options?.topP ?? 0.95,
        stop: options?.stopSequences,
        stream: false,
      });

      const choice = response.choices[0];
      const usage = response.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

      return {
        content: choice.message?.content || '',
        usage: {
          promptTokens: usage.prompt_tokens || 0,
          completionTokens: usage.completion_tokens || 0,
          totalTokens: usage.total_tokens || 0,
        },
        finishReason: choice.finish_reason || 'stop',
      };
    } finally {
      this.isGenerating = false;
    }
  }

  /**
   * Reset the chat state (clears KV cache from GPU memory)
   * CRITICAL for tool continuations - without this, OOM occurs!
   * NOTE: Only call resetChat ONCE - calling twice can corrupt WebGPU state
   */
  async resetChat(): Promise<void> {
    if (this.engine) {
      try {
        // Single reset call - double reset can corrupt WebGPU state on Apple Silicon
        await this.engine.resetChat();
      } catch (error) {
        // Non-fatal - continue anyway
      }
    }
  }

  /**
   * Generate a streaming response
   * @param isToolContinuation - If true, skip resetChat to preserve conversation context
   */
  async *generateStream(
    messages: { role: string; content: string }[],
    options?: {
      temperature?: number;
      maxTokens?: number;
      topP?: number;
      stopSequences?: string[];
      isToolContinuation?: boolean;
    }
  ): AsyncGenerator<StreamChunk | GenerationResult, void, unknown> {
    if (!this.engine) {
      throw new WebLLMError('Engine not initialized', 'GENERATION_FAILED');
    }

    const isToolContinuation = options?.isToolContinuation || false;

    // CRITICAL: Acquire lock to ensure sequential generation
    // This prevents race conditions during tool continuations
    await this.acquireGenerationLock();

    // If there's a lingering generation flag, force cleanup
    if (this.isGenerating) {
      try {
        this.engine.interruptGenerate();
        // Longer wait for interrupt to take effect
        await new Promise(resolve => setTimeout(resolve, 500));
      } catch (e) {
        // Ignore interrupt errors
      }
      this.isGenerating = false;
    }

    this.isGenerating = true;
    this.abortController = new AbortController();

    try {
      // Ensure any previous generation is fully stopped
      try {
        this.engine.interruptGenerate();
      } catch (e) {
        // Ignore - might not have anything to interrupt
      }

      // For tool continuations, add a longer delay to let WebGPU fully release resources
      if (isToolContinuation) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }

      // Always reset KV cache BEFORE each generation to ensure clean state
      try {
        await this.resetChat();
        // Longer delay after reset for GPU to fully process
        await new Promise(resolve => setTimeout(resolve, 300));
      } catch (e) {
        // Ignore reset errors
      }

      // Wrap stream creation in try-catch to capture WebGPU errors
      let stream: any;
      try {
        stream = await this.engine.chat.completions.create({
          messages: messages as WebLLMTypes.ChatCompletionMessageParam[],
          temperature: options?.temperature ?? 0.7,
          max_tokens: options?.maxTokens ?? 2048,
          top_p: options?.topP ?? 0.95,
          stop: options?.stopSequences,
          stream: true,
          stream_options: { include_usage: true },
        });
      } catch (streamError) {
        console.error('[NEXUS_DEBUG] Stream creation FAILED:', streamError);
        throw streamError;
      }

      let fullContent = '';
      let usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
      let finishReason = 'stop';
      let chunkCount = 0;

      try {
        for await (const chunk of stream) {
        chunkCount++;

        // Check for abort
        if (this.abortController?.signal.aborted) {
          finishReason = 'abort';
          break;
        }

        const delta = chunk.choices[0]?.delta;
        const content = delta?.content || '';

        if (content) {
          fullContent += content;
          yield {
            content,
            tokenCount: fullContent.length, // Approximate
          } as StreamChunk;
        }

        // Capture finish reason
        if (chunk.choices[0]?.finish_reason) {
          finishReason = chunk.choices[0].finish_reason;
        }

        // Capture usage from final chunk
        if (chunk.usage) {
          usage = {
            promptTokens: chunk.usage.prompt_tokens || 0,
            completionTokens: chunk.usage.completion_tokens || 0,
            totalTokens: chunk.usage.total_tokens || 0,
          };
        }
        }
      } catch (streamIterError) {
        // CRITICAL: Capture the actual WebGPU/WebLLM error
        console.error('[NEXUS_DEBUG] ⚠️ STREAM ITERATION CRASHED:', streamIterError);
        console.error('[NEXUS_DEBUG] Error type:', streamIterError?.constructor?.name);
        console.error('[NEXUS_DEBUG] Error message:', streamIterError instanceof Error ? streamIterError.message : String(streamIterError));
        console.error('[NEXUS_DEBUG] Error stack:', streamIterError instanceof Error ? streamIterError.stack : 'N/A');

        // Check if it's a GPU device lost error
        if (streamIterError instanceof Error && streamIterError.message?.includes('Device')) {
          console.error('[NEXUS_DEBUG] GPU Device Lost - this is a WebGPU issue');
        }

        // Re-throw to propagate error
        throw streamIterError;
      }

      // Yield final result
      yield {
        content: fullContent,
        usage,
        finishReason,
      } as GenerationResult;
    } finally {
      this.isGenerating = false;
      this.abortController = null;

      // NOTE: We do NOT reset KV cache after generation anymore
      // The resetChat() was causing empty responses on tool continuations
      // because WebLLM seems to need the KV cache state to persist
      // We only reset at the START of first generation (hasGeneratedOnce check)

      // Release the generation lock so next generation can proceed
      this.releaseGenerationLock();
    }
  }

  /**
   * Abort current generation
   */
  abort(): void {
    if (this.abortController) {
      this.abortController.abort();
    }
    if (this.engine && this.isGenerating) {
      this.engine.interruptGenerate();
      this.isGenerating = false;
    }
  }

  /**
   * Unload the model from GPU memory
   */
  async unloadModel(): Promise<void> {
    if (this.engine) {
      await this.engine.unload();
      this.engine = null;
      this.currentModelId = null;
    }
  }

  /**
   * Check if a model is loaded
   */
  isModelLoaded(): boolean {
    return this.engine !== null && this.currentModelId !== null;
  }

  /**
   * Get the currently loaded model ID
   */
  getCurrentModelId(): string | null {
    return this.currentModelId;
  }

  /**
   * Check if generation is in progress
   */
  isGenerationInProgress(): boolean {
    return this.isGenerating;
  }

  /**
   * Dispose the engine completely
   */
  async dispose(): Promise<void> {
    await this.unloadModel();
  }
}
