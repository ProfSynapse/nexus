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
import { isProviderCompatible, isMobile, getPlatformName, getPlatformDebugInfo } from '../../../utils/platform';

// Type imports for TypeScript (don't affect bundling)
import type { WebLLMAdapter as WebLLMAdapterType } from '../adapters/webllm/WebLLMAdapter';

/**
 * Interface for adapter registry operations
 */
export interface IAdapterRegistry {
  /**
   * Initialize all adapters based on provider settings
   */
  initialize(settings: LLMProviderSettings, mcpConnector?: any, vault?: Vault): void;

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
 */
export class AdapterRegistry implements IAdapterRegistry {
  private adapters: Map<string, BaseAdapter> = new Map();
  private settings: LLMProviderSettings;
  private mcpConnector?: any;
  private vault?: Vault;
  private webllmAdapter?: WebLLMAdapterType;
  private initPromise?: Promise<void>;

  constructor(settings: LLMProviderSettings, mcpConnector?: any, vault?: Vault) {
    this.settings = settings;
    this.mcpConnector = mcpConnector;
    this.vault = vault;
  }

  /**
   * Initialize all adapters based on provider settings
   * Now async to support dynamic imports for mobile compatibility
   */
  initialize(settings: LLMProviderSettings, mcpConnector?: any, vault?: Vault): void {
    this.settings = settings;
    this.mcpConnector = mcpConnector;
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
    this.initialize(settings, this.mcpConnector, this.vault);
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
        console.warn('AdapterRegistry: Failed to dispose Nexus adapter:', error);
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
      console.warn('AdapterRegistry: No provider settings found, skipping initialization');
      return;
    }

    const platform = getPlatformName();
    const onMobile = isMobile();
    const platformInfo = getPlatformDebugInfo();

    console.log(`[AdapterRegistry] Platform: ${platform}, isMobile: ${onMobile}`, platformInfo);

    if (onMobile) {
      console.log(`[AdapterRegistry] Mobile mode - only fetch-based providers available (OpenRouter, Requesty, Perplexity)`);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // MOBILE-COMPATIBLE PROVIDERS (use fetch, no SDK dependencies)
    // These work on all platforms
    // ═══════════════════════════════════════════════════════════════════════════
    await this.initializeProviderAsync('openrouter', providers.openrouter, async (config) => {
      const { OpenRouterAdapter } = await import('../adapters/openrouter/OpenRouterAdapter');
      return new OpenRouterAdapter(config.apiKey, this.mcpConnector, {
        httpReferer: config.httpReferer,
        xTitle: config.xTitle
      });
    });

    await this.initializeProviderAsync('requesty', providers.requesty, async (config) => {
      const { RequestyAdapter } = await import('../adapters/requesty/RequestyAdapter');
      return new RequestyAdapter(config.apiKey, this.mcpConnector);
    });

    await this.initializeProviderAsync('perplexity', providers.perplexity, async (config) => {
      const { PerplexityAdapter } = await import('../adapters/perplexity/PerplexityAdapter');
      return new PerplexityAdapter(config.apiKey, this.mcpConnector);
    });

    // ═══════════════════════════════════════════════════════════════════════════
    // DESKTOP-ONLY PROVIDERS (use Node.js SDKs)
    // Skip on mobile to avoid crashes from SDK Node.js dependencies
    // ═══════════════════════════════════════════════════════════════════════════
    if (!onMobile) {
      await this.initializeProviderAsync('openai', providers.openai, async (config) => {
        const { OpenAIAdapter } = await import('../adapters/openai/OpenAIAdapter');
        return new OpenAIAdapter(config.apiKey, this.mcpConnector);
      });

      await this.initializeProviderAsync('anthropic', providers.anthropic, async (config) => {
        const { AnthropicAdapter } = await import('../adapters/anthropic/AnthropicAdapter');
        return new AnthropicAdapter(config.apiKey, this.mcpConnector);
      });

      await this.initializeProviderAsync('google', providers.google, async (config) => {
        const { GoogleAdapter } = await import('../adapters/google/GoogleAdapter');
        return new GoogleAdapter(config.apiKey, this.mcpConnector);
      });

      await this.initializeProviderAsync('mistral', providers.mistral, async (config) => {
        const { MistralAdapter } = await import('../adapters/mistral/MistralAdapter');
        return new MistralAdapter(config.apiKey, this.mcpConnector);
      });

      await this.initializeProviderAsync('groq', providers.groq, async (config) => {
        const { GroqAdapter } = await import('../adapters/groq/GroqAdapter');
        return new GroqAdapter(config.apiKey, this.mcpConnector);
      });
    } else {
      // Log which providers are skipped on mobile
      const skippedProviders = ['openai', 'anthropic', 'google', 'mistral', 'groq'];
      for (const providerId of skippedProviders) {
        const config = providers[providerId as keyof typeof providers];
        if (config?.enabled && config?.apiKey) {
          console.log(`[AdapterRegistry] Skipping ${providerId} on mobile (requires Node.js SDK)`);
        }
      }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // LOCAL PROVIDERS (require localhost servers - desktop only)
    // ═══════════════════════════════════════════════════════════════════════════
    if (!onMobile) {
      // Ollama - apiKey is actually the server URL
      if (providers.ollama?.enabled && providers.ollama.apiKey) {
        try {
          const ollamaModel = providers.ollama.ollamaModel;
          if (!ollamaModel || !ollamaModel.trim()) {
            console.warn('AdapterRegistry: Ollama enabled but no model configured');
          } else {
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
          this.adapters.set('lmstudio', new LMStudioAdapter(providers.lmstudio.apiKey, this.mcpConnector));
        } catch (error) {
          console.error('AdapterRegistry: Failed to initialize LM Studio adapter:', error);
          this.logError('lmstudio', error);
        }
      }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // NEXUS/WEBLLM DISABLED (Dec 6, 2025)
    // ═══════════════════════════════════════════════════════════════════════════
    // WebLLM causes hard Electron renderer crashes during multi-turn conversations.
    // See CLAUDE.md "Known Issues" for details.
    // ═══════════════════════════════════════════════════════════════════════════
    // if (providers.webllm?.enabled && this.vault) {
    //   try {
    //     const { WebLLMAdapter } = await import('../adapters/webllm/WebLLMAdapter');
    //     const { getWebLLMLifecycleManager } = await import('../adapters/webllm/WebLLMLifecycleManager');
    //     this.webllmAdapter = new WebLLMAdapter(this.vault, this.mcpConnector);
    //     this.adapters.set('webllm', this.webllmAdapter);
    //     const lifecycleManager = getWebLLMLifecycleManager();
    //     lifecycleManager.setAdapter(this.webllmAdapter);
    //     await this.webllmAdapter.initialize();
    //   } catch (error) {
    //     console.error('[AdapterRegistry] Failed to create Nexus adapter:', error);
    //     this.logError('webllm', error);
    //   }
    // }
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
