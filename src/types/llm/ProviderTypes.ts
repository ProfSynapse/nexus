/**
 * LLM Provider Configuration Types
 * Extracted from types.ts for better organization and maintainability
 */

/**
 * Thinking effort levels - unified across all providers
 */
export type ThinkingEffort = 'low' | 'medium' | 'high';

/**
 * Thinking settings for models that support extended thinking
 */
export interface ThinkingSettings {
  enabled: boolean;
  effort: ThinkingEffort;
}

/**
 * Alias for backwards compatibility
 */
export type DefaultThinkingSettings = ThinkingSettings;

/**
 * Model configuration with enabled status and optional description
 */
export interface ModelConfig {
  enabled: boolean; // Primary field for controlling model visibility
  description?: string; // Optional user-defined description (for backwards compatibility)
}

/**
 * LLM provider configuration
 */
export interface LLMProviderConfig {
  apiKey: string;
  userDescription?: string;
  enabled: boolean;
  models?: { [modelId: string]: ModelConfig }; // Model-specific configurations
  ollamaModel?: string; // For Ollama: user-configured model name
  lastValidated?: number; // Unix timestamp (ms) of last successful validation
  validationHash?: string; // First 16 chars of SHA256 hash of validated API key
  // OpenRouter-specific headers (optional, but recommended for production)
  httpReferer?: string;
  xTitle?: string;
  // WebLLM-specific settings
  webllmModel?: string; // Selected WebLLM model (e.g., 'nexus-tools-q4f16')
  webllmQuantization?: 'q4f16' | 'q5f16' | 'q8f16'; // Quantization level
}

/**
 * Default model selection settings
 */
export interface DefaultModelSettings {
  provider: string;
  model: string;
}

/**
 * Default image model selection settings
 */
export interface DefaultImageModelSettings {
  provider: 'google' | 'openrouter';
  model: string;
}

/**
 * LLM provider settings
 */
export interface LLMProviderSettings {
  providers: {
    [providerId: string]: LLMProviderConfig;
  };
  defaultModel: DefaultModelSettings;
  agentModel?: DefaultModelSettings; // Model for executePrompt (API-only, used when chat model is local)
  agentThinking?: DefaultThinkingSettings; // Thinking settings for agent model (separate from chat model)
  defaultImageModel?: DefaultImageModelSettings; // Default image generation model
  defaultThinking?: DefaultThinkingSettings; // Default thinking settings for chat model
  defaultTemperature?: number; // Default temperature (0.0-1.0, default 0.5)
  monthlyBudget?: number; // Monthly budget in USD for LLM usage
}

/**
 * Default LLM provider settings
 */
export const DEFAULT_LLM_PROVIDER_SETTINGS: LLMProviderSettings = {
  providers: {
    openai: {
      apiKey: '',
      enabled: false
    },
    anthropic: {
      apiKey: '',
      enabled: false
    },
    google: {
      apiKey: '',
      enabled: false
    },
    mistral: {
      apiKey: '',
      enabled: false
    },
    groq: {
      apiKey: '',
      enabled: false
    },
    openrouter: {
      apiKey: '',
      enabled: false,
      httpReferer: '',
      xTitle: ''
    },
    requesty: {
      apiKey: '',
      enabled: false
    },
    perplexity: {
      apiKey: '',
      enabled: false
    },
    ollama: {
      apiKey: 'http://127.0.0.1:11434',
      enabled: false,
      ollamaModel: '' // User must configure their installed model
    },
    lmstudio: {
      apiKey: 'http://127.0.0.1:1234',
      enabled: false
    },
    webllm: {
      apiKey: '', // Not used - WebLLM is fully local
      enabled: false,
      webllmModel: 'nexus-tools-q4f16', // Default to Q4 quantization
      webllmQuantization: 'q4f16'
    }
  },
  defaultModel: {
    provider: 'openai',
    model: 'gpt-4o'
  },
  defaultImageModel: {
    provider: 'google',
    model: 'gemini-2.5-flash-image'
  },
  defaultThinking: {
    enabled: false,
    effort: 'medium'
  },
  defaultTemperature: 0.5
};
