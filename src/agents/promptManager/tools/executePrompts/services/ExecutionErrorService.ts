import { StaticModelsService } from '../../../../../services/StaticModelsService';
import { LLMService } from '../../../../../services/llm/core/LLMService';
import { LLMProviderConfig } from '../../../../../types';
import { getErrorMessage } from '../../../../../utils/errorUtils';

export interface ExecutionErrorContext {
  provider?: string;
  model?: string;
}

/**
 * Centralized error mapping for executePrompts.
 * Keeps provider/model/API-key failures consistent across the tool.
 */
export class ExecutionErrorService {
  private static readonly API_KEY_ERROR_PATTERNS = [
    /api key/i,
    /missing_api_key/i,
    /invalid[_\s-]?api[_\s-]?key/i,
    /incorrect[_\s-]?api[_\s-]?key/i,
    /authentication/i,
    /unauthorized/i,
    /\b401\b/,
    /\b403\b/,
    /forbidden/i,
    /authentication_error/i
  ];

  private static readonly API_KEY_FREE_PROVIDERS = new Set(['webllm']);
  private static readonly LOCAL_URL_PROVIDERS = new Set(['ollama', 'lmstudio']);

  private staticModelsService = StaticModelsService.getInstance();

  constructor(private llmService: LLMService) {}

  buildNoAvailableProvidersError(): string {
    const providerConfigs = this.llmService.getAllProviderConfigs();
    const enabledProviders = Object.entries(providerConfigs)
      .filter(([, config]) => config?.enabled)
      .map(([provider]) => provider);

    if (enabledProviders.length === 0) {
      return 'No LLM providers are enabled. Enable a provider and configure its credentials in Settings > LLM Providers.';
    }

    const providersMissingCredentials = enabledProviders.filter((provider) => {
      const config = providerConfigs[provider];
      return !this.hasProviderCredential(provider, config);
    });

    if (providersMissingCredentials.length === enabledProviders.length) {
      const missingCredentials = providersMissingCredentials
        .map((provider) => `${provider} (${this.getCredentialLabel(provider)} missing)`)
        .join(', ');
      return `No LLM providers are available. Enabled providers are missing credentials: ${missingCredentials}. Configure valid credentials in Settings > LLM Providers.`;
    }

    return `No LLM providers are available. Enabled providers: ${enabledProviders.join(', ')}. Verify provider credentials in Settings > LLM Providers.`;
  }

  buildProviderUnavailableError(provider: string, availableProviders: string[]): string {
    const providerConfig = this.getProviderConfig(provider);
    const availableProvidersHint = availableProviders.length > 0
      ? `Available providers: ${availableProviders.join(', ')}.`
      : 'No providers are currently available.';

    if (!providerConfig || !providerConfig.enabled) {
      return `Provider '${provider}' is not enabled. Enable it and configure ${this.getCredentialLabel(provider)} in Settings > LLM Providers. ${availableProvidersHint}`;
    }

    if (!this.hasProviderCredential(provider, providerConfig)) {
      return `Provider '${provider}' is enabled but ${this.getCredentialLabel(provider)} is missing. Add it in Settings > LLM Providers. ${availableProvidersHint}`;
    }

    if (provider === 'ollama' && !providerConfig.ollamaModel?.trim()) {
      return `Provider 'ollama' is enabled but no model is configured. Set an Ollama model in Settings > LLM Providers. ${availableProvidersHint}`;
    }

    if (ExecutionErrorService.LOCAL_URL_PROVIDERS.has(provider)) {
      return `Provider '${provider}' is unavailable. Verify the local server URL and confirm the server is running. ${availableProvidersHint}`;
    }

    if (ExecutionErrorService.API_KEY_FREE_PROVIDERS.has(provider)) {
      return `Provider '${provider}' is enabled but failed to initialize. Re-enable it in Settings > LLM Providers. ${availableProvidersHint}`;
    }

    return `Provider '${provider}' is unavailable. The API key may be invalid or expired. Update it in Settings > LLM Providers. ${availableProvidersHint}`;
  }

  buildModelUnavailableError(
    model: string,
    selectedProvider: string,
    availableModelIds: string[],
    availableProviders: string[]
  ): string {
    const selectedProviderConfig = this.getProviderConfig(selectedProvider);
    const modelConfig = selectedProviderConfig?.models?.[model];

    if (modelConfig?.enabled === false) {
      return `Model '${model}' is disabled for provider '${selectedProvider}'. Enable it in Settings > LLM Providers or choose another model.`;
    }

    const providersForModel = Array.from(
      new Set(
        this.staticModelsService
          .getAllModels()
          .filter((knownModel) => knownModel.id === model)
          .map((knownModel) => knownModel.provider)
      )
    );

    if (providersForModel.length > 0 && !providersForModel.includes(selectedProvider)) {
      const unavailableModelProviders = providersForModel.filter(
        (provider) => !availableProviders.includes(provider)
      );

      if (unavailableModelProviders.length > 0) {
        const unavailableProvider = unavailableModelProviders[0];
        return `Model '${model}' belongs to provider '${unavailableProvider}', but that provider is not available. ${this.buildProviderUnavailableError(unavailableProvider, availableProviders)}`;
      }

      return `Model '${model}' is not served by provider '${selectedProvider}'. Available providers for this model: ${providersForModel.join(', ')}.`;
    }

    const availableModelsHint = availableModelIds.length > 0
      ? `Available models for '${selectedProvider}': ${availableModelIds.join(', ')}.`
      : `No models are currently available for provider '${selectedProvider}'.`;

    return `Model '${model}' is not available for provider '${selectedProvider}'. ${availableModelsHint}`;
  }

  normalizeExecutionError(error: unknown, context: ExecutionErrorContext = {}): string {
    const message = getErrorMessage(error).trim();

    if (!message) {
      return 'Unknown prompt execution error';
    }

    if (/No LLM providers available/i.test(message)) {
      return this.buildNoAvailableProvidersError();
    }

    const providerFromError = this.extractProviderFromAvailabilityError(message) || context.provider;
    if (providerFromError && /is not available/i.test(message)) {
      return this.buildProviderUnavailableError(providerFromError, this.llmService.getAvailableProviders());
    }

    if (this.isApiKeyIssue(message)) {
      return this.buildAuthenticationError(message, context.provider, context.model);
    }

    return message;
  }

  isApiKeyIssue(error: unknown): boolean {
    const message = getErrorMessage(error);
    return ExecutionErrorService.API_KEY_ERROR_PATTERNS.some((pattern) => pattern.test(message));
  }

  private buildAuthenticationError(message: string, provider?: string, model?: string): string {
    const providerLabel = provider ? `provider '${provider}'` : 'the selected provider';
    const modelLabel = model ? ` (model '${model}')` : '';
    const normalizedMessage = this.truncateMessage(message, 180);
    return `Authentication failed for ${providerLabel}${modelLabel}. The API key is missing, invalid, or expired. Update provider credentials in Settings > LLM Providers and retry. Provider message: ${normalizedMessage}`;
  }

  private extractProviderFromAvailabilityError(message: string): string | undefined {
    const match = message.match(/Provider '([^']+)' is not available/i);
    return match?.[1];
  }

  private getProviderConfig(provider: string): LLMProviderConfig | undefined {
    return this.llmService.getProviderConfig(provider);
  }

  private hasProviderCredential(provider: string, config?: LLMProviderConfig): boolean {
    if (!config || !config.enabled) {
      return false;
    }

    if (ExecutionErrorService.API_KEY_FREE_PROVIDERS.has(provider)) {
      return true;
    }

    return typeof config.apiKey === 'string' && config.apiKey.trim().length > 0;
  }

  private getCredentialLabel(provider: string): string {
    return ExecutionErrorService.LOCAL_URL_PROVIDERS.has(provider) ? 'server URL' : 'API key';
  }

  private truncateMessage(message: string, maxLength: number): string {
    if (message.length <= maxLength) {
      return message;
    }

    return `${message.slice(0, maxLength - 3)}...`;
  }
}
