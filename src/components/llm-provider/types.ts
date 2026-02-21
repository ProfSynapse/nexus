/**
 * LLM Provider Modal Types
 *
 * Shared interfaces for provider-specific modal components.
 * Each provider (Nexus, Ollama, LM Studio, Generic API) implements IProviderModal.
 */

import { App, Vault } from 'obsidian';
import { LLMProviderConfig } from '../../types';
import { LLMProviderManager } from '../../services/llm/providers/ProviderManager';
import { StaticModelsService } from '../../services/StaticModelsService';

/**
 * Interface for provider-specific modal content
 * Each provider implements this to render its configuration UI
 */
export interface IProviderModal {
  /**
   * Render the provider-specific content into the container
   */
  render(container: HTMLElement): void;

  /**
   * Validate the current configuration
   * @returns true if valid, false otherwise
   */
  validate?(): Promise<boolean>;

  /**
   * Get the current configuration to save
   */
  getConfig(): LLMProviderConfig;

  /**
   * Clean up resources when modal closes
   */
  destroy(): void;
}

/**
 * Configuration passed to provider modals
 */
export interface ProviderModalConfig {
  /** Provider identifier (e.g., 'webllm', 'ollama', 'openai') */
  providerId: string;

  /** Display name for the provider */
  providerName: string;

  /** Format hint for API key (e.g., 'sk-...') */
  keyFormat: string;

  /** URL to get API key */
  signupUrl: string;

  /** Current provider configuration */
  config: LLMProviderConfig;

  /** Callback when configuration changes (for auto-save) */
  onConfigChange: (config: LLMProviderConfig) => void;

  /** Optional OAuth configuration for providers that support OAuth connect */
  oauthConfig?: OAuthModalConfig;
}

/**
 * OAuth configuration for the provider modal connect button
 */
export interface OAuthModalConfig {
  /** Display label (e.g., "OpenRouter", "ChatGPT (Experimental)") */
  providerLabel: string;
  /** If true, show a consent dialog before starting the flow */
  experimental?: boolean;
  /** Warning text for experimental providers */
  experimentalWarning?: string;
  /** Fields to collect before opening the browser (e.g., key_name, credit limit) */
  preAuthFields?: Array<{
    key: string;
    label: string;
    placeholder?: string;
    required: boolean;
    defaultValue?: string;
  }>;
  /** Start the OAuth flow with collected params, returns the API key on success */
  startFlow(params: Record<string, string>): Promise<{ success: boolean; apiKey?: string; refreshToken?: string; expiresAt?: number; metadata?: Record<string, string>; error?: string }>;
}

/**
 * Dependencies injected into provider modals
 */
export interface ProviderModalDependencies {
  app: App;
  vault: Vault;
  providerManager: LLMProviderManager;
  staticModelsService: StaticModelsService;
}

/**
 * Nexus (WebLLM) model states
 */
export type NexusModelState =
  | 'not_downloaded'  // Model not in browser cache
  | 'downloading'     // Currently downloading from HuggingFace
  | 'downloaded'      // In browser cache, not loaded to GPU
  | 'loading'         // Loading into GPU memory
  | 'loaded'          // Ready for inference in GPU
  | 'error';          // Error state

/**
 * Nexus loading progress callback
 */
export interface NexusLoadingCallbacks {
  onLoadStart?: () => void;
  onLoadProgress?: (progress: number, stage: string) => void;
  onLoadComplete?: () => void;
  onLoadError?: (error: string) => void;
}
