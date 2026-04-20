/**
 * ThinkingEffortMapper - Converts unified thinking effort levels to provider-specific parameters
 *
 * Different providers implement thinking/reasoning features with different parameter names
 * and value ranges. This utility provides a consistent interface for all providers.
 */

import { ThinkingEffort, ThinkingSettings } from '../../../types/llm/ProviderTypes';

/**
 * Provider-specific thinking configuration
 */
export interface ProviderThinkingConfig {
  // Anthropic: budget_tokens
  anthropic?: {
    budget_tokens: number;
  };
  // OpenAI: reasoning.effort
  openai?: {
    reasoning: {
      effort: 'low' | 'medium' | 'high';
    };
  };
  // Google Gemini: thinkingBudget
  google?: {
    thinkingBudget: number;
  };
  // OpenRouter: reasoning.max_tokens
  openrouter?: {
    reasoning: {
      max_tokens: number;
    };
  };
  // Groq: reasoning_effort
  groq?: {
    reasoning_effort: 'low' | 'medium' | 'high';
  };
}

/**
 * Token budgets for each effort level by provider
 */
const ANTHROPIC_BUDGETS: Record<ThinkingEffort, number> = {
  low: 4000,
  medium: 16000,
  high: 32000
};

const GOOGLE_BUDGETS: Record<ThinkingEffort, number> = {
  low: 4096,
  medium: 8192,
  high: 24576
};

const OPENROUTER_BUDGETS: Record<ThinkingEffort, number> = {
  low: 4096,
  medium: 8192,
  high: 16384
};

export class ThinkingEffortMapper {
  /**
   * Get Anthropic thinking parameters
   */
  static getAnthropicParams(settings: ThinkingSettings): { budget_tokens?: number } | null {
    if (!settings.enabled) {
      return null;
    }
    return {
      budget_tokens: ANTHROPIC_BUDGETS[settings.effort]
    };
  }

  /**
   * Get OpenAI reasoning parameters
   */
  static getOpenAIParams(settings: ThinkingSettings): { reasoning?: { effort: string } } | null {
    if (!settings.enabled) {
      return null;
    }
    return {
      reasoning: {
        effort: settings.effort
      }
    };
  }

  /**
   * Get Google Gemini thinking parameters
   */
  static getGoogleParams(settings: ThinkingSettings): { thinkingBudget?: number } | null {
    if (!settings.enabled) {
      return null;
    }
    return {
      thinkingBudget: GOOGLE_BUDGETS[settings.effort]
    };
  }

  /**
   * Get OpenRouter reasoning parameters
   */
  static getOpenRouterParams(settings: ThinkingSettings): { reasoning?: { max_tokens: number } } | null {
    if (!settings.enabled) {
      return null;
    }
    return {
      reasoning: {
        max_tokens: OPENROUTER_BUDGETS[settings.effort]
      }
    };
  }

  /**
   * Get Groq reasoning parameters
   */
  static getGroqParams(settings: ThinkingSettings): { reasoning_effort?: string } | null {
    if (!settings.enabled) {
      return null;
    }
    return {
      reasoning_effort: settings.effort
    };
  }

  /**
   * Get provider-specific thinking configuration based on provider ID
   */
  static getProviderConfig(providerId: string, settings: ThinkingSettings): ProviderThinkingConfig | null {
    if (!settings.enabled) {
      return null;
    }

    switch (providerId.toLowerCase()) {
      case 'anthropic':
        return {
          anthropic: {
            budget_tokens: ANTHROPIC_BUDGETS[settings.effort]
          }
        };
      case 'openai':
        return {
          openai: {
            reasoning: {
              effort: settings.effort
            }
          }
        };
      case 'google':
      case 'gemini':
        return {
          google: {
            thinkingBudget: GOOGLE_BUDGETS[settings.effort]
          }
        };
      case 'openrouter':
        return {
          openrouter: {
            reasoning: {
              max_tokens: OPENROUTER_BUDGETS[settings.effort]
            }
          }
        };
      case 'groq':
        return {
          groq: {
            reasoning_effort: settings.effort
          }
        };
      default:
        // Unknown provider - return null
        return null;
    }
  }

  /**
   * Check if a provider supports thinking/reasoning features
   */
  static providerSupportsThinking(providerId: string): boolean {
    const supportedProviders = ['anthropic', 'openai', 'google', 'gemini', 'openrouter', 'groq'];
    return supportedProviders.includes(providerId.toLowerCase());
  }

  /**
   * Get the budget value for a given effort level and provider
   */
  static getBudget(providerId: string, effort: ThinkingEffort): number {
    switch (providerId.toLowerCase()) {
      case 'anthropic':
        return ANTHROPIC_BUDGETS[effort];
      case 'google':
      case 'gemini':
        return GOOGLE_BUDGETS[effort];
      case 'openrouter':
        return OPENROUTER_BUDGETS[effort];
      default:
        // Default to Anthropic-style budgets
        return ANTHROPIC_BUDGETS[effort];
    }
  }
}
