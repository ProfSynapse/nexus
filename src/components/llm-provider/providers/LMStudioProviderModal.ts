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

/** OpenAI-compatible /v1/models response (minimal — used as old-version fallback) */
interface LMStudioModelsResponse {
  data: Array<{ id: string }>;
}

/**
 * Native /api/v1/models response (current as of LM Studio 0.4.0+).
 * Richer than the OpenAI list: load state, allocated + max context, quantization.
 */
interface LMStudioV1ModelsResponse {
  models: Array<{
    key?: string;
    display_name?: string;
    type?: string;
    quantization?: { name?: string } | string;
    max_context_length?: number;
    loaded_instances?: Array<{ config?: { context_length?: number } }>;
  }>;
}

/**
 * REST /api/v0/models response (LM Studio 0.3.x+). Richest source: unlike the native
 * v1 endpoint (loaded instances only) it lists every downloaded model and reports the
 * model `type` (llm/vlm/embeddings) and `arch` (family) — the two fields we need to
 * gate speculative-decoding draft choices (drafts must be same-family text LLMs;
 * vision models can't speculate on the MLX engine at all).
 */
interface LMStudioV0ModelsResponse {
  data: Array<{
    id?: string;
    type?: string;
    arch?: string;
    compatibility_type?: string;
    quantization?: string;
    state?: string;
    max_context_length?: number;
    loaded_context_length?: number;
  }>;
}

interface LMStudioModelDetail {
  id: string;
  loaded?: boolean;
  /** Context the loaded instance was actually allocated (only when loaded) */
  loadedContextLength?: number;
  maxContextLength?: number;
  quantization?: string;
  /** 'llm' | 'vlm' | 'embeddings' (from /api/v0/models); undefined from older endpoints */
  type?: string;
  /** Architecture/family, e.g. 'qwen3' vs 'qwen3_5' — a proxy for tokenizer compatibility */
  arch?: string;
  /** 'mlx' | 'gguf' — the speculative-decoding vision limit is MLX-specific */
  compatibilityType?: string;
}

const CONTEXT_PRESETS: Array<{ label: string; value: number }> = [
  { label: '8K', value: 8192 },
  { label: '16K', value: 16384 },
  { label: '32K', value: 32768 },
  { label: '64K', value: 65536 },
];

export class LMStudioProviderModal implements IProviderModal {
  private config: ProviderModalConfig;
  private deps: ProviderModalDependencies;

  // UI elements
  private container: HTMLElement | null = null;
  private urlInput: HTMLInputElement | null = null;
  private discoverButton: HTMLButtonElement | null = null;
  private modelsContainer: HTMLElement | null = null;
  private performanceContainer: HTMLElement | null = null;
  private contextInput: HTMLInputElement | null = null;

  // State
  private serverUrl = 'http://127.0.0.1:1234';
  private discoveredModels: LMStudioModelDetail[] = [];
  private isValidated = false;
  private validationTimeout: number | null = null;

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
    this.renderPerformanceSection(container);
    this.renderTuningSection(container);
    this.renderHelpSection(container);

    // Auto-discover on open so the model list + draft-model dropdown populate without
    // requiring a manual "Discover models" click (quietly — no Notices on open).
    if (this.serverUrl.trim()) {
      void this.discoverModels(true);
    }
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
          .setButtonText('Discover models')
          .setTooltip('Connect to LM Studio server and discover available models')
          .onClick(() => {
            void this.discoverModels();
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

      // Auto-discover after delay
      this.validationTimeout = window.setTimeout(() => {
        void this.discoverModels();
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
   * Update models display - shows the models discovered on the server.
   * This is informational only (a connection check); model selection happens
   * in the chat / default-model settings.
   */
  private updateModelsDisplay(): void {
    if (!this.modelsContainer) return;
    this.modelsContainer.empty();

    const descDiv = this.modelsContainer.createDiv('setting-item-description');

    if (this.discoveredModels.length > 0) {
      const titleP = descDiv.createEl('p');
      titleP.createEl('strong', { text: `Discovered models (${this.discoveredModels.length}):` });

      const ul = descDiv.createEl('ul');
      ul.addClass('llm-provider-model-list');

      this.discoveredModels.forEach(model => {
        const li = ul.createEl('li');
        li.createEl('code', { text: model.id });

        const meta: string[] = [];
        if (model.loaded) meta.push('loaded');
        if (model.quantization) meta.push(model.quantization);
        if (model.loaded && model.loadedContextLength) {
          meta.push(`${model.loadedContextLength.toLocaleString()} ctx`);
        } else if (model.maxContextLength) {
          meta.push(`${model.maxContextLength.toLocaleString()} ctx max`);
        }
        if (meta.length > 0) {
          li.appendText(` — ${meta.join(' · ')}`);
        }
      });
    } else {
      const p = descDiv.createEl('p');
      p.createEl('em', { text: 'No models discovered yet. Click "discover models" to scan the server.' });
    }
  }

  /**
   * Render the load/inference controls Nexus applies automatically when you
   * chat: context length + flash attention (via /api/v1/models/load) and a
   * speculative-decoding draft model (per request). No need to open LM Studio.
   */
  private renderPerformanceSection(container: HTMLElement): void {
    container.createEl('h2', { text: 'Performance' });
    this.performanceContainer = container.createDiv();
    this.renderPerformanceControls();
  }

  private renderPerformanceControls(): void {
    const host = this.performanceContainer;
    if (!host) return;
    host.empty();

    const note = host.createDiv('setting-item-description');
    note.createEl('em', { text: 'Applied automatically the next time you chat with an LM Studio model.' });

    // Context length presets
    const presetSetting = new Setting(host)
      .setName('Context length')
      .setDesc('Loads the model at this many tokens. Larger needs more memory; keep GPU offload maxed.');
    CONTEXT_PRESETS.forEach(preset => {
      presetSetting.addButton(button => {
        button.setButtonText(preset.label).onClick(() => this.setContextLength(preset.value));
      });
    });
    presetSetting.addButton(button => {
      button
        .setButtonText('Default')
        .setTooltip('Clear the override and use the LM Studio default')
        .onClick(() => this.setContextLength(undefined));
    });

    // Custom context value
    new Setting(host)
      .setName('Custom value')
      .setDesc('Exact context length in tokens. Leave blank for the LM Studio default.')
      .addText(text => {
        this.contextInput = text.inputEl;
        text.inputEl.type = 'number';
        text.inputEl.setAttr('min', '0');
        text
          .setPlaceholder('Default')
          .setValue(this.config.config.lmstudioContextLength ? String(this.config.config.lmstudioContextLength) : '')
          .onChange(value => {
            const trimmed = value.trim();
            if (trimmed === '') {
              this.config.config.lmstudioContextLength = undefined;
            } else {
              const parsed = Number.parseInt(trimmed, 10);
              this.config.config.lmstudioContextLength = Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
            }
            this.saveConfig();
          });
      });

    // Flash attention
    new Setting(host)
      .setName('Flash attention')
      .setDesc('Faster, leaner attention at long context.')
      .addToggle(toggle => {
        toggle
          .setValue(this.config.config.lmstudioFlashAttention === true)
          .onChange(value => {
            this.config.config.lmstudioFlashAttention = value ? true : undefined;
            this.saveConfig();
          });
      });

    // Eligible drafts are small text LLMs. Vision (vlm) and embedding models can never
    // serve as a draft, and vision models can't be speculative *targets* on the MLX
    // engine at all — so we hide them from the picker. When `type` is unknown (older LM
    // Studio without /api/v0/models) we can't tell, so we keep the model rather than
    // wrongly hide it; the runtime guardrail still catches a bad pair.
    const eligibleDrafts = this.discoveredModels.filter(m => m.type !== 'vlm' && m.type !== 'embeddings');
    const visionModels = this.discoveredModels.filter(m => m.type === 'vlm');

    // Speculative decoding. The toggle state is its own boolean so it sticks even
    // before models are discovered; the draft model is a separate selection below.
    const specEnabled = this.config.config.lmstudioSpeculativeDecoding === true;
    new Setting(host)
      .setName('Speculative decoding')
      .setDesc('Pair the model with a smaller draft model of the same family to speed up generation.')
      .addToggle(toggle => {
        toggle.setValue(specEnabled).onChange(value => {
          this.config.config.lmstudioSpeculativeDecoding = value ? true : undefined;
          if (!value) {
            this.config.config.lmstudioDraftModel = undefined;
          } else if (!this.config.config.lmstudioDraftModel && eligibleDrafts.length > 0) {
            // Pre-fill with an eligible (text LLM) draft so there's a valid default
            this.config.config.lmstudioDraftModel = eligibleDrafts[0].id;
          }
          this.saveConfig();
          this.renderPerformanceControls();
          // No models yet? Kick off discovery so the dropdown can populate.
          if (value && this.discoveredModels.length === 0) {
            void this.discoverModels();
          }
        });
      });

    if (specEnabled) {
      if (eligibleDrafts.length === 0) {
        // Nothing valid to draft with — either no models discovered yet, or every
        // discovered model is a vision/embedding model that can't be a draft.
        new Setting(host)
          .setName('Draft model')
          .setDesc(this.discoveredModels.length === 0
            ? 'Discover models first to choose a draft model.'
            : 'No eligible draft models found. Speculative decoding needs a small text model from the same family as your chat model.');
      } else {
        new Setting(host)
          .setName('Draft model')
          .setDesc('Must share your chat model’s family and tokenizer — pick a small draft with the same family (shown in parentheses).')
          .addDropdown(dropdown => {
            eligibleDrafts.forEach(model => {
              dropdown.addOption(model.id, model.arch ? `${model.id} (${model.arch})` : model.id);
            });
            // If the saved draft was filtered out (e.g. it had been set to a vision
            // model before this gate existed), fall back to the first eligible draft.
            const saved = this.config.config.lmstudioDraftModel;
            const current = saved && eligibleDrafts.some(m => m.id === saved) ? saved : eligibleDrafts[0].id;
            dropdown.setValue(current);
            if (this.config.config.lmstudioDraftModel !== current) {
              this.config.config.lmstudioDraftModel = current;
              this.saveConfig(); // persist the defaulted/corrected selection so it takes effect
            }
            dropdown.onChange(value => {
              this.config.config.lmstudioDraftModel = value;
              this.saveConfig();
            });
          });
      }

      // Layer 2: name the vision models that can't benefit, since this provider-wide
      // card can't bind the toggle to one chat model. If the user's chat model is one
      // of these, the adapter skips speculative decoding automatically at runtime.
      if (visionModels.length > 0) {
        const warn = host.createDiv('setting-item-description');
        warn.addClass('llm-provider-draft-note');
        warn.appendText(
          `Vision models can’t use speculative decoding on the MLX engine: ${visionModels.map(m => m.id).join(', ')}. ` +
          'If your chat model is one of these, Nexus skips speculative decoding automatically.'
        );
      }

      const note = host.createDiv('setting-item-description');
      note.addClass('llm-provider-draft-note');
      note.appendText(
        'The draft and chat model must share a tokenizer — pick one from the same family and generation ' +
        '(the family is shown in parentheses; quantization need not match). If a pair is incompatible, ' +
        'Nexus turns speculative decoding off for that model and tells you, so chat keeps working.'
      );
    }
  }

  /**
   * Apply a context-length value (or undefined to clear), syncing the input.
   */
  private setContextLength(value: number | undefined): void {
    this.config.config.lmstudioContextLength = value;
    if (this.contextInput) {
      this.contextInput.value = value ? String(value) : '';
    }
    this.saveConfig();
  }

  /**
   * Render server-side performance-tuning guidance for the one thing Nexus
   * can't set over the API: KV-cache quantization (LM Studio UI / SDK only).
   */
  private renderTuningSection(container: HTMLElement): void {
    const descDiv = container.createDiv('setting-item-description');
    const details = descDiv.createEl('details');
    const summary = details.createEl('summary', { text: 'One more memory win (set in LM Studio)' });
    summary.addClass('llm-provider-help-summary');

    const contentDiv = details.createDiv();
    contentDiv.addClass('llm-provider-help-content');

    const intro = contentDiv.createEl('p');
    intro.appendText('Nexus applies context length, flash attention, and speculative decoding for you. The one knob LM Studio doesn’t expose to its API:');

    const ul = contentDiv.createEl('ul');
    ul.addClass('llm-provider-help-list');

    const li = ul.createEl('li');
    // eslint-disable-next-line obsidianmd/ui/sentence-case -- K/V are technical cache names
    li.createEl('strong', { text: 'K and V cache quantization' });
    li.appendText(' — in LM Studio’s model load settings, set both to Q8 (near-lossless) or Q4 (max savings) to roughly halve context memory and fit an even larger window.');
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
    titleP.createEl('strong', { text: 'To configure LM Studio:' });

    const ol = contentDiv.createEl('ol');
    ol.addClass('llm-provider-help-list');
    ol.createEl('li', { text: 'Open LM Studio and load your desired model(s)' });
    ol.createEl('li', { text: 'Start the local server (usually on port 1234)' });
    ol.createEl('li', { text: 'Click "discover models" to confirm the server is reachable' });
    ol.createEl('li', { text: 'Pick your model from the chat / default model settings' });
  }

  /**
   * Discover models from LM Studio server.
   * @param silent suppresses user-facing Notices — used for the automatic discovery
   *   that runs when the card opens, so populating the dropdowns isn't noisy.
   */
  private async discoverModels(silent = false): Promise<void> {
    const serverUrl = this.serverUrl.trim();

    if (!serverUrl) {
      if (!silent) new Notice('Please enter a server URL first');
      return;
    }

    // Validate URL format
    try {
      new URL(serverUrl);
    } catch {
      if (!silent) new Notice('Please enter a valid URL (e.g., http://127.0.0.1:1234)');
      return;
    }

    // Show discovering state
    if (this.discoverButton) {
      this.discoverButton.textContent = 'Discovering...';
      this.discoverButton.disabled = true;
    }

    try {
      this.discoveredModels = await this.fetchModels(serverUrl);

      if (this.discoveredModels.length === 0) {
        if (!silent) new Notice('No models loaded in LM Studio. Please load a model first.');
        this.renderPerformanceControls();
        return;
      }

      if (!silent) new Notice(`LM Studio connected! Discovered ${this.discoveredModels.length} model(s).`);

      this.isValidated = true;
      this.urlInput?.removeClass('validating');
      this.urlInput?.removeClass('error');
      this.urlInput?.addClass('success');

      // Save validated config
      this.config.config.apiKey = serverUrl;
      this.config.config.enabled = true;
      this.saveConfig();

      // Update models display + the draft-model dropdown options
      this.updateModelsDisplay();
      this.renderPerformanceControls();

    } catch (error) {
      console.error('[LMStudioProvider] Discovery failed:', error);

      this.isValidated = false;
      this.urlInput?.removeClass('validating');
      this.urlInput?.removeClass('success');
      this.urlInput?.addClass('error');

      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      if (!silent) new Notice(`LM Studio discovery failed: ${errorMessage}`);
    } finally {
      if (this.discoverButton) {
        this.discoverButton.textContent = 'Discover models';
        this.discoverButton.disabled = false;
      }
    }
  }

  /**
   * Fetch the model list, preferring LM Studio's native /api/v1/models
   * (load state, allocated + max context, quantization — current as of 0.4.0)
   * and falling back to the OpenAI-compatible /v1/models (ids only) for
   * older LM Studio versions.
   */
  private async fetchModels(serverUrl: string): Promise<LMStudioModelDetail[]> {
    // Prefer the REST /api/v0/models endpoint: it lists every downloaded model and
    // reports `type` (llm/vlm/embeddings) + `arch` (family), which we use to gate the
    // draft-model dropdown. Falls through to the native v1 / OpenAI endpoints if absent.
    try {
      const v0 = await requestUrl({ url: `${serverUrl}/api/v0/models`, method: 'GET' });
      if (v0.status === 200) {
        const data = this.parseJson(v0.text);
        if (this.isLMStudioV0Response(data)) {
          return data.data
            .filter(model => typeof model.id === 'string' && model.id)
            .map(model => ({
              id: model.id as string,
              loaded: model.state === 'loaded',
              loadedContextLength: model.state === 'loaded' ? model.loaded_context_length : undefined,
              maxContextLength: model.max_context_length,
              quantization: model.quantization,
              type: model.type,
              arch: model.arch,
              compatibilityType: model.compatibility_type,
            }));
        }
      }
    } catch {
      // /api/v0 unavailable — fall through to native v1
    }

    // Try the richer native v1 endpoint next
    try {
      const v1 = await requestUrl({ url: `${serverUrl}/api/v1/models`, method: 'GET' });
      if (v1.status === 200) {
        const data = this.parseJson(v1.text);
        if (this.isLMStudioV1Response(data)) {
          return data.models.map(model => {
            const instances = Array.isArray(model.loaded_instances) ? model.loaded_instances : [];
            const loaded = instances.length > 0;
            const quant = typeof model.quantization === 'string' ? model.quantization : model.quantization?.name;
            return {
              id: model.key ?? model.display_name ?? 'unknown',
              loaded,
              loadedContextLength: loaded ? instances[0]?.config?.context_length : undefined,
              maxContextLength: model.max_context_length,
              quantization: quant,
            };
          });
        }
      }
    } catch {
      // Native endpoint unavailable (older LM Studio) — fall through to OpenAI /v1
    }

    const modelsResponse = await requestUrl({ url: `${serverUrl}/v1/models`, method: 'GET' });
    if (modelsResponse.status !== 200) {
      throw new Error(`Server not responding: ${modelsResponse.status}. Make sure LM Studio server is running.`);
    }
    const modelsData = this.parseJson(modelsResponse.text);
    if (!this.isLMStudioModelsResponse(modelsData)) {
      throw new Error('Invalid response format from LM Studio server');
    }
    return modelsData.data.map(model => ({ id: model.id }));
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

  private isLMStudioModelsResponse(value: unknown): value is LMStudioModelsResponse {
    if (!this.isRecord(value)) {
      return false;
    }

    const models = value.data;
    return Array.isArray(models) && models.every(model => this.isRecord(model) && typeof model.id === 'string');
  }

  private isLMStudioV0Response(value: unknown): value is LMStudioV0ModelsResponse {
    if (!this.isRecord(value)) {
      return false;
    }

    const models = value.data;
    return Array.isArray(models) && models.every(model => this.isRecord(model) && typeof model.id === 'string');
  }

  private isLMStudioV1Response(value: unknown): value is LMStudioV1ModelsResponse {
    if (!this.isRecord(value)) {
      return false;
    }

    const models = value.models;
    return Array.isArray(models) && models.every(model =>
      this.isRecord(model) && (typeof model.key === 'string' || typeof model.display_name === 'string')
    );
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
    this.discoverButton = null;
    this.modelsContainer = null;
    this.performanceContainer = null;
    this.contextInput = null;
  }
}
