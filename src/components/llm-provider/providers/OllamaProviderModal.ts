/**
 * OllamaProviderModal
 *
 * Provider modal for Ollama - local LLM server.
 * Handles server URL configuration, model name input, and connection testing.
 */

import { Setting, Notice, requestUrl } from 'obsidian';
import {
  IProviderModal,
  ProviderModalConfig,
  ProviderModalDependencies,
} from '../types';

export class OllamaProviderModal implements IProviderModal {
  private config: ProviderModalConfig;
  private deps: ProviderModalDependencies;

  // UI elements
  private container: HTMLElement | null = null;
  private urlInput: HTMLInputElement | null = null;
  private modelInput: HTMLInputElement | null = null;
  private testButton: HTMLButtonElement | null = null;

  // State
  private serverUrl: string = 'http://127.0.0.1:11434';
  private modelName: string = '';
  private isValidated: boolean = false;
  private validationTimeout: ReturnType<typeof setTimeout> | null = null;

  constructor(config: ProviderModalConfig, deps: ProviderModalDependencies) {
    this.config = config;
    this.deps = deps;

    // Initialize from existing config
    this.serverUrl = config.config.apiKey || 'http://127.0.0.1:11434';
    this.modelName = config.config.ollamaModel || '';
  }

  /**
   * Render the Ollama provider configuration UI
   */
  render(container: HTMLElement): void {
    this.container = container;
    container.empty();

    this.renderServerSection(container);
    this.renderModelSection(container);
    this.renderHelpSection(container);
  }

  /**
   * Render server URL configuration section
   */
  private renderServerSection(container: HTMLElement): void {
    container.createEl('h2', { text: 'Server URL' });

    new Setting(container)
      .setDesc('Enter your Ollama server URL (default: http://127.0.0.1:11434)')
      .addText(text => {
        this.urlInput = text.inputEl;
        this.urlInput.addClass('llm-provider-input');

        text
          .setPlaceholder('http://127.0.0.1:11434')
          .setValue(this.serverUrl)
          .onChange(value => {
            this.serverUrl = value;
            this.handleUrlChange(value);
          });
      })
      .addButton(button => {
        this.testButton = button.buttonEl;
        button
          .setButtonText('Test Connection')
          .setTooltip('Test connection to Ollama server with the configured model')
          .onClick(() => this.testConnection());
      });
  }

  /**
   * Handle URL input changes
   */
  private handleUrlChange(value: string): void {
    this.isValidated = false;

    if (this.urlInput) {
      this.urlInput.removeClass('success');
      this.urlInput.removeClass('error');
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
      this.urlInput?.addClass('validating');

      // Auto-validate after delay
      this.validationTimeout = setTimeout(() => {
        if (this.modelName.trim()) {
          this.testConnection();
        }
      }, 2000);

      // Auto-enable
      if (!this.config.config.enabled) {
        this.config.config.enabled = true;
        this.saveConfig();
      }
    } else {
      this.urlInput?.removeClass('validating');
    }
  }

  /**
   * Render model configuration section
   */
  private renderModelSection(container: HTMLElement): void {
    container.createEl('h2', { text: 'Model' });

    new Setting(container)
      .setName('Default Model')
      .setDesc('Enter the name of the Ollama model to use')
      .addText(text => {
        this.modelInput = text.inputEl;

        text
          .setPlaceholder('e.g., llama3.1, mistral, phi3')
          .setValue(this.modelName)
          .onChange(value => {
            this.modelName = value;
            this.config.config.ollamaModel = value;

            if (value.trim()) {
              this.saveConfig();
            }
          });
      });
  }

  /**
   * Render help section
   */
  private renderHelpSection(container: HTMLElement): void {
    const helpDiv = container.createDiv('setting-item');
    const descDiv = helpDiv.createDiv('setting-item-description');

    const details = descDiv.createEl('details');
    const summary = details.createEl('summary', { text: 'Setup Help' });
    summary.addClass('llm-provider-help-summary');

    const contentDiv = details.createDiv();
    contentDiv.addClass('llm-provider-help-content');

    const titleP = contentDiv.createEl('p');
    titleP.createEl('strong', { text: 'To configure Ollama:' });

    const ol = contentDiv.createEl('ol');
    ol.addClass('llm-provider-help-list');

    const li1 = ol.createEl('li');
    li1.appendText('Install the model: ');
    li1.createEl('code', { text: 'ollama pull [model-name]' });

    ol.createEl('li', { text: 'Common models: llama3.1, mistral, codellama, phi3, gemma' });

    const li3 = ol.createEl('li');
    li3.appendText('View installed models: ');
    li3.createEl('code', { text: 'ollama list' });

    ol.createEl('li', { text: 'Enter the exact model name above' });
  }

  /**
   * Test connection to Ollama server
   */
  private async testConnection(): Promise<void> {
    const serverUrl = this.serverUrl.trim();
    const modelName = this.modelName.trim();

    if (!serverUrl) {
      new Notice('Please enter a server URL first');
      return;
    }

    if (!modelName) {
      new Notice('Please enter a model name first');
      return;
    }

    // Validate URL format
    try {
      new URL(serverUrl);
    } catch {
      new Notice('Please enter a valid URL (e.g., http://127.0.0.1:11434)');
      return;
    }

    // Show testing state
    if (this.testButton) {
      this.testButton.textContent = 'Testing...';
      this.testButton.disabled = true;
    }

    try {
      // Test if server is running
      const serverResponse = await requestUrl({
        url: `${serverUrl}/api/tags`,
        method: 'GET'
      });

      if (serverResponse.status !== 200) {
        throw new Error(`Server not responding: ${serverResponse.status}`);
      }

      // Check if model is available
      const serverData = serverResponse.json;
      const availableModels = serverData.models || [];
      const modelExists = availableModels.some((model: any) => model.name === modelName);

      if (!modelExists) {
        const modelList = availableModels.map((m: any) => m.name).join(', ') || 'none';
        new Notice(`Model '${modelName}' not found. Available: ${modelList}`);
        return;
      }

      // Test model with simple generation
      const testResponse = await requestUrl({
        url: `${serverUrl}/api/generate`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: modelName,
          prompt: 'Hello',
          stream: false,
          options: { num_predict: 5 }
        })
      });

      if (testResponse.status !== 200) {
        throw new Error(`Model test failed: ${testResponse.status}`);
      }

      const testData = testResponse.json;
      if (testData.response) {
        new Notice(`Ollama connection successful! Model '${modelName}' is working.`);

        this.isValidated = true;
        this.urlInput?.removeClass('validating');
        this.urlInput?.removeClass('error');
        this.urlInput?.addClass('success');

        // Save validated config
        this.config.config.apiKey = serverUrl;
        this.config.config.enabled = true;
        this.config.config.ollamaModel = this.modelName;
        this.saveConfig();
      } else {
        throw new Error('Model test returned invalid response');
      }

    } catch (error) {
      console.error('[OllamaProvider] Connection test failed:', error);

      this.isValidated = false;
      this.urlInput?.removeClass('validating');
      this.urlInput?.removeClass('success');
      this.urlInput?.addClass('error');

      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      new Notice(`Ollama test failed: ${errorMessage}`);
    } finally {
      if (this.testButton) {
        this.testButton.textContent = 'Test Connection';
        this.testButton.disabled = false;
      }
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
      apiKey: this.serverUrl,
      ollamaModel: this.modelName,
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
    this.urlInput = null;
    this.modelInput = null;
    this.testButton = null;
  }
}
