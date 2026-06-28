/**
 * OllamaProviderModal
 *
 * Provider modal for Ollama - local LLM server.
 * Handles server URL configuration and connection testing only.
 * Model selection happens in the chat / default-model settings, which
 * discovers installed models from the server.
 */

import { Setting, Notice, requestUrl } from 'obsidian';
import {
  IProviderModal,
  ProviderModalConfig,
  ProviderModalDependencies,
} from '../types';

interface OllamaTagsResponse {
  models: Array<{ name: string }>;
}

/** GET /api/ps response: currently-loaded models with their allocated context */
interface OllamaPsResponse {
  models: Array<{
    name: string;
    size?: number;
    size_vram?: number;
    context_length?: number;
  }>;
}

const CONTEXT_PRESETS: Array<{ label: string; value: number }> = [
  { label: '8K', value: 8192 },
  { label: '16K', value: 16384 },
  { label: '32K', value: 32768 },
  { label: '64K', value: 65536 },
];

export class OllamaProviderModal implements IProviderModal {
  private config: ProviderModalConfig;
  private deps: ProviderModalDependencies;

  // UI elements
  private container: HTMLElement | null = null;
  private urlInput: HTMLInputElement | null = null;
  private testButton: HTMLButtonElement | null = null;
  private contextInput: HTMLInputElement | null = null;
  private loadedStatusContainer: HTMLElement | null = null;
  private draftCountContainer: HTMLElement | null = null;

  // State
  private serverUrl = 'http://127.0.0.1:11434';
  private isValidated = false;
  private validationTimeout: number | null = null;

  constructor(config: ProviderModalConfig, deps: ProviderModalDependencies) {
    this.config = config;
    this.deps = deps;

    // Initialize from existing config
    this.serverUrl = config.config.apiKey || 'http://127.0.0.1:11434';
  }

  /**
   * Render the Ollama provider configuration UI
   */
  render(container: HTMLElement): void {
    this.container = container;
    container.empty();

    this.renderServerSection(container);
    this.renderContextSection(container);
    this.renderSpeculativeSection(container);
    this.renderTuningSection(container);
    this.renderHelpSection(container);

    // Show what's currently loaded (best-effort; silent if server is down)
    void this.refreshLoadedStatus();
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
          .setButtonText('Test connection')
          .setTooltip('Test connection to the Ollama server')
          .onClick(() => {
            void this.testConnection();
          });
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
      window.clearTimeout(this.validationTimeout);
      this.validationTimeout = null;
    }

    if (value.trim()) {
      this.urlInput?.addClass('validating');

      // Auto-validate after delay
      this.validationTimeout = window.setTimeout(() => {
        void this.testConnection();
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
   * Render context-length (num_ctx) configuration section.
   * Sent as `num_ctx` on every request; leaving it blank uses Ollama's own
   * server default (VRAM-based: ~4k/32k/256k).
   */
  private renderContextSection(container: HTMLElement): void {
    container.createEl('h2', { text: 'Context length' });

    // Quick presets
    const presetSetting = new Setting(container)
      .setName('Context length (num_ctx)')
      .setDesc('Max tokens Ollama keeps in context. Larger values need more memory; size it so the model stays 100% on GPU.');

    CONTEXT_PRESETS.forEach(preset => {
      presetSetting.addButton(button => {
        button.setButtonText(preset.label).onClick(() => {
          this.setContextLength(preset.value);
        });
      });
    });
    presetSetting.addButton(button => {
      button
        .setButtonText('Server default')
        .setTooltip('Clear the override and use the Ollama server default')
        .onClick(() => {
          this.setContextLength(undefined);
        });
    });

    // Custom numeric value
    new Setting(container)
      .setName('Custom value')
      .setDesc('Exact num_ctx in tokens. Leave blank to use the server default.')
      .addText(text => {
        this.contextInput = text.inputEl;
        text.inputEl.type = 'number';
        text.inputEl.setAttr('min', '0');
        text
          .setPlaceholder('Server default')
          .setValue(this.config.config.ollamaContextLength ? String(this.config.config.ollamaContextLength) : '')
          .onChange(value => {
            const trimmed = value.trim();
            if (trimmed === '') {
              this.config.config.ollamaContextLength = undefined;
            } else {
              const parsed = Number.parseInt(trimmed, 10);
              this.config.config.ollamaContextLength = Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
            }
            this.saveConfig();
          });
      });

    // Live status: what the server currently has loaded and at what context
    this.loadedStatusContainer = container.createDiv('setting-item-description');
    this.renderLoadedStatus(null);
  }

  /**
   * Apply a context-length value (or undefined to clear), syncing the input.
   */
  private setContextLength(value: number | undefined): void {
    this.config.config.ollamaContextLength = value;
    if (this.contextInput) {
      this.contextInput.value = value ? String(value) : '';
    }
    this.saveConfig();
  }

  /**
   * Render the "currently loaded" status from /api/ps results.
   * Passing null shows a neutral placeholder.
   */
  private renderLoadedStatus(data: OllamaPsResponse | null): void {
    const el = this.loadedStatusContainer;
    if (!el) return;
    el.empty();

    if (!data) {
      el.createEl('em', { text: 'Loaded models appear here after you test the connection.' });
      return;
    }

    if (data.models.length === 0) {
      el.createEl('em', { text: 'No models currently loaded on the server.' });
      return;
    }

    const titleP = el.createEl('p');
    titleP.createEl('strong', { text: 'Currently loaded:' });

    const ul = el.createEl('ul');
    ul.addClass('llm-provider-model-list');
    data.models.forEach(model => {
      const ctx = model.context_length ? `${model.context_length.toLocaleString()} ctx` : 'unknown ctx';
      const gpuPct = model.size && model.size_vram
        ? Math.round((model.size_vram / model.size) * 100)
        : undefined;
      const placement = gpuPct === undefined ? '' : ` · ${gpuPct}% GPU`;
      const li = ul.createEl('li');
      li.createEl('code', { text: model.name });
      li.appendText(` — ${ctx}${placement}`);
    });
  }

  /**
   * Fetch /api/ps and update the loaded-status display. Silent on failure.
   */
  private async refreshLoadedStatus(): Promise<void> {
    const serverUrl = this.serverUrl.trim();
    if (!serverUrl) return;
    try {
      new URL(serverUrl);
    } catch {
      return;
    }

    try {
      const response = await requestUrl({ url: `${serverUrl}/api/ps`, method: 'GET' });
      if (response.status !== 200) return;
      const data = this.parseJson(response.text);
      if (this.isOllamaPsResponse(data)) {
        this.renderLoadedStatus(data);
      }
    } catch {
      // Server not reachable — leave the placeholder in place
    }
  }

  /**
   * Render the speculative-decoding section. Ollama has no arbitrary draft-model
   * picker (unlike LM Studio): drafting only accelerates models that ship built-in
   * MTP tensors. This toggle sets `draft_num_predict` per request — on => N draft
   * tokens/step, off => 0 (disabled). It's a safe no-op on models without MTP.
   */
  private renderSpeculativeSection(container: HTMLElement): void {
    container.createEl('h2', { text: 'Speculative decoding' });

    new Setting(container)
      .setName('Enable speculative decoding')
      .setDesc('Drafts several tokens per step to speed up generation. Only helps models with built-in MTP/draft tensors (e.g. Qwen3-Next, GLM-4.6); it is harmless on other models. Ollama has no separate draft-model picker.')
      .addToggle(toggle => {
        toggle
          .setValue(this.config.config.ollamaSpeculativeDecoding === true)
          .onChange(value => {
            this.config.config.ollamaSpeculativeDecoding = value;
            this.saveConfig();
            this.updateDraftCountVisibility();
          });
      });

    // Draft-token count — only meaningful while speculative decoding is on.
    this.draftCountContainer = container.createDiv();
    new Setting(this.draftCountContainer)
      .setName('Draft tokens per step')
      .setDesc('How many tokens to draft each step (draft_num_predict). Default 4.')
      .addText(text => {
        text.inputEl.type = 'number';
        text.inputEl.setAttr('min', '1');
        text
          .setPlaceholder('4')
          .setValue(this.config.config.ollamaDraftNumPredict ? String(this.config.config.ollamaDraftNumPredict) : '')
          .onChange(value => {
            const trimmed = value.trim();
            if (trimmed === '') {
              this.config.config.ollamaDraftNumPredict = undefined;
            } else {
              const parsed = Number.parseInt(trimmed, 10);
              this.config.config.ollamaDraftNumPredict = Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
            }
            this.saveConfig();
          });
      });

    this.updateDraftCountVisibility();
  }

  /** Show the draft-token field only when speculative decoding is enabled. */
  private updateDraftCountVisibility(): void {
    if (!this.draftCountContainer) return;
    this.draftCountContainer.toggle(this.config.config.ollamaSpeculativeDecoding === true);
  }

  /**
   * Render server-side performance-tuning guidance. These are launch-time env
   * vars on the Ollama server itself — Nexus can't set them, so we surface the
   * recommended settings for fast, high-context inference on consumer hardware.
   */
  private renderTuningSection(container: HTMLElement): void {
    container.createEl('h2', { text: 'Performance tuning' });

    const descDiv = container.createDiv('setting-item-description');
    const details = descDiv.createEl('details');
    const summary = details.createEl('summary', { text: 'Server settings for fast, high-context inference' });
    summary.addClass('llm-provider-help-summary');

    const contentDiv = details.createDiv();
    contentDiv.addClass('llm-provider-help-content');

    const intro = contentDiv.createEl('p');
    intro.appendText('These are set on the Ollama server (not here). Launch the server with:');

    const pre = contentDiv.createEl('pre');
    pre.createEl('code', { text: 'OLLAMA_FLASH_ATTENTION=1 OLLAMA_KV_CACHE_TYPE=q8_0 ollama serve' });

    const ul = contentDiv.createEl('ul');
    ul.addClass('llm-provider-help-list');

    const li1 = ul.createEl('li');
    li1.createEl('strong', { text: 'Flash attention' });
    li1.appendText(' — faster, leaner attention at long context (required to quantize the cache).');

    const li2 = ul.createEl('li');
    li2.createEl('strong', { text: 'KV-cache quantization' });
    li2.appendText(' — q8_0 roughly halves context memory with near-zero quality loss (q4_0 saves more).');

    const li3 = ul.createEl('li');
    li3.createEl('strong', { text: 'Keep it 100% on GPU' });
    li3.appendText(' — check the status above (or "ollama ps"). If layers spill to CPU, lower the context length.');

    const note = contentDiv.createEl('p');
    note.createEl('em', { text: 'On macOS, set these with launchctl setenv (then restart Ollama); on Linux, set them in the Ollama systemd service (systemctl edit).' });
  }

  /**
   * Render help section
   */
  private renderHelpSection(container: HTMLElement): void {
    const helpDiv = container.createDiv('setting-item');
    const descDiv = helpDiv.createDiv('setting-item-description');

    const details = descDiv.createEl('details');
    const summary = details.createEl('summary', { text: 'Setup help' });
    summary.addClass('llm-provider-help-summary');

    const contentDiv = details.createDiv();
    contentDiv.addClass('llm-provider-help-content');

    const titleP = contentDiv.createEl('p');
    titleP.createEl('strong', { text: 'To configure Ollama:' });

    const ol = contentDiv.createEl('ol');
    ol.addClass('llm-provider-help-list');

    const li1 = ol.createEl('li');
    li1.appendText('Install a model: ');
    li1.createEl('code', { text: 'ollama pull [model-name]' });

    ol.createEl('li', { text: 'Common models: llama3.1, mistral, codellama, phi3, gemma' });

    ol.createEl('li', { text: 'Set the server URL above and test the connection' });

    ol.createEl('li', { text: 'Pick your installed model from the chat / default model settings' });
  }

  /**
   * Test connection to the Ollama server (verifies the server is reachable
   * and reports how many models are installed).
   */
  private async testConnection(): Promise<void> {
    const serverUrl = this.serverUrl.trim();

    if (!serverUrl) {
      new Notice('Please enter a server URL first');
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

      const serverData = this.parseJson(serverResponse.text);
      if (!this.isOllamaTagsResponse(serverData)) {
        throw new Error('Invalid response format from Ollama server');
      }

      const modelCount = serverData.models.length;
      new Notice(
        modelCount > 0
          ? `Ollama connected! Found ${modelCount} installed model(s). Select one in the chat / default model settings.`
          : 'Ollama connected, but no models are installed. Pull one with: ollama pull <model-name>'
      );

      this.isValidated = true;
      this.urlInput?.removeClass('validating');
      this.urlInput?.removeClass('error');
      this.urlInput?.addClass('success');

      // Save validated config
      this.config.config.apiKey = serverUrl;
      this.config.config.enabled = true;
      this.saveConfig();

      // Refresh the loaded-models / allocated-context display
      void this.refreshLoadedStatus();

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
        this.testButton.textContent = 'Test connection';
        this.testButton.disabled = false;
      }
    }
  }

  /**
   * Save configuration
   */
  private saveConfig(): void {
    void this.config.onConfigChange(this.config.config);
  }

  private parseJson(text: string): unknown {
    const parser = JSON.parse as (value: string) => unknown;
    return parser(text);
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
  }

  private isOllamaTagsResponse(value: unknown): value is OllamaTagsResponse {
    if (!this.isRecord(value)) {
      return false;
    }

    const models = value.models;
    return Array.isArray(models) && models.every(model => this.isRecord(model) && typeof model.name === 'string');
  }

  private isOllamaPsResponse(value: unknown): value is OllamaPsResponse {
    if (!this.isRecord(value)) {
      return false;
    }

    const models = value.models;
    return Array.isArray(models) && models.every(model => this.isRecord(model) && typeof model.name === 'string');
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
      window.clearTimeout(this.validationTimeout);
      this.validationTimeout = null;
    }

    this.container = null;
    this.urlInput = null;
    this.testButton = null;
    this.contextInput = null;
    this.loadedStatusContainer = null;
    this.draftCountContainer = null;
  }
}
