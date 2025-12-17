/**
 * GenericProviderModal
 *
 * Provider modal for API-key based providers (OpenAI, Anthropic, Google, etc.).
 * Handles API key input, validation, and model toggles.
 */

import { Setting, Notice } from 'obsidian';
import {
  IProviderModal,
  ProviderModalConfig,
  ProviderModalDependencies,
} from '../types';
import { LLMValidationService } from '../../../services/llm/validation/ValidationService';
import { ModelWithProvider } from '../../../services/StaticModelsService';

export class GenericProviderModal implements IProviderModal {
  private config: ProviderModalConfig;
  private deps: ProviderModalDependencies;

  // UI elements
  private container: HTMLElement | null = null;
  private apiKeyInput: HTMLInputElement | null = null;
  private modelsContainer: HTMLElement | null = null;

  // State
  private apiKey: string = '';
  private models: ModelWithProvider[] = [];
  private isValidated: boolean = false;
  private validationTimeout: ReturnType<typeof setTimeout> | null = null;

  constructor(config: ProviderModalConfig, deps: ProviderModalDependencies) {
    this.config = config;
    this.deps = deps;

    // Initialize from existing config
    this.apiKey = config.config.apiKey || '';
  }

  /**
   * Render the generic provider configuration UI
   */
  render(container: HTMLElement): void {
    this.container = container;
    container.empty();

    this.renderApiKeySection(container);
    this.renderModelsSection(container);
  }

  /**
   * Render API key input section
   */
  private renderApiKeySection(container: HTMLElement): void {
    container.createEl('h2', { text: 'API Key' });

    new Setting(container)
      .setDesc(`Enter your ${this.config.providerName} API key (format: ${this.config.keyFormat})`)
      .addText(text => {
        this.apiKeyInput = text.inputEl;
        this.apiKeyInput.type = 'password';
        this.apiKeyInput.addClass('llm-provider-input');

        text
          .setPlaceholder(`Enter your ${this.config.providerName} API key`)
          .setValue(this.apiKey)
          .onChange(value => {
            this.apiKey = value;
            this.handleApiKeyChange(value);
          });
      })
      .addButton(button => {
        button
          .setButtonText('Get Key')
          .setTooltip(`Open ${this.config.providerName} API key page`)
          .onClick(() => {
            window.open(this.config.signupUrl, '_blank');
          });
      });
  }

  /**
   * Handle API key input changes
   */
  private handleApiKeyChange(value: string): void {
    this.isValidated = false;

    if (this.apiKeyInput) {
      this.apiKeyInput.removeClass('success');
      this.apiKeyInput.removeClass('error');
    }

    // Clear validation cache
    this.config.config.lastValidated = undefined;
    this.config.config.validationHash = undefined;

    // Clear existing timeout
    if (this.validationTimeout) {
      clearTimeout(this.validationTimeout);
      this.validationTimeout = null;
    }

    if (value.trim()) {
      this.apiKeyInput?.addClass('validating');

      // Auto-validate after delay
      this.validationTimeout = setTimeout(() => {
        this.validateApiKey();
      }, 2000);

      // Auto-enable
      if (!this.config.config.enabled) {
        this.config.config.enabled = true;
        this.saveConfig();
      }
    } else {
      this.apiKeyInput?.removeClass('validating');
    }
  }

  /**
   * Render models section
   */
  private renderModelsSection(container: HTMLElement): void {
    container.createEl('h2', { text: 'Available Models' });
    this.modelsContainer = container.createDiv('models-container');

    this.loadModels();
  }

  /**
   * Load models from static service
   */
  private loadModels(): void {
    if (!this.modelsContainer) return;

    try {
      this.models = this.deps.staticModelsService.getModelsForProvider(this.config.providerId);
      this.displayModels();
    } catch (error) {
      console.error('[GenericProvider] Error loading models:', error);
      this.modelsContainer.empty();
      const errorDiv = this.modelsContainer.createDiv('models-error');
      const titleP = errorDiv.createEl('p');
      titleP.createEl('strong', { text: 'Error loading models:' });
      errorDiv.createEl('p', { text: error instanceof Error ? error.message : 'Unknown error' });
    }
  }

  /**
   * Display loaded models with toggles
   */
  private displayModels(): void {
    if (!this.modelsContainer) return;
    this.modelsContainer.empty();

    if (this.models.length === 0) {
      this.modelsContainer.createDiv('models-empty')
        .textContent = 'No models available. Check your API key and try again.';
      return;
    }

    const modelsList = this.modelsContainer.createDiv('models-list');

    this.models.forEach(model => {
      const modelEl = modelsList.createDiv('model-item');

      const modelRow = modelEl.createDiv('model-row llm-provider-model-row');
      modelRow.style.display = 'flex';
      modelRow.style.justifyContent = 'space-between';
      modelRow.style.alignItems = 'center';

      // Model name
      const modelNameEl = modelRow.createDiv('model-name llm-provider-model-name');
      modelNameEl.textContent = model.name;

      // Model toggle
      const currentEnabled = this.config.config.models?.[model.id]?.enabled ?? true;
      const toggleContainer = modelRow.createDiv('model-toggle-container');
      toggleContainer.style.marginLeft = 'auto';

      new Setting(toggleContainer)
        .addToggle(toggle => toggle
          .setValue(currentEnabled)
          .onChange(enabled => {
            // Initialize models object if needed
            if (!this.config.config.models) {
              this.config.config.models = {};
            }
            if (!this.config.config.models[model.id]) {
              this.config.config.models[model.id] = { enabled: true };
            }

            this.config.config.models[model.id].enabled = enabled;
            this.saveConfig();
          })
        );
    });
  }

  /**
   * Validate API key
   */
  private async validateApiKey(): Promise<void> {
    const apiKey = this.apiKey.trim();

    if (!apiKey) {
      new Notice('Please enter an API key first');
      return;
    }

    this.apiKeyInput?.removeClass('success');
    this.apiKeyInput?.removeClass('error');
    this.apiKeyInput?.addClass('validating');

    try {
      const result = await LLMValidationService.validateApiKey(
        this.config.providerId,
        apiKey,
        {
          forceValidation: true,
          providerConfig: this.config.config,
          onValidationSuccess: (hash: string, timestamp: number) => {
            this.config.config.lastValidated = timestamp;
            this.config.config.validationHash = hash;
          }
        }
      );

      if (result.success) {
        this.isValidated = true;
        this.apiKeyInput?.removeClass('validating');
        this.apiKeyInput?.removeClass('error');
        this.apiKeyInput?.addClass('success');

        this.config.config.apiKey = apiKey;
        this.config.config.enabled = true;
        this.saveConfig();

        new Notice(`${this.config.providerName} API key validated successfully!`);
      } else {
        throw new Error(result.error || 'API key validation failed');
      }

    } catch (error) {
      console.error('[GenericProvider] Validation failed:', error);

      this.isValidated = false;
      this.apiKeyInput?.removeClass('validating');
      this.apiKeyInput?.removeClass('success');
      this.apiKeyInput?.addClass('error');

      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      new Notice(`${this.config.providerName} API key validation failed: ${errorMessage}`);
    }
  }

  /**
   * Save configuration
   */
  private saveConfig(): void {
    this.config.onConfigChange(this.config.config);
  }

  /**
   * Get current configuration
   */
  getConfig(): import('../../../types').LLMProviderConfig {
    return {
      ...this.config.config,
      apiKey: this.apiKey,
    };
  }

  /**
   * Clean up resources
   */
  destroy(): void {
    if (this.validationTimeout) {
      clearTimeout(this.validationTimeout);
      this.validationTimeout = null;
    }

    this.container = null;
    this.apiKeyInput = null;
    this.modelsContainer = null;
  }
}
