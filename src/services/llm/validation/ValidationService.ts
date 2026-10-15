/**
 * LLM Validation Service
 * Direct API key validation without full adapter initialization
 *
 * MOBILE COMPATIBILITY (Dec 2025):
 * - Removed Node.js crypto import
 * - Uses simple djb2 hash for validation caching (not cryptographic, but sufficient)
 * - All validation uses Obsidian's requestUrl (no SDK imports)
 */

import { BRAND_NAME } from '../../../constants/branding';
import {
  ProviderHttpClient,
  ProviderHttpResponse
} from '../adapters/shared/ProviderHttpClient';
import type { ModelSpec } from '../adapters/modelTypes';
import { PERPLEXITY_MODELS } from '../adapters/perplexity/PerplexityModels';
import { REQUESTY_MODELS } from '../adapters/requesty/RequestyModels';

type ValidationResponseBody = {
  error?: {
    message?: string;
  };
};

// Browser-compatible hash function (djb2 algorithm)
// Not cryptographically secure but sufficient for cache key validation
function generateHash(input: string): string {
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) + hash) + input.charCodeAt(i);
    hash = hash & hash; // Convert to 32bit integer
  }
  return Math.abs(hash).toString(16);
}

export class LLMValidationService {
  private static readonly VALIDATION_TIMEOUT = 10000; // 10 seconds
  private static readonly VALIDATION_DELAY = 2000; // 2 seconds delay before validation

  /**
   * Create a hash of the API key for validation caching
   */
  private static createKeyHash(apiKey: string): string {
    return generateHash(apiKey).substring(0, 16);
  }

  /**
   * Check if cached validation is still fresh (< 24 hours old and key unchanged)
   */
  private static isValidationCacheFresh(
    provider: string,
    apiKey: string,
    providerConfig?: { lastValidated?: number; validationHash?: string }
  ): boolean {
    if (!providerConfig?.lastValidated || !providerConfig?.validationHash) {
      return false; // No cache exists
    }
    
    // Check if key has changed
    const currentHash = this.createKeyHash(apiKey);
    if (currentHash !== providerConfig.validationHash) {
      return false; // Key changed since last validation
    }
    
    // Check if validation is less than 24 hours old
    const twentyFourHoursMs = 24 * 60 * 60 * 1000;
    const age = Date.now() - providerConfig.lastValidated;
    
    return age < twentyFourHoursMs;
  }

  /**
   * Wrapper for provider HTTP requests with timeout support
   */
  private static async requestWithTimeout(
    provider: string,
    operation: string,
    config: {
      url: string;
      method?: string;
      headers?: Record<string, string>;
      body?: string;
    }
  ): Promise<ProviderHttpResponse<ValidationResponseBody>> {
    return ProviderHttpClient.request({
      provider,
      operation,
      timeoutMs: this.VALIDATION_TIMEOUT,
      ...config
    });
  }

  /**
   * Validate a key with a read-only GET that needs authentication but no model.
   * Checks that send a test message name a model, and fail every key once the
   * provider retires that model.
   */
  private static async validateWithAuthenticatedGet(
    provider: string,
    label: string,
    url: string,
    headers: Record<string, string>,
    keyAcceptedStatuses: number[] = []
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const response = await this.requestWithTimeout(provider, `${label} validation`, {
        url,
        method: 'GET',
        headers
      });

      if ((response.status >= 200 && response.status < 300) || keyAcceptedStatuses.includes(response.status)) {
        return { success: true };
      }

      const errorData = (response.json ?? {}) as ValidationResponseBody & { message?: string; detail?: string };
      return {
        success: false,
        error: errorData.error?.message || errorData.message || errorData.detail || `HTTP ${response.status}`
      };
    } catch (error: unknown) {
      return {
        success: false,
        error: error instanceof Error ? error.message : `${label} API key validation failed`
      };
    }
  }

  /** How many registry models a test-message check tries before giving up. */
  private static readonly TEST_MODEL_ATTEMPTS = 3;

  /**
   * The provider's own registry models, cheapest first, for a test message.
   * Taking them from the registry instead of a hardcoded id means the check
   * moves with the model list, and a model with no price (unknown or free,
   * which is how a removed free model broke the OpenRouter check) goes last.
   */
  static cheapestTestModels(models: readonly ModelSpec[]): string[] {
    const cost = (model: ModelSpec) => model.inputCostPerMillion + model.outputCostPerMillion;
    return models
      .map((model, index) => ({ model, index }))
      .sort((a, b) => {
        const aPriced = cost(a.model) > 0;
        const bPriced = cost(b.model) > 0;
        if (aPriced !== bPriced) return aPriced ? -1 : 1;
        return cost(a.model) - cost(b.model) || a.index - b.index;
      })
      .map(({ model }) => model.apiName)
      .filter((id, index, ids) => ids.indexOf(id) === index)
      .slice(0, this.TEST_MODEL_ATTEMPTS);
  }

  /**
   * Validate a key by sending a one-word test message, for providers that
   * cannot check a key any other way. It tries the cheapest registry models in
   * turn: an error about the model moves on to the next one, and an error
   * about the key stops. If every model was refused only as a model, the key
   * itself was accepted, so a retired model never fails the provider.
   */
  private static async validateWithTestMessage(
    provider: string,
    label: string,
    url: string,
    headers: Record<string, string>,
    models: string[],
    buildBody: (model: string) => Record<string, unknown>
  ): Promise<{ success: boolean; error?: string }> {
    if (models.length === 0) {
      return { success: false, error: `No ${label} model is available to check the key with` };
    }

    try {
      for (const model of models) {
        const response = await this.requestWithTimeout(provider, `${label} validation`, {
          url,
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...headers },
          body: JSON.stringify(buildBody(model))
        });

        if (response.status >= 200 && response.status < 300) {
          return { success: true };
        }

        const errorData = (response.json ?? {}) as ValidationResponseBody & { message?: string; detail?: string };
        const error = errorData.error?.message || errorData.message || errorData.detail || `HTTP ${response.status}`;
        if (!this.isTestModelUnavailable(response.status, error)) {
          return { success: false, error };
        }
      }
      return { success: true };
    } catch (error: unknown) {
      return {
        success: false,
        error: error instanceof Error ? error.message : `${label} API key validation failed`
      };
    }
  }

  /** A 400/403/404 that is about the model, not the key or account. */
  private static isTestModelUnavailable(status: number, message: string): boolean {
    if (status !== 400 && status !== 403 && status !== 404) return false;
    return /model|endpoints? found/i.test(message) && !/api[ _-]?key|auth|credential|token/i.test(message);
  }

  /**
   * Validate an API key by making a simple test request
   */
  static async validateApiKey(
    provider: string,
    apiKey: string,
    options?: {
      forceValidation?: boolean;  // Set true to bypass cache
      providerConfig?: { lastValidated?: number; validationHash?: string };
      onValidationSuccess?: (hash: string, timestamp: number) => void;  // Callback to save validation state
    }
  ): Promise<{ success: boolean; error?: string }> {
    try {
      // Check cache first (unless forced)
      if (!options?.forceValidation && options?.providerConfig) {
        if (this.isValidationCacheFresh(provider, apiKey, options.providerConfig)) {
          return { success: true };
        }
      }
      
      // Wait before validation
      await new Promise(resolve => window.setTimeout(resolve, this.VALIDATION_DELAY));
      
      // Perform actual validation
      let result: { success: boolean; error?: string };
      
      switch (provider) {
        case 'openai':
          result = await this.validateOpenAI(apiKey);
          break;
        case 'anthropic':
          result = await this.validateAnthropic(apiKey);
          break;
        case 'google':
          result = await this.validateGoogle(apiKey);
          break;
        case 'mistral':
          result = await this.validateMistral(apiKey);
          break;
        case 'groq':
          result = await this.validateGroq(apiKey);
          break;
        case 'deepseek':
          result = await this.validateDeepSeek(apiKey);
          break;
        case 'deepgram':
          result = await this.validateDeepgram(apiKey);
          break;
        case 'assemblyai':
          result = await this.validateAssemblyAI(apiKey);
          break;
        case 'openrouter':
          result = await this.validateOpenRouter(apiKey);
          break;
        case 'perplexity':
          result = await this.validatePerplexity(apiKey);
          break;
        case 'requesty':
          result = await this.validateRequesty(apiKey);
          break;
        default:
          return { success: false, error: `Unsupported provider: ${provider}` };
      }
      
      // If validation succeeded, update cache via callback
      if (result.success && options?.onValidationSuccess) {
        const hash = this.createKeyHash(apiKey);
        const timestamp = Date.now();
        options.onValidationSuccess(hash, timestamp);
      }
      
      return result;
    } catch (error) {
      return { 
        success: false, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      };
    }
  }

  private static async validateOpenAI(apiKey: string): Promise<{ success: boolean; error?: string }> {
    // Listing models names no model. A restricted key without the model-read
    // scope gets 403 here but still authenticated, so 403 accepts the key.
    return this.validateWithAuthenticatedGet('openai', 'OpenAI', 'https://api.openai.com/v1/models', {
      'Authorization': `Bearer ${apiKey}`
    }, [403]);
  }

  private static async validateAnthropic(apiKey: string): Promise<{ success: boolean; error?: string }> {
    // Listing models needs a valid key but no model id, so a retired model cannot fail the check.
    return this.validateWithAuthenticatedGet('anthropic', 'Anthropic', 'https://api.anthropic.com/v1/models', {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    });
  }

  private static async validateGoogle(apiKey: string): Promise<{ success: boolean; error?: string }> {
    // Listing models needs a valid key but no model id, so a retired model cannot fail the check.
    return this.validateWithAuthenticatedGet('google', 'Google', 'https://generativelanguage.googleapis.com/v1beta/models', { 'x-goog-api-key': apiKey });
  }

  private static async validateMistral(apiKey: string): Promise<{ success: boolean; error?: string }> {
    // Listing models needs a valid key but no model id, so a retired model cannot fail the check.
    return this.validateWithAuthenticatedGet('mistral', 'Mistral', 'https://api.mistral.ai/v1/models', { 'Authorization': `Bearer ${apiKey}` });
  }

  private static async validateGroq(apiKey: string): Promise<{ success: boolean; error?: string }> {
    // Listing models needs a valid key but no model id, so a retired model cannot fail the check.
    return this.validateWithAuthenticatedGet('groq', 'Groq', 'https://api.groq.com/openai/v1/models', { 'Authorization': `Bearer ${apiKey}` });
  }

  private static async validateDeepSeek(apiKey: string): Promise<{ success: boolean; error?: string }> {
    // Listing models needs a valid key but no model id, so a retired model cannot fail the check.
    return this.validateWithAuthenticatedGet('deepseek', 'DeepSeek', 'https://api.deepseek.com/models', { 'Authorization': `Bearer ${apiKey}` });
  }

  private static async validateOpenRouter(apiKey: string): Promise<{ success: boolean; error?: string }> {
    // OpenRouter's model list is public, so it cannot check a key. The key
    // endpoint can, and it costs nothing and names no model.
    return this.validateWithAuthenticatedGet('openrouter', 'OpenRouter', 'https://openrouter.ai/api/v1/key', {
      'Authorization': `Bearer ${apiKey}`,
      'HTTP-Referer': 'https://synapticlabs.ai',
      'X-Title': BRAND_NAME
    });
  }

  private static async validateDeepgram(apiKey: string): Promise<{ success: boolean; error?: string }> {
    try {
      const response = await this.requestWithTimeout('deepgram', 'Deepgram validation', {
        url: 'https://api.deepgram.com/v1/projects',
        method: 'GET',
        headers: {
          Authorization: `Token ${apiKey}`
        }
      });

      if (response.status >= 200 && response.status < 300) {
        return { success: true };
      }

      const errorData = (response.json ?? {}) as { err_msg?: string; error?: string };
      return {
        success: false,
        error: errorData.err_msg || errorData.error || `HTTP ${response.status}`
      };
    } catch (error: unknown) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Deepgram API key validation failed'
      };
    }
  }

  private static async validateAssemblyAI(apiKey: string): Promise<{ success: boolean; error?: string }> {
    try {
      const response = await this.requestWithTimeout('assemblyai', 'AssemblyAI validation', {
        url: 'https://api.assemblyai.com/v2/transcript',
        method: 'GET',
        headers: {
          Authorization: apiKey
        }
      });

      if (response.status >= 200 && response.status < 300) {
        return { success: true };
      }

      const errorData = (response.json ?? {}) as { error?: string };
      return {
        success: false,
        error: errorData.error || `HTTP ${response.status}`
      };
    } catch (error: unknown) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'AssemblyAI API key validation failed'
      };
    }
  }

  private static async validatePerplexity(apiKey: string): Promise<{ success: boolean; error?: string }> {
    // Perplexity has no model list, so this sends a test message to its
    // cheapest registry models.
    return this.validateWithTestMessage('perplexity', 'Perplexity', 'https://api.perplexity.ai/chat/completions', {
      'Authorization': `Bearer ${apiKey}`,
      'X-Pplx-Integration': 'nexus'
    }, this.cheapestTestModels(PERPLEXITY_MODELS), model => ({
      model,
      messages: [{ role: 'user', content: 'Hi' }],
      max_tokens: 5
    }));
  }

  private static async validateRequesty(apiKey: string): Promise<{ success: boolean; error?: string }> {
    // Requesty answers a bad key on its model list with the same 403 as other
    // refusals, so this sends a test message to its cheapest registry models.
    return this.validateWithTestMessage('requesty', 'Requesty', 'https://router.requesty.ai/v1/chat/completions', {
      'Authorization': `Bearer ${apiKey}`
    }, this.cheapestTestModels(REQUESTY_MODELS), model => ({
      model,
      messages: [{ role: 'user', content: 'Hi' }],
      max_completion_tokens: 5
    }));
  }
}
