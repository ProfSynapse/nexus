/**
 * InlineEditModal - Modal UI for inline AI text editing
 *
 * Extends Obsidian's Modal class to provide a state-driven interface
 * for transforming selected text via LLM instructions.
 *
 * States:
 * - INPUT: Show selected text, instruction input, model selector
 * - LOADING: Show spinner, streaming preview, cancel button
 * - RESULT: Show editable result, Retry/Cancel/Apply buttons
 * - ERROR: Show error message, retry option
 */

import {
  App,
  Modal,
  Setting,
  Notice,
  ButtonComponent,
  TextAreaComponent,
  DropdownComponent,
  setIcon,
  Plugin
} from 'obsidian';
import { InlineEditService } from '../../services/InlineEditService';
import type {
  SelectionContext,
  InlineEditState,
  AvailableModel
} from './types';
import type { LLMService } from '../../services/llm/core/LLMService';
import type { Settings } from '../../settings';

/**
 * Plugin interface with settings property and registerDomEvent method
 */
interface PluginWithSettings extends Plugin {
  settings?: Settings;
  getService<T>(name: string, timeoutMs?: number): Promise<T | null>;
  registerDomEvent<K extends keyof WindowEventMap>(
    el: Window,
    type: K,
    callback: (this: HTMLElement, ev: WindowEventMap[K]) => unknown
  ): void;
  registerDomEvent<K extends keyof DocumentEventMap>(
    el: Document,
    type: K,
    callback: (this: HTMLElement, ev: DocumentEventMap[K]) => unknown
  ): void;
  registerDomEvent<K extends keyof HTMLElementEventMap>(
    el: HTMLElement,
    type: K,
    callback: (this: HTMLElement, ev: HTMLElementEventMap[K]) => unknown
  ): void;
}

export class InlineEditModal extends Modal {
  private service: InlineEditService;
  private selectionContext: SelectionContext;
  private plugin: PluginWithSettings;

  // UI element references
  private contentContainer: HTMLElement | null = null;
  private instructionInput: TextAreaComponent | null = null;
  private modelDropdown: DropdownComponent | null = null;
  private streamingPreview: HTMLElement | null = null;
  private resultTextarea: HTMLTextAreaElement | null = null;

  // State tracking
  private currentInstruction = '';
  private selectedProvider = '';
  private selectedModel = '';
  private availableModels: AvailableModel[] = [];

  constructor(
    app: App,
    plugin: PluginWithSettings,
    selectionContext: SelectionContext,
    service: InlineEditService
  ) {
    super(app);
    this.plugin = plugin;
    this.selectionContext = selectionContext;
    this.service = service;

    // Set up callbacks
    this.service.setCallbacks({
      onStateChange: (state) => this.renderState(state),
      onStreamChunk: (chunk) => this.updateStreamingPreview(chunk)
    });
  }

  async onOpen(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('claudesidian-inline-edit-modal');

    // Load available models
    await this.loadAvailableModels();

    // Set default model from settings
    this.setDefaultModel();

    // Initialize service with selected text
    this.service.initialize(this.selectionContext.selectedText);

    // Create container for dynamic content
    this.contentContainer = contentEl.createDiv('claudesidian-inline-edit-content');

    // Render initial state
    this.renderState(this.service.getState());
  }

  /**
   * Load available models from LLM service
   */
  private async loadAvailableModels(): Promise<void> {
    try {
      const llmService = await this.plugin.getService<LLMService>('llmService');
      if (!llmService) {
        return;
      }

      const models = await llmService.getAvailableModels();
      this.availableModels = models.map(m => ({
        providerId: m.provider,
        modelId: m.id,
        displayName: `${m.provider}: ${m.name || m.id}`
      }));
    } catch (error) {
      console.error('[InlineEditModal] Failed to load models:', error);
    }
  }

  /**
   * Set default model from plugin settings
   */
  private setDefaultModel(): void {
    const llmSettings = this.plugin.settings?.settings?.llmProviders;
    if (llmSettings?.defaultModel) {
      this.selectedProvider = llmSettings.defaultModel.provider;
      this.selectedModel = llmSettings.defaultModel.model;
    } else if (this.availableModels.length > 0) {
      this.selectedProvider = this.availableModels[0].providerId;
      this.selectedModel = this.availableModels[0].modelId;
    }
  }

  /**
   * Render UI based on current state
   */
  private renderState(state: InlineEditState): void {
    if (!this.contentContainer) return;
    this.contentContainer.empty();

    switch (state.phase) {
      case 'input':
        this.renderInputState(state.selectedText);
        break;
      case 'loading':
        this.renderLoadingState(state.progress, state.streamedText);
        break;
      case 'result':
        this.renderResultState(state.original, state.edited);
        break;
      case 'error':
        this.renderErrorState(state.message, state.lastInstruction);
        break;
    }
  }

  /**
   * Render INPUT state
   */
  private renderInputState(selectedText: string): void {
    if (!this.contentContainer) return;
    const container = this.contentContainer;

    // Header
    container.createEl('h2', { text: 'Edit with AI', cls: 'claudesidian-inline-edit-header' });

    // Selected text preview (read-only)
    const previewSection = container.createDiv('claudesidian-inline-edit-section');
    previewSection.createEl('label', { text: 'Selected Text', cls: 'claudesidian-inline-edit-label' });

    const previewContainer = previewSection.createDiv('claudesidian-inline-edit-preview');
    const previewText = previewContainer.createEl('pre', {
      cls: 'claudesidian-inline-edit-preview-text'
    });
    previewText.textContent = this.truncateText(selectedText, 500);

    // Instruction input
    const instructionSection = container.createDiv('claudesidian-inline-edit-section');
    instructionSection.createEl('label', { text: 'Instruction', cls: 'claudesidian-inline-edit-label' });

    new Setting(instructionSection)
      .setClass('claudesidian-inline-edit-instruction-setting')
      .addTextArea((textarea) => {
        this.instructionInput = textarea;
        textarea
          .setPlaceholder('e.g., "Make this more concise" or "Fix grammar and spelling"')
          .setValue(this.currentInstruction)
          .onChange((value) => {
            this.currentInstruction = value;
          });

        // Auto-resize and focus
        textarea.inputEl.rows = 3;
        textarea.inputEl.addClass('claudesidian-inline-edit-instruction-input');

        // Handle Enter to submit (Shift+Enter for newline)
        this.plugin.registerDomEvent(textarea.inputEl, 'keydown', (e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            this.handleGenerate();
          }
        });

        // Focus after render
        requestAnimationFrame(() => {
          textarea.inputEl.focus();
        });
      });

    // Model selector
    const modelSection = container.createDiv('claudesidian-inline-edit-section');
    modelSection.createEl('label', { text: 'Model', cls: 'claudesidian-inline-edit-label' });

    new Setting(modelSection)
      .setClass('claudesidian-inline-edit-model-setting')
      .addDropdown((dropdown) => {
        this.modelDropdown = dropdown;

        // Build options from available models
        const modelKey = `${this.selectedProvider}:${this.selectedModel}`;

        for (const model of this.availableModels) {
          const key = `${model.providerId}:${model.modelId}`;
          dropdown.addOption(key, model.displayName);
        }

        dropdown.setValue(modelKey);
        dropdown.onChange((value) => {
          const [provider, model] = value.split(':');
          this.selectedProvider = provider;
          this.selectedModel = model;
        });
      });

    // Action buttons
    const buttonContainer = container.createDiv('claudesidian-inline-edit-buttons');

    new ButtonComponent(buttonContainer)
      .setButtonText('Cancel')
      .onClick(() => this.close());

    new ButtonComponent(buttonContainer)
      .setButtonText('Generate')
      .setCta()
      .onClick(() => this.handleGenerate());
  }

  /**
   * Render LOADING state
   */
  private renderLoadingState(progress?: string, streamedText?: string): void {
    if (!this.contentContainer) return;
    const container = this.contentContainer;

    // Header with spinner
    const header = container.createDiv('claudesidian-inline-edit-loading-header');
    const spinner = header.createDiv('claudesidian-inline-edit-spinner');
    header.createEl('h2', { text: progress || 'Generating...' });

    // Streaming preview
    const previewSection = container.createDiv('claudesidian-inline-edit-section');
    previewSection.createEl('label', { text: 'Preview', cls: 'claudesidian-inline-edit-label' });

    this.streamingPreview = previewSection.createDiv('claudesidian-inline-edit-streaming-preview');
    const previewText = this.streamingPreview.createEl('pre', {
      cls: 'claudesidian-inline-edit-preview-text claudesidian-inline-edit-streaming-text'
    });
    previewText.textContent = streamedText || '';

    // Cancel button
    const buttonContainer = container.createDiv('claudesidian-inline-edit-buttons');

    new ButtonComponent(buttonContainer)
      .setButtonText('Cancel')
      .setWarning()
      .onClick(() => this.handleCancel());
  }

  /**
   * Render RESULT state
   */
  private renderResultState(original: string, edited: string): void {
    if (!this.contentContainer) return;
    const container = this.contentContainer;

    // Header
    container.createEl('h2', { text: 'Review Changes', cls: 'claudesidian-inline-edit-header' });

    // Original text (read-only, collapsed)
    const originalSection = container.createDiv('claudesidian-inline-edit-section claudesidian-inline-edit-original-section');
    const originalHeader = originalSection.createDiv('claudesidian-inline-edit-collapsible-header');
    originalHeader.setAttribute('aria-label', 'Toggle original text visibility');
    originalHeader.setAttribute('aria-expanded', 'false');
    originalHeader.setAttribute('role', 'button');
    originalHeader.setAttribute('tabindex', '0');
    const collapseIcon = originalHeader.createSpan('claudesidian-inline-edit-collapse-icon');
    setIcon(collapseIcon, 'chevron-right');
    originalHeader.createEl('label', { text: 'Original Text', cls: 'claudesidian-inline-edit-label' });

    const originalContent = originalSection.createDiv('claudesidian-inline-edit-collapsible-content');
    originalContent.addClass('claudesidian-inline-edit-collapsed');
    const originalPre = originalContent.createEl('pre', {
      cls: 'claudesidian-inline-edit-preview-text'
    });
    originalPre.textContent = original;

    // Toggle collapse
    this.plugin.registerDomEvent(originalHeader, 'click', () => {
      const isCollapsed = originalContent.hasClass('claudesidian-inline-edit-collapsed');
      if (isCollapsed) {
        originalContent.removeClass('claudesidian-inline-edit-collapsed');
        setIcon(collapseIcon, 'chevron-down');
        originalHeader.setAttribute('aria-expanded', 'true');
      } else {
        originalContent.addClass('claudesidian-inline-edit-collapsed');
        setIcon(collapseIcon, 'chevron-right');
        originalHeader.setAttribute('aria-expanded', 'false');
      }
    });

    // Edited text (editable)
    const editedSection = container.createDiv('claudesidian-inline-edit-section');
    editedSection.createEl('label', { text: 'Edited Text (editable)', cls: 'claudesidian-inline-edit-label' });

    const editedContainer = editedSection.createDiv('claudesidian-inline-edit-result-container');
    this.resultTextarea = editedContainer.createEl('textarea', {
      cls: 'claudesidian-inline-edit-result-textarea'
    });
    this.resultTextarea.value = edited;
    this.resultTextarea.rows = Math.min(15, edited.split('\n').length + 2);

    // Track edits
    this.plugin.registerDomEvent(this.resultTextarea, 'input', () => {
      if (this.resultTextarea) {
        this.service.updateEditedText(this.resultTextarea.value);
      }
    });

    // Action buttons
    const buttonContainer = container.createDiv('claudesidian-inline-edit-buttons');

    new ButtonComponent(buttonContainer)
      .setButtonText('Retry')
      .onClick(() => this.handleRetry());

    new ButtonComponent(buttonContainer)
      .setButtonText('Cancel')
      .onClick(() => this.close());

    new ButtonComponent(buttonContainer)
      .setButtonText('Apply')
      .setCta()
      .onClick(() => this.handleApply());
  }

  /**
   * Render ERROR state
   */
  private renderErrorState(message: string, lastInstruction?: string): void {
    if (!this.contentContainer) return;
    const container = this.contentContainer;

    // Error header
    const header = container.createDiv('claudesidian-inline-edit-error-header');
    const errorIcon = header.createSpan('claudesidian-inline-edit-error-icon');
    setIcon(errorIcon, 'alert-circle');
    header.createEl('h2', { text: 'Error' });

    // Error message
    const errorSection = container.createDiv('claudesidian-inline-edit-error-section');
    errorSection.createEl('p', {
      text: message,
      cls: 'claudesidian-inline-edit-error-message'
    });

    // Preserve last instruction for retry
    if (lastInstruction) {
      this.currentInstruction = lastInstruction;
    }

    // Action buttons
    const buttonContainer = container.createDiv('claudesidian-inline-edit-buttons');

    new ButtonComponent(buttonContainer)
      .setButtonText('Cancel')
      .onClick(() => this.close());

    new ButtonComponent(buttonContainer)
      .setButtonText('Try Again')
      .setCta()
      .onClick(() => this.handleRetry());
  }

  /**
   * Update streaming preview with new chunk
   */
  private updateStreamingPreview(chunk: string): void {
    if (!this.streamingPreview) return;

    const preText = this.streamingPreview.querySelector('pre');
    if (preText) {
      preText.textContent = (preText.textContent || '') + chunk;
      // Auto-scroll to bottom
      this.streamingPreview.scrollTop = this.streamingPreview.scrollHeight;
    }
  }

  /**
   * Handle Generate button click
   */
  private async handleGenerate(): Promise<void> {
    if (!this.currentInstruction.trim()) {
      new Notice('Please enter an instruction');
      this.instructionInput?.inputEl.focus();
      return;
    }

    await this.service.generate({
      selectedText: this.selectionContext.selectedText,
      instruction: this.currentInstruction,
      context: {
        fileName: this.selectionContext.fileName,
        cursorPosition: this.selectionContext.from
      },
      modelConfig: {
        provider: this.selectedProvider,
        model: this.selectedModel
      }
    });
  }

  /**
   * Handle Cancel button click during loading
   */
  private handleCancel(): void {
    this.service.cancel();
  }

  /**
   * Handle Retry button click
   */
  private handleRetry(): void {
    this.service.reset(this.selectionContext.selectedText);
    // State change will trigger re-render to INPUT
  }

  /**
   * Handle Apply button click
   */
  private handleApply(): void {
    const state = this.service.getState();
    if (state.phase !== 'result') {
      return;
    }

    // Get the (possibly edited) result text
    const editedText = this.resultTextarea?.value || state.edited;

    // Apply to editor
    try {
      const { editor, from, to } = this.selectionContext;

      // Verify editor is still available and active
      const activeEditor = this.app.workspace.activeEditor?.editor;
      if (activeEditor !== editor) {
        new Notice('The editor has changed. Please try again in the active editor.');
        return;
      }

      // Replace the selected text
      editor.replaceRange(editedText, from, to);

      new Notice('Changes applied');
      this.close();
    } catch (error) {
      console.error('[InlineEditModal] Failed to apply changes:', error);
      new Notice('Failed to apply changes. Please try again.');
    }
  }

  /**
   * Truncate text with ellipsis for preview
   */
  private truncateText(text: string, maxLength: number): string {
    if (text.length <= maxLength) {
      return text;
    }
    return text.substring(0, maxLength) + '...';
  }

  onClose(): void {
    // Clean up service
    this.service.dispose();

    // Clear references
    this.contentContainer = null;
    this.instructionInput = null;
    this.modelDropdown = null;
    this.streamingPreview = null;
    this.resultTextarea = null;

    // Clear content
    this.contentEl.empty();
  }
}
