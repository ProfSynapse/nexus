/**
 * LMStudioProviderModal
 *
 * Provider modal for LM Studio - local LLM server with OpenAI-compatible API.
 * Handles server URL configuration and automatic model discovery.
 */

import { Setting, Notice, requestUrl } from 'obsidian';
import {
  IProviderModal,
  ProviderModalConfig,
  ProviderModalDependencies,
} from '../types';

export class LMStudioProviderModal implements IProviderModal {
  private config: ProviderModalConfig;
  private deps: ProviderModalDependencies;

  // UI elements
  private container: HTMLElement | null = null;
  private urlInput: HTMLInputElement | null = null;
  private discoverButton: HTMLButtonElement | null = null;
  private modelsContainer: HTMLElement | null = null;

  // State
  private serverUrl: string = 'http://127.0.0.1:1234';
  private discoveredModels: string[] = [];
  private isValidated: boolean = false;
  private validationTimeout: ReturnType<typeof setTimeout> | null = null;

  constructor(config: ProviderModalConfig, deps: ProviderModalDependencies) {
    this.config = config;
    this.deps = deps;

    // Initialize from existing config
    this.serverUrl = config.config.apiKey || 'http://127.0.0.1:1234';
  }

  /**
   * Render the LM Studio provider configuration UI
   */
  render(container: HTMLElement): void {
    this.container = container;
    container.empty();

    this.renderServerSection(container);
    this.renderModelsSection(container);
    this.renderHelpSection(container);
  }

  /**
   * Render server URL configuration section
   */
  private renderServerSection(container: HTMLElement): void {
    container.createEl('h2', { text: 'Server URL' });

    new Setting(container)
      .setDesc('Enter your LM Studio server URL (default: http://127.0.0.1:1234)')
      .addText(text => {
        this.urlInput = text.inputEl;
        this.urlInput.addClass('llm-provider-input');

        text
          .setPlaceholder('http://127.0.0.1:1234')
          .setValue(this.serverUrl)
          .onChange(value => {
            this.serverUrl = value;
            this.handleUrlChange(value);
          });
      })
      .addButton(button => {
        this.discoverButton = button.buttonEl;
        button
          .setButtonText('Discover Models')
          .setTooltip('Connect to LM Studio server and discover available models')
          .onClick(() => this.discoverModels());
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

      // Auto-discover after delay
      this.validationTimeout = setTimeout(() => {
        this.discoverModels();
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
   * Render models section
   */
  private renderModelsSection(container: HTMLElement): void {
    container.createEl('h2', { text: 'Models' });
    this.modelsContainer = container.createDiv('lmstudio-models-container');
    this.updateModelsDisplay();
  }

  /**
   * Update models display
   */
  private updateModelsDisplay(): void {
    if (!this.modelsContainer) return;
    this.modelsContainer.empty();

    const descDiv = this.modelsContainer.createDiv('setting-item-description');

    if (this.discoveredModels.length > 0) {
      const titleP = descDiv.createEl('p');
      titleP.createEl('strong', { text: `Discovered Models (${this.discoveredModels.length}):` });

      const ul = descDiv.createEl('ul');
      ul.style.margin = '0.5em 0';
      ul.style.paddingLeft = '1.5em';

      this.discoveredModels.forEach(model => {
        const li = ul.createEl('li');
        li.createEl('code', { text: model });
      });
    } else {
      const p = descDiv.createEl('p');
      p.createEl('em', { text: 'No models discovered yet. Click "Discover Models" to scan the server.' });
    }
  }

  /**
   * Render help section
   */
  private renderHelpSection(container: HTMLElement): void {
    const helpDiv = container.createDiv('setting-item');
    const descDiv = helpDiv.createDiv('setting-item-description');

    const details = descDiv.createEl('details');
    const summary = details.createEl('summary', { text: 'Setup Help' });
    summary.style.cursor = 'pointer';
    summary.style.fontWeight = '500';

    const contentDiv = details.createDiv();
    contentDiv.style.marginTop = '0.5em';
    contentDiv.style.paddingLeft = '1em';

    const titleP = contentDiv.createEl('p');
    titleP.createEl('strong', { text: 'To configure LM Studio:' });

    const ol = contentDiv.createEl('ol');
    ol.style.margin = '0.5em 0';
    ol.createEl('li', { text: 'Open LM Studio and load your desired model(s)' });
    ol.createEl('li', { text: 'Start the local server (usually on port 1234)' });
    ol.createEl('li', { text: 'Click "Discover Models" to fetch available models' });
    ol.createEl('li', { text: 'The first discovered model will be used by default' });
  }

  /**
   * Discover models from LM Studio server
   */
  private async discoverModels(): Promise<void> {
    const serverUrl = this.serverUrl.trim();

    if (!serverUrl) {
      new Notice('Please enter a server URL first');
      return;
    }

    // Validate URL format
    try {
      new URL(serverUrl);
    } catch {
      new Notice('Please enter a valid URL (e.g., http://127.0.0.1:1234)');
      return;
    }

    // Show discovering state
    if (this.discoverButton) {
      this.discoverButton.textContent = 'Discovering...';
      this.discoverButton.disabled = true;
    }

    try {
      // Query LM Studio's OpenAI-compatible /v1/models endpoint
      const modelsResponse = await requestUrl({
        url: `${serverUrl}/v1/models`,
        method: 'GET'
      });

      if (modelsResponse.status !== 200) {
        throw new Error(`Server not responding: ${modelsResponse.status}. Make sure LM Studio server is running.`);
      }

      const modelsData = modelsResponse.json;

      if (!modelsData.data || !Array.isArray(modelsData.data)) {
        throw new Error('Invalid response format from LM Studio server');
      }

      // Extract model IDs
      this.discoveredModels = modelsData.data.map((model: any) => model.id);

      if (this.discoveredModels.length === 0) {
        new Notice('No models loaded in LM Studio. Please load a model first.');
        return;
      }

      new Notice(`LM Studio connected! Discovered ${this.discoveredModels.length} model(s).`);

      this.isValidated = true;
      this.urlInput?.removeClass('validating');
      this.urlInput?.removeClass('error');
      this.urlInput?.addClass('success');

      // Save validated config
      this.config.config.apiKey = serverUrl;
      this.config.config.enabled = true;
      this.saveConfig();

      // Update models display
      this.updateModelsDisplay();

    } catch (error) {
      console.error('[LMStudioProvider] Discovery failed:', error);

      this.isValidated = false;
      this.urlInput?.removeClass('validating');
      this.urlInput?.removeClass('success');
      this.urlInput?.addClass('error');

      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      new Notice(`LM Studio discovery failed: ${errorMessage}`);
    } finally {
      if (this.discoverButton) {
        this.discoverButton.textContent = 'Discover Models';
        this.discoverButton.disabled = false;
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
    this.discoverButton = null;
    this.modelsContainer = null;
  }
}
