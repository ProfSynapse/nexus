/**
 * AdapterRegistry - Manages adapter lifecycle and provider availability
 *
 * Extracted from LLMService.ts to follow Single Responsibility Principle.
 * This service is responsible ONLY for:
 * - Initializing adapters for configured providers
 * - Managing adapter instances
 * - Providing adapter availability checks
 * - Handling adapter cleanup
 *
 * MOBILE COMPATIBILITY (Dec 2025):
 * - SDK-based providers (OpenAI, Anthropic, Google, Mistral, Groq) are SKIPPED on mobile
 * - Only fetch-based providers (OpenRouter, Requesty, Perplexity) work on mobile
 * - These make direct HTTP requests without Node.js SDK dependencies
 * - Use platform.ts `isProviderCompatible()` to check before initializing
 */

import { Vault } from 'obsidian';
import { BaseAdapter } from '../adapters/BaseAdapter';
import { LLMProviderSettings, LLMProviderConfig } from '../../../types';
import { isMobile } from '../../../utils/platform';

// Type imports for TypeScript (don't affect bundling)
import type { WebLLMAdapter as WebLLMAdapterType } from '../adapters/webllm/WebLLMAdapter';

/**
 * Interface for adapter registry operations
 */
export interface IAdapterRegistry {
  /**
   * Initialize all adapters based on provider settings
   */
  initialize(settings: LLMProviderSettings, vault?: Vault): void;

  /**
   * Update settings and reinitialize adapters
   */
  updateSettings(settings: LLMProviderSettings): void;

  /**
   * Get adapter instance for a provider
   */
  getAdapter(providerId: string): BaseAdapter | undefined;

  /**
   * Get all available provider IDs
   */
  getAvailableProviders(): string[];

  /**
   * Check if a provider is initialized and available
   */
  isProviderAvailable(providerId: string): boolean;

  /**
   * Clear all adapters (for cleanup)
   */
  clear(): void;
}

/**
 * AdapterRegistry implementation
 * Manages the lifecycle of LLM provider adapters
 *
 * Note: Tool execution is now handled separately by IToolExecutor.
 * Adapters only handle LLM communication - they don't need mcpConnector.
 */
export class AdapterRegistry implements IAdapterRegistry {
  private adapters: Map<string, BaseAdapter> = new Map();
  private settings: LLMProviderSettings;
  private vault?: Vault;
  private webllmAdapter?: WebLLMAdapterType;
  private initPromise?: Promise<void>;

  constructor(settings: LLMProviderSettings, vault?: Vault) {
    this.settings = settings;
    this.vault = vault;
  }

  /**
   * Initialize all adapters based on provider settings
   * Now async to support dynamic imports for mobile compatibility
   */
  initialize(settings: LLMProviderSettings, vault?: Vault): void {
    this.settings = settings;
    if (vault) this.vault = vault;
    this.adapters.clear();
    // Start async initialization
    this.initPromise = this.initializeAdaptersAsync();
  }

  /**
   * Wait for initialization to complete (call after initialize if you need adapters immediately)
   */
  async waitForInit(): Promise<void> {
    if (this.initPromise) {
      await this.initPromise;
    }
  }

  /**
   * Update settings and reinitialize all adapters
   */
  updateSettings(settings: LLMProviderSettings): void {
    this.initialize(settings, this.vault);
  }

  /**
   * Get adapter instance for a specific provider
   */
  getAdapter(providerId: string): BaseAdapter | undefined {
    return this.adapters.get(providerId);
  }

  /**
   * Get all available (initialized) provider IDs
   */
  getAvailableProviders(): string[] {
    return Array.from(this.adapters.keys());
  }

  /**
   * Check if a provider is available
   */
  isProviderAvailable(providerId: string): boolean {
    return this.adapters.has(providerId);
  }

  /**
   * Clear all adapters
   */
  clear(): void {
    // Dispose Nexus adapter properly (cleanup GPU resources)
    if (this.webllmAdapter) {
      // Clear lifecycle manager reference first (dynamic import)
      import('../adapters/webllm/WebLLMLifecycleManager').then(({ getWebLLMLifecycleManager }) => {
        const lifecycleManager = getWebLLMLifecycleManager();
        lifecycleManager.setAdapter(null);
      }).catch(() => {});

      this.webllmAdapter.dispose().catch((error) => {
      });
      this.webllmAdapter = undefined;
    }
    this.adapters.clear();
  }

  /**
   * Get the WebLLM adapter instance (for model management)
   */
  getWebLLMAdapter(): WebLLMAdapterType | undefined {
    return this.webllmAdapter;
  }

  /**
   * Initialize adapters for all configured providers using dynamic imports
   * MOBILE: Only initializes fetch-based providers (OpenRouter, Requesty, Perplexity)
   * DESKTOP: Initializes all providers including SDK-based ones
   */
  private async initializeAdaptersAsync(): Promise<void> {
    const providers = this.settings?.providers;

    if (!providers) {
      return;
    }

    const onMobile = isMobile();

    // ═══════════════════════════════════════════════════════════════════════════
    // MOBILE-COMPATIBLE PROVIDERS (use fetch, no SDK dependencies)
    // These work on all platforms
    // ═══════════════════════════════════════════════════════════════════════════
    await this.initializeProviderAsync('openrouter', providers.openrouter, async (config) => {
      const { OpenRouterAdapter } = await import('../adapters/openrouter/OpenRouterAdapter');
      return new OpenRouterAdapter(config.apiKey, {
        httpReferer: config.httpReferer,
        xTitle: config.xTitle
      });
    });

    await this.initializeProviderAsync('requesty', providers.requesty, async (config) => {
      const { RequestyAdapter } = await import('../adapters/requesty/RequestyAdapter');
      return new RequestyAdapter(config.apiKey);
    });

    await this.initializeProviderAsync('perplexity', providers.perplexity, async (config) => {
      const { PerplexityAdapter } = await import('../adapters/perplexity/PerplexityAdapter');
      return new PerplexityAdapter(config.apiKey);
    });

    // ═══════════════════════════════════════════════════════════════════════════
    // DESKTOP-ONLY PROVIDERS (use Node.js SDKs)
    // Skip on mobile to avoid crashes from SDK Node.js dependencies
    // ═══════════════════════════════════════════════════════════════════════════
    if (!onMobile) {
      await this.initializeProviderAsync('openai', providers.openai, async (config) => {
        const { OpenAIAdapter } = await import('../adapters/openai/OpenAIAdapter');
        return new OpenAIAdapter(config.apiKey);
      });

      await this.initializeProviderAsync('anthropic', providers.anthropic, async (config) => {
        const { AnthropicAdapter } = await import('../adapters/anthropic/AnthropicAdapter');
        return new AnthropicAdapter(config.apiKey);
      });

      await this.initializeProviderAsync('google', providers.google, async (config) => {
        const { GoogleAdapter } = await import('../adapters/google/GoogleAdapter');
        return new GoogleAdapter(config.apiKey);
      });

      await this.initializeProviderAsync('mistral', providers.mistral, async (config) => {
        const { MistralAdapter } = await import('../adapters/mistral/MistralAdapter');
        return new MistralAdapter(config.apiKey);
      });

      await this.initializeProviderAsync('groq', providers.groq, async (config) => {
        const { GroqAdapter } = await import('../adapters/groq/GroqAdapter');
        return new GroqAdapter(config.apiKey);
      });
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // LOCAL PROVIDERS (require localhost servers - desktop only)
    // ═══════════════════════════════════════════════════════════════════════════
    if (!onMobile) {
      // Ollama - apiKey is actually the server URL
      if (providers.ollama?.enabled && providers.ollama.apiKey) {
        try {
          const ollamaModel = providers.ollama.ollamaModel;
          if (ollamaModel && ollamaModel.trim()) {
            const { OllamaAdapter } = await import('../adapters/ollama/OllamaAdapter');
            this.adapters.set('ollama', new OllamaAdapter(providers.ollama.apiKey, ollamaModel));
          }
        } catch (error) {
          console.error('AdapterRegistry: Failed to initialize Ollama adapter:', error);
          this.logError('ollama', error);
        }
      }

      // LM Studio - apiKey is actually the server URL
      if (providers.lmstudio?.enabled && providers.lmstudio.apiKey) {
        try {
          const { LMStudioAdapter } = await import('../adapters/lmstudio/LMStudioAdapter');
          this.adapters.set('lmstudio', new LMStudioAdapter(providers.lmstudio.apiKey));
        } catch (error) {
          console.error('AdapterRegistry: Failed to initialize LM Studio adapter:', error);
          this.logError('lmstudio', error);
        }
      }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // NEXUS/WEBLLM (Re-enabled Dec 2025)
    // ═══════════════════════════════════════════════════════════════════════════
    // WebLLM adapter for local LLM inference via WebGPU
    // Note: Nexus models are fine-tuned on the toolset - they skip getTools and
    // output tool calls that are converted to useTool format automatically.
    //
    // TEMPORARILY DISABLED: WebLLM initialization was causing vault startup hangs.
    // The prefetcher HTTP requests to HuggingFace may be blocking.
    // TODO: Fix prefetcher and re-enable
    // ═══════════════════════════════════════════════════════════════════════════
    if (!onMobile && providers.webllm?.enabled) {
      // Defer WebLLM initialization - don't block startup
      // Model will be loaded on-demand when user sends first message
      console.log('[AdapterRegistry] WebLLM enabled - deferring initialization to on-demand loading');
      // We still need to register a placeholder so the provider shows in UI
      // but we won't actually load the model until it's used
      try {
        const { WebLLMAdapter } = await import('../adapters/webllm/WebLLMAdapter');
        const adapter = new WebLLMAdapter(this.vault!);
        // DON'T call adapter.initialize() here - it blocks on WebGPU detection
        // The adapter will auto-initialize on first generate() call
        this.webllmAdapter = adapter;
        this.adapters.set('webllm', adapter);
        console.log('[AdapterRegistry] WebLLM adapter registered (not initialized)');
      } catch (error) {
        console.error('AdapterRegistry: Failed to create WebLLM adapter:', error);
        this.logError('webllm', error);
      }
    }
  }

  /**
   * Initialize a single provider adapter using async factory pattern
   * Handles common validation and error logging with dynamic import support
   */
  private async initializeProviderAsync(
    providerId: string,
    config: LLMProviderConfig | undefined,
    factory: (config: LLMProviderConfig) => Promise<BaseAdapter>
  ): Promise<void> {
    if (config?.apiKey && config.enabled) {
      try {
        const adapter = await factory(config);
        this.adapters.set(providerId, adapter);
      } catch (error) {
        console.error(`AdapterRegistry: Failed to initialize ${providerId} adapter:`, error);
        this.logError(providerId, error);
      }
    }
  }

  /**
   * Log detailed error information for debugging
   */
  private logError(providerId: string, error: unknown): void {
    console.error(`AdapterRegistry: Error details for ${providerId}:`, {
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      name: error instanceof Error ? error.name : undefined
    });
  }
}
