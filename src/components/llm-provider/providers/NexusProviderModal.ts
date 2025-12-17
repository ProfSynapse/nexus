/**
 * NexusProviderModal
 *
 * Minimal modal for Nexus model management.
 * Handles: GPU detection, model download, cache management.
 * Does NOT handle: Loading models to GPU (done in ChatView).
 */

import { Setting, Notice } from 'obsidian';
import {
  IProviderModal,
  ProviderModalConfig,
  ProviderModalDependencies,
} from '../types';
import { WebLLMVRAMDetector } from '../../../services/llm/adapters/webllm/WebLLMVRAMDetector';
import { WebLLMAdapter } from '../../../services/llm/adapters/webllm/WebLLMAdapter';
import { VRAMInfo, WebLLMModelSpec } from '../../../services/llm/adapters/webllm/types';
import { WEBLLM_MODELS, getModelsForVRAM, getWebLLMModel } from '../../../services/llm/adapters/webllm/WebLLMModels';

type DeviceStatus = 'checking' | 'compatible' | 'limited' | 'incompatible';

/**
 * Extended HTMLElement with download progress tracking properties.
 * These properties are attached to the action area container to enable
 * live UI updates during download without full re-renders.
 */
interface ActionAreaWithProgress extends HTMLElement {
  _progressFill?: HTMLElement;
  _statusText?: HTMLElement;
}

export class NexusProviderModal implements IProviderModal {
  private config: ProviderModalConfig;

  // UI containers
  private deviceCard: HTMLElement | null = null;
  private modelSection: HTMLElement | null = null;
  private actionArea: ActionAreaWithProgress | null = null;

  // State
  private vramInfo: VRAMInfo | null = null;
  private adapter: WebLLMAdapter | null = null;
  private selectedModelId: string = '';
  private cachedModels: Map<string, boolean> = new Map();
  private isDownloading: boolean = false;
  private downloadProgress: number = 0;
  private downloadStage: string = '';

  constructor(config: ProviderModalConfig, deps: ProviderModalDependencies) {
    this.config = config;
    this.selectedModelId = config.config.webllmModel || WEBLLM_MODELS[0]?.id || '';
    this.adapter = new WebLLMAdapter(deps.vault);
  }

  /**
   * Main render entry point
   */
  render(container: HTMLElement): void {
    container.empty();
    container.addClass('nexus-modal');

    // Description at top
    container.createEl('p', {
      text: 'Run AI locally on your device. Works offline, completely private, no API costs.',
      cls: 'nexus-description'
    });

    // Device card
    this.deviceCard = container.createDiv('nexus-device-card');
    this.renderDeviceCard('checking');

    // Model section (hidden until device check complete)
    this.modelSection = container.createDiv('nexus-model-section');
    this.modelSection.addClass('llm-provider-hidden');

    // Start device detection
    this.detectDevice();
  }

  /**
   * Detect GPU capabilities and update UI
   */
  private async detectDevice(): Promise<void> {
    try {
      this.vramInfo = await WebLLMVRAMDetector.detect();

      if (!this.vramInfo.webGPUSupported) {
        this.renderDeviceCard('incompatible');
        return;
      }

      const availableModels = getModelsForVRAM(this.vramInfo.estimatedVRAM);

      if (availableModels.length === 0) {
        this.renderDeviceCard('limited');
        return;
      }

      // Check cache for all compatible models
      await this.checkAllModelCache(availableModels);

      this.renderDeviceCard('compatible');

      // Auto-enable provider
      if (!this.config.config.enabled) {
        this.config.config.enabled = true;
        this.config.onConfigChange(this.config.config);
      }

      // Show model section
      if (this.modelSection) {
        this.modelSection.removeClass('llm-provider-hidden');
        this.modelSection.addClass('llm-provider-visible');
        this.renderModelSection(availableModels);
      }

    } catch (error) {
      console.error('[NexusModal] Device detection failed:', error);
      this.renderDeviceCard('incompatible', error instanceof Error ? error.message : 'Detection failed');
    }
  }

  /**
   * Render device status - only show if there's a problem
   */
  private renderDeviceCard(status: DeviceStatus, errorMessage?: string): void {
    if (!this.deviceCard) return;
    this.deviceCard.empty();

    // Only show status for checking, limited, or incompatible
    if (status === 'checking') {
      const row = this.deviceCard.createDiv('nexus-device-row');
      row.createSpan({ text: '◌', cls: 'nexus-device-icon nexus-icon-spin' });
      row.createSpan({ text: 'Checking compatibility...', cls: 'nexus-device-text' });
      return;
    }

    if (status === 'compatible') {
      // Don't show anything - everything is fine
      return;
    }

    if (status === 'limited') {
      const row = this.deviceCard.createDiv('nexus-device-row nexus-device-warning');
      row.createSpan({ text: '⚠', cls: 'nexus-device-icon' });
      row.createSpan({ text: 'Limited GPU memory - smaller models only', cls: 'nexus-device-text' });
      return;
    }

    // Incompatible
    const row = this.deviceCard.createDiv('nexus-device-row nexus-device-error');
    row.createSpan({ text: '✗', cls: 'nexus-device-icon' });
    row.createSpan({
      text: errorMessage || 'WebGPU not supported (requires Chrome 113+, Edge 113+, or Safari 17+)',
      cls: 'nexus-device-text'
    });
  }

  /**
   * Check browser cache for all models
   */
  private async checkAllModelCache(models: WebLLMModelSpec[]): Promise<void> {
    for (const model of models) {
      const isCached = await this.isModelCached(model.id);
      this.cachedModels.set(model.id, isCached);
    }
  }

  /**
   * Check if a specific model is cached
   */
  private async isModelCached(modelId: string): Promise<boolean> {
    try {
      if (!('caches' in window)) return false;

      const cacheNames = await caches.keys();

      // WebLLM uses cache names containing the model ID
      return cacheNames.some(name => {
        const lowerName = name.toLowerCase();
        const lowerModelId = modelId.toLowerCase();
        return lowerName.includes('webllm') ||
               lowerName.includes('tvmjs') ||
               lowerName.includes(lowerModelId);
      });
    } catch {
      return false;
    }
  }

  /**
   * Render model selection section
   */
  private renderModelSection(availableModels: WebLLMModelSpec[]): void {
    if (!this.modelSection) return;
    this.modelSection.empty();

    // Ensure selected model is valid
    const selectedModel = getWebLLMModel(this.selectedModelId) || availableModels[0];
    if (selectedModel) {
      this.selectedModelId = selectedModel.id;
    }

    // Model dropdown
    const dropdownContainer = this.modelSection.createDiv('nexus-dropdown-container');
    dropdownContainer.createEl('label', { text: 'Model', cls: 'nexus-label' });

    new Setting(dropdownContainer)
      .addDropdown(dropdown => {
        availableModels.forEach(model => {
          dropdown.addOption(model.id, model.name);
        });

        dropdown.setValue(this.selectedModelId);
        dropdown.onChange(async (value) => {
          this.selectedModelId = value;
          this.config.config.webllmModel = value;

          // Extract quantization
          const match = value.match(/(q[458]f16)/);
          if (match) {
            this.config.config.webllmQuantization = match[1] as 'q4f16' | 'q5f16' | 'q8f16';
          }

          this.config.onConfigChange(this.config.config);
          this.renderActionArea();
        });
      });

    // Action area
    this.actionArea = this.modelSection.createDiv('nexus-action-area') as ActionAreaWithProgress;
    this.renderActionArea();
  }

  /**
   * Render action area based on current state
   */
  private renderActionArea(): void {
    if (!this.actionArea) return;
    this.actionArea.empty();

    const model = getWebLLMModel(this.selectedModelId);
    if (!model) return;

    const isCached = this.cachedModels.get(this.selectedModelId) || false;

    if (this.isDownloading) {
      this.renderDownloadProgress();
    } else if (isCached) {
      this.renderDownloadedState();
    } else {
      this.renderDownloadButton(model);
    }
  }

  /**
   * Render download button using native Obsidian Setting
   */
  private renderDownloadButton(model: WebLLMModelSpec): void {
    if (!this.actionArea) return;

    new Setting(this.actionArea)
      .setClass('nexus-download-setting')
      .addButton(button => button
        .setButtonText(`Download · ${model.vramRequired} GB`)
        .setCta()
        .onClick(() => this.startDownload(model)));
  }

  /**
   * Render downloaded state - just delete button (dropdown already shows "Saved")
   */
  private renderDownloadedState(): void {
    if (!this.actionArea) return;

    new Setting(this.actionArea)
      .setClass('nexus-delete-setting')
      .addButton(button => {
        const btn = button
          .setButtonText('Delete from cache')
          .setWarning()
          .onClick(async () => {
            btn.setButtonText('Deleting...');
            btn.setDisabled(true);

            try {
              await this.clearModelCache();
              this.cachedModels.set(this.selectedModelId, false);
              new Notice('Model deleted from cache');
              this.renderActionArea();
            } catch (error) {
              new Notice(`Failed to delete: ${error instanceof Error ? error.message : 'Unknown error'}`);
              btn.setButtonText('Delete from cache');
              btn.setDisabled(false);
            }
          });
        return btn;
      });
  }

  /**
   * Render download progress
   */
  private renderDownloadProgress(): void {
    if (!this.actionArea) return;

    const container = this.actionArea.createDiv('nexus-progress-container');

    // Progress bar
    const barBg = container.createDiv('nexus-progress-bar');
    const barFill = barBg.createDiv('nexus-progress-fill');
    barFill.addClass('llm-provider-progress-fill');
    barFill.style.width = `${this.downloadProgress}%`;

    // Status row with progress text
    const statusRow = container.createDiv('nexus-progress-row');
    const statusText = statusRow.createSpan({
      text: `${this.downloadStage} · ${this.downloadProgress}%`,
      cls: 'nexus-progress-text'
    });

    // Cancel button using Setting API for proper Obsidian styling
    new Setting(statusRow)
      .setClass('nexus-cancel-setting')
      .addButton(button => button
        .setButtonText('Cancel')
        .onClick(() => {
          this.isDownloading = false;
          this.downloadProgress = 0;
          this.downloadStage = '';
          this.renderActionArea();
        }));

    // Store references for live updates during download
    if (this.actionArea) {
      this.actionArea._progressFill = barFill;
      this.actionArea._statusText = statusText;
    }
  }

  /**
   * Start model download
   */
  private async startDownload(model: WebLLMModelSpec): Promise<void> {
    if (!this.adapter) return;

    this.isDownloading = true;
    this.downloadProgress = 0;
    this.downloadStage = 'Initializing';
    this.renderActionArea();

    try {
      await this.adapter.initialize();

      await this.adapter.loadModel(model, (progress: number, stage: string) => {
        if (!this.isDownloading) return; // Cancelled

        this.downloadProgress = Math.round(progress * 100);
        this.downloadStage = stage;

        // Update UI without full re-render
        if (this.actionArea) {
          const fill = this.actionArea._progressFill;
          const text = this.actionArea._statusText;
          if (fill) {
            fill.style.width = `${this.downloadProgress}%`;
          }
          if (text) {
            text.textContent = `${stage} · ${this.downloadProgress}%`;
          }
        }
      });

      // Download complete
      this.isDownloading = false;
      this.cachedModels.set(this.selectedModelId, true);

      // Unload from GPU - we only wanted to download
      if (this.adapter.isModelLoaded()) {
        await this.adapter.unloadModel();
      }

      new Notice(`${model.name} downloaded successfully!`);
      this.renderActionArea();

    } catch (error) {
      console.error('[NexusModal] Download failed:', error);
      this.isDownloading = false;
      new Notice(`Download failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
      this.renderActionArea();
    }
  }

  /**
   * Clear browser cache for WebLLM models
   */
  private async clearModelCache(): Promise<void> {
    if ('caches' in window) {
      const cacheNames = await caches.keys();
      for (const name of cacheNames) {
        if (name.includes('webllm') || name.includes('tvmjs') || name.includes('mlc')) {
          await caches.delete(name);
        }
      }
    }

    if ('indexedDB' in window) {
      const databases = await indexedDB.databases?.() || [];
      for (const db of databases) {
        if (db.name && (db.name.includes('webllm') || db.name.includes('tvmjs') || db.name.includes('mlc'))) {
          indexedDB.deleteDatabase(db.name);
        }
      }
    }
  }

  /**
   * Get current configuration
   */
  getConfig(): import('../../../types').LLMProviderConfig {
    return {
      ...this.config.config,
      webllmModel: this.selectedModelId,
    };
  }

  /**
   * Clean up resources
   */
  destroy(): void {
    this.deviceCard = null;
    this.modelSection = null;
    this.actionArea = null;
  }
}
