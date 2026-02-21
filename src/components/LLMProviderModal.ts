/**
 * LLMProviderModal - Thin Orchestrator
 *
 * Modal for configuring LLM providers. Delegates to provider-specific
 * modal components based on the provider type.
 *
 * SOLID Refactoring: Reduced from 1,178 lines to ~150 lines.
 * Provider-specific logic extracted to:
 * - NexusProviderModal (WebLLM/local GPU)
 * - OllamaProviderModal (local server)
 * - LMStudioProviderModal (local server)
 * - GenericProviderModal (API-key providers)
 */

import { Modal, App, Component, Notice } from 'obsidian';
import { LLMProviderConfig } from '../types';
import { LLMProviderManager } from '../services/llm/providers/ProviderManager';
import { StaticModelsService } from '../services/StaticModelsService';
import {
  IProviderModal,
  ProviderModalConfig,
  ProviderModalDependencies,
} from './llm-provider/types';
import { NexusProviderModal } from './llm-provider/providers/NexusProviderModal';
import { OllamaProviderModal } from './llm-provider/providers/OllamaProviderModal';
import { LMStudioProviderModal } from './llm-provider/providers/LMStudioProviderModal';
import { GenericProviderModal } from './llm-provider/providers/GenericProviderModal';

/**
 * Configuration for LLMProviderModal
 * Kept for backward compatibility with existing callers
 */
export interface LLMProviderModalConfig {
  providerId: string;
  providerName: string;
  keyFormat: string;
  signupUrl: string;
  config: LLMProviderConfig;
  onSave: (config: LLMProviderConfig) => void;
}

/**
 * LLM Provider Configuration Modal
 * Thin orchestrator that delegates to provider-specific modal components
 */
export class LLMProviderModal extends Modal {
  private config: LLMProviderModalConfig;
  private providerManager: LLMProviderManager;
  private staticModelsService: StaticModelsService;

  // Provider-specific modal component
  private providerModal: IProviderModal | null = null;

  // Auto-save state
  private autoSaveTimeout: ReturnType<typeof setTimeout> | null = null;
  private saveStatusEl: HTMLElement | null = null;
  private component = new Component();

  constructor(app: App, config: LLMProviderModalConfig, providerManager: LLMProviderManager) {
    super(app);
    this.config = config;
    this.providerManager = providerManager;
    this.staticModelsService = StaticModelsService.getInstance();
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    this.component.load();
    contentEl.addClass('llm-provider-modal');

    // Modal title
    contentEl.createEl('h1', { text: `Configure ${this.config.providerName}` });

    // Provider content container
    const providerContainer = contentEl.createDiv('provider-modal-content');

    // Create provider-specific modal component
    this.providerModal = this.createProviderModal();
    this.providerModal.render(providerContainer);

    // Footer with status and close button
    this.createFooter(contentEl);
  }

  onClose(): void {
    this.component.unload();
    const { contentEl } = this;

    // Clean up provider modal
    if (this.providerModal) {
      this.providerModal.destroy();
      this.providerModal = null;
    }

    // Clean up auto-save timeout
    if (this.autoSaveTimeout) {
      clearTimeout(this.autoSaveTimeout);
      this.autoSaveTimeout = null;
    }

    contentEl.empty();
  }

  /**
   * Create the appropriate provider modal based on provider type
   */
  private createProviderModal(): IProviderModal {
    const deps = this.createDependencies();
    const modalConfig = this.createProviderConfig();

    switch (this.config.providerId) {
      case 'webllm':
        return new NexusProviderModal(modalConfig, deps);

      case 'ollama':
        return new OllamaProviderModal(modalConfig, deps);

      case 'lmstudio':
        return new LMStudioProviderModal(modalConfig, deps);

      default:
        return new GenericProviderModal(modalConfig, deps);
    }
  }

  /**
   * Create dependencies for provider modals
   */
  private createDependencies(): ProviderModalDependencies {
    return {
      app: this.app,
      vault: this.app.vault,
      providerManager: this.providerManager,
      staticModelsService: this.staticModelsService,
    };
  }

  /**
   * Create provider modal config
   */
  private createProviderConfig(): ProviderModalConfig {
    return {
      providerId: this.config.providerId,
      providerName: this.config.providerName,
      keyFormat: this.config.keyFormat,
      signupUrl: this.config.signupUrl,
      config: { ...this.config.config },
      onConfigChange: (config: LLMProviderConfig) => this.handleConfigChange(config),
    };
  }

  /**
   * Handle configuration changes from provider modals
   */
  private handleConfigChange(config: LLMProviderConfig): void {
    // Update local config
    this.config.config = config;

    // Auto-save with debouncing
    this.autoSave();
  }

  /**
   * Auto-save with debouncing and visual feedback
   */
  private autoSave(): void {
    if (this.autoSaveTimeout) {
      clearTimeout(this.autoSaveTimeout);
    }

    this.showSaveStatus('Saving...');

    this.autoSaveTimeout = setTimeout(() => {
      // Get final config from provider modal
      if (this.providerModal) {
        this.config.config = this.providerModal.getConfig();
      }

      // Call the save callback
      this.config.onSave(this.config.config);
      this.showSaveStatus('Saved');

      // Reset status after 2 seconds
      setTimeout(() => {
        this.showSaveStatus('Ready');
      }, 2000);
    }, 500);
  }

  /**
   * Create footer with status and close button
   */
  private createFooter(contentEl: HTMLElement): void {
    const footer = contentEl.createDiv('modal-status-container llm-provider-status-container');

    // Save status indicator
    this.saveStatusEl = footer.createDiv('save-status');
    this.showSaveStatus('Ready');

    // Close button
    const buttonContainer = footer.createDiv('modal-button-container');
    const closeBtn = buttonContainer.createEl('button', { text: 'Close', cls: 'mod-cta' });
    this.component.registerDomEvent(closeBtn, 'click', () => this.close());
  }

  /**
   * Show save status with visual feedback
   */
  private showSaveStatus(status: string): void {
    if (this.saveStatusEl) {
      this.saveStatusEl.textContent = status;
      this.saveStatusEl.className = `save-status save-status-${status.toLowerCase()}`;
    }
  }
}
