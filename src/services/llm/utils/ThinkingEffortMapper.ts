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
      effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
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
  // DeepSeek: thinking.{type, reasoning_effort}
  deepseek?: {
    thinking: {
      type: 'enabled';
      reasoning_effort: 'high' | 'max';
    };
  };
}

/**
 * Map our unified ThinkingEffort to DeepSeek's accepted reasoning_effort
 * values. DeepSeek only supports 'high' and 'max'; we treat 'high' as the
 * most aggressive option and use it for our internal 'high' setting, while
 * 'low' and 'medium' both downshift to 'high' (the entry point).
 */
function mapDeepSeekEffort(effort: ThinkingEffort): 'high' | 'max' {
  return effort === 'high' || effort === 'xhigh' || effort === 'max' ? 'max' : 'high';
}

/** Provider tiers that stop at high must not receive a Nexus-only enum. */
export function clampThinkingEffortToHigh(effort: ThinkingEffort): 'low' | 'medium' | 'high' {
  return effort === 'xhigh' || effort === 'max' ? 'high' : effort;
}

export function mapOpenAIThinkingEffort(effort: ThinkingEffort, modelId: string): 'low' | 'medium' | 'high' | 'xhigh' | 'max' {
  if (effort !== 'xhigh' && effort !== 'max') return effort;
  if (/^gpt-6(?:\.\d+)?-/.test(modelId) || /^gpt-5\.6(?:-|$)/.test(modelId)) return effort;
  if (/^gpt-5\.[2-9](?:-|$)/.test(modelId)) return 'xhigh';
  return 'high';
}

export function mapAnthropicAdaptiveEffort(effort: ThinkingEffort, modelId: string): ThinkingEffort {
  if (effort !== 'xhigh' && effort !== 'max') return effort;
  const model = modelId.replace(':1m', '');
  const supportsMax = /^claude-(?:fable-5(?:-1)?|mythos-5(?:-1|-preview)?|opus-(?:4-(?:6|7|8)|5(?:-5)?)|sonnet-(?:4-6|5(?:-5)?)|haiku-5-5)(?:-|$)/.test(model);
  if (!supportsMax) return 'high';
  if (effort === 'xhigh' && /^claude-(?:mythos-5-preview|opus-4-6|sonnet-4-6)(?:-|$)/.test(model)) return 'high';
  return effort;
}

/**
 * Token budgets for each effort level by provider
 */
const ANTHROPIC_BUDGETS: Record<'low' | 'medium' | 'high', number> = {
  low: 4000,
  medium: 16000,
  high: 32000
};

const GOOGLE_BUDGETS: Record<ThinkingEffort, number> = {
  low: 4096,
  medium: 8192,
  high: 24576,
  xhigh: 24576,
  max: 24576
};

const OPENROUTER_BUDGETS: Record<ThinkingEffort, number> = {
  low: 4096,
  medium: 8192,
  high: 16384,
  xhigh: 16384,
  max: 16384
};

export class ThinkingEffortMapper {
  /**
   * Get Anthropic thinking parameters
   */
  static getAnthropicParams(settings: ThinkingSettings, maxOutputTokens?: number): { budget_tokens?: number } | null {
    if (!settings.enabled) {
      return null;
    }
    if (settings.effort === 'xhigh' || settings.effort === 'max') {
      // The caller must supply its effective model/request output cap to lift
      // manual thinking above High. Leave 1,024 tokens for the visible reply.
      if (maxOutputTokens === undefined) return { budget_tokens: ANTHROPIC_BUDGETS.high };
      const available = Math.max(0, Math.floor(maxOutputTokens) - 1024);
      return { budget_tokens: settings.effort === 'xhigh' ? Math.min(64000, available) : available };
    }
    return {
      budget_tokens: ANTHROPIC_BUDGETS[settings.effort]
    };
  }

  /**
   * Get OpenAI reasoning parameters
   */
  static getOpenAIParams(settings: ThinkingSettings, modelId = ''): { reasoning?: { effort: string } } | null {
    if (!settings.enabled) {
      return null;
    }
    return {
      reasoning: {
        effort: mapOpenAIThinkingEffort(settings.effort, modelId)
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
      reasoning_effort: clampThinkingEffortToHigh(settings.effort)
    };
  }

  /**
   * Get DeepSeek thinking parameters.
   * DeepSeek's request body shape is { thinking: { type, reasoning_effort } }
   * — distinct from Groq's top-level reasoning_effort.
   */
  static getDeepSeekParams(settings: ThinkingSettings): { thinking?: { type: 'enabled'; reasoning_effort: 'high' | 'max' } } | null {
    if (!settings.enabled) {
      return null;
    }
    return {
      thinking: {
        type: 'enabled',
        reasoning_effort: mapDeepSeekEffort(settings.effort)
      }
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
            budget_tokens: this.getAnthropicParams(settings)?.budget_tokens ?? ANTHROPIC_BUDGETS.high
          }
        };
      case 'openai':
        return {
          openai: {
            reasoning: {
              effort: mapOpenAIThinkingEffort(settings.effort, '')
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
            reasoning_effort: clampThinkingEffortToHigh(settings.effort)
          }
        };
      case 'deepseek':
        return {
          deepseek: {
            thinking: {
              type: 'enabled',
              reasoning_effort: mapDeepSeekEffort(settings.effort)
            }
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
    const supportedProviders = ['anthropic', 'openai', 'google', 'gemini', 'openrouter', 'groq', 'deepseek'];
    return supportedProviders.includes(providerId.toLowerCase());
  }

  /**
   * Get the budget value for a given effort level and provider
   */
  static getBudget(providerId: string, effort: ThinkingEffort): number {
    switch (providerId.toLowerCase()) {
      case 'anthropic':
        return this.getAnthropicParams({ enabled: true, effort })?.budget_tokens ?? ANTHROPIC_BUDGETS.high;
      case 'google':
      case 'gemini':
        return GOOGLE_BUDGETS[effort];
      case 'openrouter':
        return OPENROUTER_BUDGETS[effort];
      default:
        // Default to Anthropic-style budgets
        return this.getAnthropicParams({ enabled: true, effort })?.budget_tokens ?? ANTHROPIC_BUDGETS.high;
    }
  }
}
