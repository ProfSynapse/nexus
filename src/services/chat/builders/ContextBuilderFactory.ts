/**
 * ContextBuilderFactory - Creates the appropriate context builder for a provider
 *
 * Factory pattern implementation that returns the correct IContextBuilder
 * based on the provider name and optionally model name.
 *
 * For local providers (LM Studio, Ollama), the model name determines format:
 * - Nexus/fine-tuned models: Use CustomFormatContextBuilder (<tool_call> format)
 * - Other models: Use OpenAIContextBuilder (standard tool_calls format)
 *
 * Follows Open/Closed Principle - adding new providers only requires:
 * 1. Creating a new builder class
 * 2. Adding it to this factory's mapping
 */

import { IContextBuilder } from './IContextBuilder';
import { OpenAIContextBuilder } from './OpenAIContextBuilder';
import { AnthropicContextBuilder } from './AnthropicContextBuilder';
import { GoogleContextBuilder } from './GoogleContextBuilder';
import { CustomFormatContextBuilder } from './CustomFormatContextBuilder';

// Singleton instances for each builder (they're stateless)
const openAIBuilder = new OpenAIContextBuilder();
const anthropicBuilder = new AnthropicContextBuilder();
const googleBuilder = new GoogleContextBuilder();
const customFormatBuilder = new CustomFormatContextBuilder();

/**
 * Provider categories for documentation/debugging
 */
export type ProviderCategory = 'openai-compatible' | 'anthropic' | 'google' | 'custom-format';

/**
 * Check if a model uses custom tool call format (fine-tuned with tool knowledge)
 * These models output <tool_call> or [TOOL_CALLS] instead of native tool_calls
 */
export function usesCustomToolFormat(modelId: string): boolean {
  const customFormatKeywords = ['nexus', 'tools-sft', 'claudesidian'];
  const lowerModelId = modelId.toLowerCase();
  return customFormatKeywords.some(keyword => lowerModelId.includes(keyword));
}

/**
 * Get the appropriate context builder for a provider
 *
 * @param provider - Provider name (e.g., 'openai', 'anthropic', 'google', 'openrouter')
 * @param model - Optional model name (used to determine format for local providers)
 * @returns The context builder for that provider
 */
export function getContextBuilder(provider: string, model?: string): IContextBuilder {
  const normalizedProvider = provider.toLowerCase();

  switch (normalizedProvider) {
    // Anthropic
    case 'anthropic':
      return anthropicBuilder;

    // Google
    case 'google':
      return googleBuilder;

    // Local providers: check model to determine format
    case 'lmstudio':
    case 'ollama':
      // Only use custom format for Nexus/fine-tuned models
      if (model && usesCustomToolFormat(model)) {
        return customFormatBuilder;
      }
      // Non-Nexus models use standard OpenAI format
      return openAIBuilder;

    // WebLLM always uses custom format (only runs Nexus models)
    case 'webllm':
      return customFormatBuilder;

    // OpenAI-compatible (default)
    case 'openai':
    case 'openrouter':
    case 'groq':
    case 'mistral':
    case 'requesty':
    case 'perplexity':
    default:
      return openAIBuilder;
  }
}

/**
 * Get the provider category for a given provider and model
 * Useful for debugging and logging
 *
 * @param provider - Provider name
 * @param model - Optional model name (used for local providers)
 * @returns Category string
 */
export function getProviderCategory(provider: string, model?: string): ProviderCategory {
  const normalizedProvider = provider.toLowerCase();

  switch (normalizedProvider) {
    case 'anthropic':
      return 'anthropic';
    case 'google':
      return 'google';
    case 'lmstudio':
    case 'ollama':
      // Only Nexus/fine-tuned models use custom format
      if (model && usesCustomToolFormat(model)) {
        return 'custom-format';
      }
      return 'openai-compatible';
    case 'webllm':
      return 'custom-format';
    default:
      return 'openai-compatible';
  }
}

/**
 * Check if a provider/model combination uses a specific builder type
 */
export function isOpenAICompatible(provider: string, model?: string): boolean {
  return getProviderCategory(provider, model) === 'openai-compatible';
}

export function isCustomFormat(provider: string, model?: string): boolean {
  return getProviderCategory(provider, model) === 'custom-format';
}
