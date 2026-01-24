/**
 * LLM Validation Service
 * Direct API key validation without full adapter initialization
 *
 * MOBILE COMPATIBILITY (Dec 2025):
 * - Removed Node.js crypto import
 * - Uses simple djb2 hash for validation caching (not cryptographic, but sufficient)
 * - All validation uses Obsidian's requestUrl (no SDK imports)
 */

import { requestUrl } from 'obsidian';
import { BRAND_NAME } from '../../../constants/branding';

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
   * Wrapper for requestUrl with timeout support
   */
  private static async requestWithTimeout(config: any): Promise<any> {
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject(new Error('Request timeout'));
      }, this.VALIDATION_TIMEOUT);

      requestUrl(config)
        .then(response => {
          clearTimeout(timeoutId);
          resolve(response);
        })
        .catch(error => {
          clearTimeout(timeoutId);
          reject(error);
        });
    });
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
      await new Promise(resolve => setTimeout(resolve, this.VALIDATION_DELAY));
      
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
    try {
      // Use Obsidian's requestUrl instead of SDK for mobile compatibility
      const response = await this.requestWithTimeout({
        url: 'https://api.openai.com/v1/chat/completions',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: 'gpt-5-nano',
          messages: [{ role: 'user', content: 'Hi' }],
          max_tokens: 5
        })
      });

      if (response.status >= 200 && response.status < 300) {
        return { success: true };
      } else {
        const errorData = response.json || {};
        return {
          success: false,
          error: errorData.error?.message || `HTTP ${response.status}`
        };
      }
    } catch (error: any) {
      return {
        success: false,
        error: error.message || 'OpenAI API key validation failed'
      };
    }
  }

  private static async validateAnthropic(apiKey: string): Promise<{ success: boolean; error?: string }> {
    try {
      // Use Obsidian's requestUrl to bypass CORS restrictions
      const response = await this.requestWithTimeout({
        url: 'https://api.anthropic.com/v1/messages',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-3-5-haiku-latest',
          max_tokens: 5,
          messages: [{ role: 'user', content: 'Hi' }]
        })
      });

      if (response.status >= 200 && response.status < 300) {
        return { success: true };
      } else {
        const errorData = response.json || {};
        return { 
          success: false, 
          error: errorData.error?.message || `HTTP ${response.status}` 
        };
      }
    } catch (error: any) {
      return { 
        success: false, 
        error: error.message || 'Anthropic API key validation failed' 
      };
    }
  }

  private static async validateGoogle(apiKey: string): Promise<{ success: boolean; error?: string }> {
    try {
      const response = await this.requestWithTimeout({
        url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text: 'Hi' }] }],
          generationConfig: { maxOutputTokens: 5 }
        })
      });

      if (response.status >= 200 && response.status < 300) {
        return { success: true };
      } else {
        const errorData = response.json || {};
        return { 
          success: false, 
          error: errorData.error?.message || `HTTP ${response.status}` 
        };
      }
    } catch (error: any) {
      return { 
        success: false, 
        error: error.message || 'Google API key validation failed' 
      };
    }
  }

  private static async validateMistral(apiKey: string): Promise<{ success: boolean; error?: string }> {
    try {
      const response = await this.requestWithTimeout({
        url: 'https://api.mistral.ai/v1/chat/completions',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: 'mistral-tiny',
          messages: [{ role: 'user', content: 'Hi' }],
          max_tokens: 5
        })
      });

      if (response.status >= 200 && response.status < 300) {
        return { success: true };
      } else {
        const errorData = response.json || {};
        return { 
          success: false, 
          error: errorData.error?.message || `HTTP ${response.status}` 
        };
      }
    } catch (error: any) {
      return { 
        success: false, 
        error: error.message || 'Mistral API key validation failed' 
      };
    }
  }

  private static async validateGroq(apiKey: string): Promise<{ success: boolean; error?: string }> {
    try {
      const response = await this.requestWithTimeout({
        url: 'https://api.groq.com/openai/v1/chat/completions',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: 'llama3-8b-8192',
          messages: [{ role: 'user', content: 'Hi' }],
          max_tokens: 5
        })
      });

      if (response.status >= 200 && response.status < 300) {
        return { success: true };
      } else {
        const errorData = response.json || {};
        return { 
          success: false, 
          error: errorData.error?.message || `HTTP ${response.status}` 
        };
      }
    } catch (error: any) {
      return { 
        success: false, 
        error: error.message || 'Groq API key validation failed' 
      };
    }
  }

  private static async validateOpenRouter(apiKey: string): Promise<{ success: boolean; error?: string }> {
    try {
      const requestBody = {
        model: 'liquid/lfm-2.5-1.2b-thinking:free',  // Free model for validation
        messages: [{ role: 'user', content: 'Hi' }],
        max_tokens: 1
      };
      
      const response = await this.requestWithTimeout({
        url: 'https://openrouter.ai/api/v1/chat/completions',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          'HTTP-Referer': 'https://synapticlabs.ai',
          'X-Title': BRAND_NAME
        },
        body: JSON.stringify(requestBody)
      });

      if (response.status >= 200 && response.status < 300) {
        return { success: true };
      } else {
        const errorData = response.json || {};
        const errorMessage = errorData.error?.message || JSON.stringify(errorData) || `HTTP ${response.status}`;
        console.error('OpenRouter validation error:', errorMessage);
        return { 
          success: false, 
          error: errorMessage
        };
      }
    } catch (error: any) {
      console.error('OpenRouter validation exception:', error);
      return { 
        success: false, 
        error: error.message || 'OpenRouter API key validation failed' 
      };
    }
  }

  private static async validatePerplexity(apiKey: string): Promise<{ success: boolean; error?: string }> {
    try {
      const response = await this.requestWithTimeout({
        url: 'https://api.perplexity.ai/chat/completions',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: 'sonar',
          messages: [{ role: 'user', content: 'Hi' }],
          max_tokens: 5
        })
      });

      if (response.status >= 200 && response.status < 300) {
        return { success: true };
      } else {
        const errorData = response.json || {};
        return { 
          success: false, 
          error: errorData.error?.message || `HTTP ${response.status}` 
        };
      }
    } catch (error: any) {
      return { 
        success: false, 
        error: error.message || 'Perplexity API key validation failed' 
      };
    }
  }

  private static async validateRequesty(apiKey: string): Promise<{ success: boolean; error?: string }> {
    try {
      const response = await this.requestWithTimeout({
        url: 'https://router.requesty.ai/v1/chat/completions',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: 'openai/gpt-5-nano',
          messages: [{ role: 'user', content: 'Hi' }],
          max_tokens: 5
        })
      });

      if (response.status >= 200 && response.status < 300) {
        return { success: true };
      } else {
        const errorData = response.json || {};
        return { 
          success: false, 
          error: errorData.error?.message || `HTTP ${response.status}` 
        };
      }
    } catch (error: any) {
      return { 
        success: false, 
        error: error.message || 'Requesty API key validation failed' 
      };
    }
  }
}
