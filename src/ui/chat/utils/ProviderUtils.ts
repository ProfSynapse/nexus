/**
 * ProviderUtils - Utilities for provider and display name formatting
 */

export class ProviderUtils {
  /**
   * Get display name for provider
   */
  static getProviderDisplayName(providerId: string): string {
    const displayNames: Record<string, string> = {
      'openai': 'OpenAI',
      'anthropic': 'Anthropic',
      'anthropic-claude-code': 'Anthropic (Claude Code)',
      'google-gemini-cli': 'Google (Gemini CLI)',
      'mistral': 'Mistral AI',
      'ollama': 'Ollama',
      'lmstudio': 'LM Studio',
      'webllm': 'Nexus (Local)',
      'openrouter': 'OpenRouter',
      'google': 'Google',
      'github-copilot': 'GitHub Copilot',
      'cohere': 'Cohere',
      'huggingface': 'Hugging Face',
      'groq': 'Groq',
      'perplexity': 'Perplexity',
      'requesty': 'Requesty'
    };
    return displayNames[providerId] || this.capitalizeString(providerId);
  }

  /**
   * Capitalize agent name for display
   */
  static capitalizeAgentName(agentId: string): string {
    return agentId
      .split(/[-_]/)
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  }

  /**
   * Capitalize a string
   */
  static capitalizeString(str: string): string {
    return str.charAt(0).toUpperCase() + str.slice(1);
  }

  /**
   * Format model name for display
   */
  static formatModelName(modelId: string, modelName?: string): string {
    if (modelName) {
      return modelName;
    }
    
    // Convert model IDs to readable names
    const modelDisplayNames: Record<string, string> = {
      'gpt-4': 'GPT-4',
      'gpt-4-turbo': 'GPT-4 Turbo',
      'gpt-3.5-turbo': 'GPT-3.5 Turbo',
      'claude-3-opus': 'Claude 3 Opus',
      'claude-3-sonnet': 'Claude 3 Sonnet',
      'claude-3-haiku': 'Claude 3 Haiku',
      'mistral-large': 'Mistral Large',
      'mistral-medium': 'Mistral Medium',
      'mistral-small': 'Mistral Small'
    };

    return modelDisplayNames[modelId] || this.capitalizeString(modelId.replace(/-/g, ' '));
  }

  /**
   * Get provider color for UI theming
   */
  static getProviderColor(providerId: string): string {
    const colors: Record<string, string> = {
      'openai': '#10a37f',
      'anthropic': '#d97757',
      'anthropic-claude-code': '#d97757',
      'google-gemini-cli': '#4285f4',
      'mistral': '#ff6b35',
      'ollama': '#000000',
      'lmstudio': '#4A90E2',
      'webllm': '#00d4aa',  // WebGPU green
      'openrouter': '#8b5cf6',
      'google': '#4285f4',
      'github-copilot': '#1f6feb',
      'cohere': '#39c6b9',
      'huggingface': '#ff9a00'
    };
    return colors[providerId] || '#6b7280';
  }

  /**
   * Get provider icon (emoji or symbol)
   */
  static getProviderIcon(providerId: string): string {
    const icons: Record<string, string> = {
      'openai': '🤖',
      'anthropic': '🧠',
      'anthropic-claude-code': '🧠',
      'google-gemini-cli': '🔍',
      'mistral': '🌪️',
      'ollama': '🦙',
      'lmstudio': '🖥️',
      'webllm': '🌐',
      'openrouter': '🔀',
      'google': '🔍',
      'github-copilot': '✈️',
      'cohere': '🧬',
      'huggingface': '🤗'
    };
    return icons[providerId] || '🤖';
  }

  /**
   * Format context window size for display
   */
  static formatContextWindow(contextWindow: number): string {
    if (contextWindow >= 1000000) {
      return `${(contextWindow / 1000000).toFixed(1)}M tokens`;
    } else if (contextWindow >= 1000) {
      return `${(contextWindow / 1000).toFixed(0)}K tokens`;
    } else {
      return `${contextWindow} tokens`;
    }
  }

  /**
   * Get short provider abbreviation
   */
  static getProviderAbbreviation(providerId: string): string {
    const abbreviations: Record<string, string> = {
      'openai': 'OAI',
      'anthropic': 'ANT',
      'anthropic-claude-code': 'ACC',
      'google-gemini-cli': 'GCL',
      'mistral': 'MST',
      'ollama': 'OLL',
      'lmstudio': 'LMS',
      'webllm': 'WEB',
      'openrouter': 'OR',
      'google': 'GGL',
      'github-copilot': 'GHC',
      'cohere': 'COH',
      'huggingface': 'HF'
    };
    return abbreviations[providerId] || providerId.substring(0, 3).toUpperCase();
  }

  /**
   * Check if provider supports streaming
   */
  static supportsStreaming(providerId: string): boolean {
    const streamingProviders = [
      'openai',
      'anthropic',
      'anthropic-claude-code',
      'google-gemini-cli',
      'mistral',
      'ollama',
      'lmstudio',    // ✅ LM Studio streaming via OpenAI-compatible API
      'webllm',      // ✅ WebLLM streaming via MLC.ai WebGPU
      'openrouter',
      'google',      // ✅ Google Gemini streaming via generateContentStream
      'groq',        // ✅ Groq streaming support
      'github-copilot' // ✅ GitHub Copilot streaming via OpenAI-compatible SSE
    ];
    return streamingProviders.includes(providerId);
  }

  /**
   * Check if provider supports function calling (tool calling)
   * Based on API documentation research as of 2024-2025
   */
  static supportsFunctionCalling(providerId: string): boolean {
    const functionCallingProviders = [
      'openai',      // ✅ Native OpenAI function calling
      'lmstudio',    // ✅ OpenAI-compatible function calling (model-dependent)
      'webllm',      // ✅ [TOOL_CALLS] content format for fine-tuned models
      'openrouter',  // ✅ OpenAI-compatible function calling
      'groq',        // ✅ OpenAI-compatible function calling
      'mistral',     // ✅ Native Mistral function calling
      'requesty',    // ✅ OpenAI-compatible function calling
      'anthropic',   // ✅ Native Claude tool calling
      'anthropic-claude-code',
      'google-gemini-cli',
      'google',      // ✅ Native Google Gemini function calling (functionDeclarations)
      'github-copilot' // ✅ OpenAI-compatible function calling via Copilot proxy
    ];
    // Note: Perplexity does NOT support function calling (web search focused)
    return functionCallingProviders.includes(providerId);
  }

  /**
   * Get lucide wrench icon SVG for providers that support function calling
   */
  static getToolIconSVG(): string {
    return '<svg class="lucide lucide-wrench" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>';
  }

  /**
   * Get provider display name with tool icon if supported
   * For optgroup labels, uses text-based indicator since HTML isn't supported
   */
  static getProviderDisplayNameWithTools(providerId: string): string {
    const displayName = this.getProviderDisplayName(providerId);
    const supportsTools = this.supportsFunctionCalling(providerId);
    
    if (supportsTools) {
      return `${displayName} 🔧`; // Using emoji for optgroup compatibility
    }
    return displayName;
  }

  /**
   * Get provider display name with HTML tool icon for other UI contexts
   * Returns HTML string with SVG icon for tool-capable providers
   */
  static getProviderDisplayNameWithToolsHTML(providerId: string): string {
    const displayName = this.getProviderDisplayName(providerId);
    const supportsTools = this.supportsFunctionCalling(providerId);
    
    if (supportsTools) {
      return `${displayName} ${this.getToolIconSVG()}`;
    }
    return displayName;
  }

  /**
   * Get provider capabilities
   */
  static getProviderCapabilities(providerId: string): {
    streaming: boolean;
    functionCalling: boolean;
    imageInput: boolean;
    jsonMode: boolean;
  } {
    return {
      streaming: this.supportsStreaming(providerId),
      functionCalling: this.supportsFunctionCalling(providerId),
      imageInput: ['openai', 'anthropic', 'anthropic-claude-code', 'google', 'google-gemini-cli', 'github-copilot'].includes(providerId),
      jsonMode: ['openai', 'mistral'].includes(providerId)
    };
  }
}
