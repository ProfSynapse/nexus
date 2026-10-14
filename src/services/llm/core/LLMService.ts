/**
 * LLM Service - Main wrapper around the adapter kit
 * Provides unified interface to all LLM providers with Obsidian integration
 */

import { Vault, EventRef, DataAdapter } from 'obsidian';
import { BaseAdapter } from '../adapters/BaseAdapter';
import { GenerateOptions, LLMResponse, ModelInfo, SearchResult } from '../adapters/types';
import { LLMProviderSettings, LLMProviderConfig } from '../../../types';
import { IToolExecutor } from '../adapters/shared/ToolExecutionUtils';
import { AdapterRegistry } from './AdapterRegistry';
import { ModelDiscoveryService } from './ModelDiscoveryService';
import { FileContentService } from './FileContentService';
import { StreamingOrchestrator, StreamingOptions, StreamYield, ConversationMessage } from './StreamingOrchestrator';
import { VaultOperations } from '../../../core/VaultOperations';
import { CacheManager, VaultAdapter } from '../utils/CacheManager';
import { Logger } from '../utils/Logger';
import { LLMSettingsNotifier } from '../LLMSettingsNotifier';
import { resolveAgentModel, type AgentDefaults } from '../utils/SubagentModelResolver';

export interface LLMExecutionOptions extends GenerateOptions {
  provider?: string;
  model?: string;
  filepaths?: string[];
  systemPrompt?: string;
  userPrompt: string;
  webSearch?: boolean;
}

export interface LLMExecutionResult {
  success: boolean;
  response?: string;
  model?: string;
  provider?: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  cost?: {
    inputCost: number;
    outputCost: number;
    totalCost: number;
    currency: string;
  };
  filesIncluded?: string[];
  webSearchResults?: SearchResult[];
  error?: string;
}

export class LLMService {
  private adapterRegistry: AdapterRegistry;
  private modelDiscovery: ModelDiscoveryService;
  private fileContentService?: FileContentService;
  private settings: LLMProviderSettings;
  private vault?: Vault;
  private settingsEventRef: EventRef | null = null;
  private toolExecutor?: IToolExecutor;

  constructor(settings: LLMProviderSettings, vault?: Vault) {
    this.settings = settings;
    this.vault = vault;
    if (vault) {
      const adapter = vault.adapter as DataAdapter & VaultAdapter;
      CacheManager.configureVaultAdapter(adapter);
      Logger.setVaultAdapter(adapter);
    }
    this.adapterRegistry = new AdapterRegistry(settings, vault);
    this.adapterRegistry.initialize(settings, vault);
    this.modelDiscovery = new ModelDiscoveryService(this.adapterRegistry, settings);

    // Subscribe to settings changes for automatic adapter refresh (Obsidian Events API)
    this.settingsEventRef = LLMSettingsNotifier.onSettingsChanged((newSettings) => {
      this.updateSettings(newSettings);
    });
  }

  /**
   * Set the tool executor for tool call handling
   * This enables tools on ALL platforms (desktop + mobile)
   */
  setToolExecutor(executor: IToolExecutor): void {
    this.toolExecutor = executor;
  }

  /**
   * Set a callback invoked when adapter-level changes (e.g. token refresh) dirty settings.
   * The callback should persist settings to disk.
   */
  setOnSettingsDirty(cb: () => void): void {
    this.adapterRegistry.setOnSettingsDirty(cb);
  }


  /** Update settings and reinitialize adapters */
  updateSettings(settings: LLMProviderSettings): void {
    this.settings = settings;
    this.adapterRegistry.updateSettings(settings);
    this.modelDiscovery = new ModelDiscoveryService(this.adapterRegistry, settings);
  }

  /** Get all available models from enabled providers */
  async getAvailableModels(): Promise<(ModelInfo & { provider: string; userDescription?: string })[]> {
    return this.modelDiscovery.getAvailableModels();
  }

  /** Get available providers (those with API keys and enabled) */
  getAvailableProviders(): string[] {
    return this.adapterRegistry.getAvailableProviders();
  }

  /** Check if a provider is available */
  isProviderAvailable(provider: string): boolean {
    return this.adapterRegistry.isProviderAvailable(provider);
  }

  /** Get the default provider and model */
  getDefaultModel(): { provider: string; model: string } {
    return this.settings.defaultModel;
  }

  /**
   * Get the model to use for agent runs (subagents and executePrompt).
   *
   * A configured `agentModel` wins whatever the chat model is. Without one,
   * agent runs use the chat model if it is a cloud model, otherwise the first
   * available cloud provider (model left empty for the caller to pick). The
   * precedence lives in `resolveAgentModel` so every agent path agrees.
   */
  getAgentModel(): { provider: string; model: string } {
    const resolved = resolveAgentModel({
      defaultAgent: this.settings.agentModel,
      chat: this.settings.defaultModel,
      availableProviders: this.getAvailableProviders()
    });
    return { provider: resolved.provider, model: resolved.model };
  }

  /** Plugin-wide defaults for agent runs (Settings → Defaults → Subagents). */
  getAgentDefaults(): AgentDefaults {
    return {
      model: this.settings.agentModel,
      thinking: this.settings.agentThinking,
      agentTemperature: this.settings.agentTemperature,
      defaultTemperature: this.settings.defaultTemperature,
      contextWindowOverrides: this.settings.agentContextWindowOverrides
    };
  }

  /** Execute a prompt with the specified or default provider/model */
  async executePrompt(options: LLMExecutionOptions): Promise<LLMExecutionResult> {
    try {
      // Validate that we have settings
      if (!this.settings || !this.settings.defaultModel) {
        return {
          success: false,
          error: 'LLM service not properly configured - missing settings'
        };
      }

      // Determine provider and model
      const provider = options.provider || this.settings.defaultModel.provider;
      const model = options.model || this.settings.defaultModel.model;

      // Validate provider and model are specified
      if (!provider) {
        return {
          success: false,
          error: 'No provider specified and no default provider configured. Please set up LLM providers in settings.'
        };
      }

      if (!model) {
        return {
          success: false,
          error: 'No model specified and no default model configured. Please set up default model in settings.'
        };
      }

      // Get adapter for the provider
      const adapter = this.adapterRegistry.getAdapter(provider);

      if (!adapter) {
        const availableProviders = this.adapterRegistry.getAvailableProviders();
        return {
          success: false,
          error: `Provider '${provider}' is not available. Available providers: ${availableProviders.length > 0 ? availableProviders.join(', ') : 'none (no API keys configured)'}. Please check API key configuration in settings.`
        };
      }

      // Build the complete prompt
      let fullPrompt = options.userPrompt;
      
      // Add file content if filepaths provided
      let filesIncluded: string[] = [];
      if (options.filepaths && options.filepaths.length > 0) {
        if (this.fileContentService) {
          const fileContent = await this.fileContentService.gatherFileContent(options.filepaths);
          if (fileContent.length > 0) {
            fullPrompt = `Context from files:\n\n${fileContent}\n\n---\n\nUser request: ${options.userPrompt}`;
            filesIncluded = options.filepaths;
          }
        }
      }

      // Execute the prompt
      const generateOptions: GenerateOptions = {
        abortSignal: options.abortSignal,
        model,
        systemPrompt: options.systemPrompt,
        temperature: options.temperature,
        maxTokens: options.maxTokens,
        jsonMode: options.jsonMode,
        topP: options.topP,
        frequencyPenalty: options.frequencyPenalty,
        presencePenalty: options.presencePenalty,
        stopSequences: options.stopSequences,
        webSearch: options.webSearch,
        enableThinking: options.enableThinking,
        thinkingEffort: options.thinkingEffort
      };

      const result: LLMResponse = await adapter.generate(fullPrompt, generateOptions);

      return {
        success: true,
        response: result.text,
        model: result.model,
        provider: result.provider,
        usage: result.usage,
        cost: result.cost,
        filesIncluded,
        webSearchResults: result.webSearchResults
      };

    } catch (error) {
      console.error('LLMService.executePrompt failed:', error);
      console.error('Error details:', {
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        name: error instanceof Error ? error.name : undefined,
        toString: String(error)
      });
      
      return {
        success: false,
        error: `LLM execution failed: ${error instanceof Error ? error.message : 'Unknown error occurred'}. Check console for details.`
      };
    }
  }

  /** Set VaultOperations for file reading */
  setVaultOperations(vaultOperations: VaultOperations): void {
    this.fileContentService = new FileContentService(vaultOperations);
  }

  /** Test connection to a specific provider */
  async testProvider(provider: string): Promise<{ success: boolean; error?: string }> {
    try {
      const adapter = this.adapterRegistry.getAdapter(provider);
      if (!adapter) {
        return { success: false, error: `Provider '${provider}' is not configured` };
      }

      // Test with a simple prompt
      await adapter.generate('Hello', { maxTokens: 10 });
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  /** Get provider configuration */
  getProviderConfig(provider: string): LLMProviderConfig | undefined {
    return this.settings.providers[provider];
  }

  /** Get all provider configurations */
  getAllProviderConfigs(): { [providerId: string]: LLMProviderConfig } {
    return this.settings.providers;
  }

  /** Generate streaming LLM response with tool execution support */
  async* generateResponseStream(
    messages: Array<ConversationMessage>,
    options?: StreamingOptions
  ): AsyncGenerator<StreamYield, void, unknown> {
    const orchestrator = new StreamingOrchestrator(
      this.adapterRegistry,
      this.settings,
      this.toolExecutor
    );
    // Pass messages straight through — input is already `ConversationMessage[]`
    // post-M7, so the previous shallow-copy remap was a vestigial no-op. The
    // 5-field preservation (tool_call_id / tool_calls / reasoning_details /
    // thought_signature / name) is now guaranteed by type, not by an inline
    // mapper. See docs/plans/canonical-message-pipeline-plan.md (Phase 3).
    yield* orchestrator.generateResponseStream(messages, options);
  }

  /** Get a specific adapter instance for direct access */
  getAdapter(providerId: string): BaseAdapter | undefined {
    return this.adapterRegistry.getAdapter(providerId);
  }

  /** Wait for adapter initialization to complete (async providers like LM Studio) */
  async waitForInit(): Promise<void> {
    return this.adapterRegistry.waitForInit();
  }

  /** Clean up resources and unsubscribe from settings changes. */
  dispose(): void {
    this.unsubscribeFromSettings();
    this.adapterRegistry.clear();
  }

  /** Awaitable lifecycle hook used by ServiceContainer during plugin teardown. */
  async cleanup(): Promise<void> {
    this.unsubscribeFromSettings();
    await this.adapterRegistry.dispose();
  }

  private unsubscribeFromSettings(): void {
    if (this.settingsEventRef) {
      LLMSettingsNotifier.unsubscribe(this.settingsEventRef);
      this.settingsEventRef = null;
    }
  }

}
