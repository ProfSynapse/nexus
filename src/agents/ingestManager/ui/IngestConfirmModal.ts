/**
 * IngestConfirmModal - Confirmation modal before ingestion starts
 * Location: /src/agents/ingestManager/ui/IngestConfirmModal.ts
 *
 * Shown after a user drops a file. Displays:
 * - Filename and file type icon
 * - PDF mode picker (text extraction / vision OCR) for PDFs
 * - Provider/model dropdown for vision OCR
 * - Provider/model dropdown for audio transcription
 * - Cancel and Ingest buttons
 */

import { App, Modal, Setting, setIcon } from 'obsidian';
import {
  IngestProviderOption,
  normalizeIngestSelection
} from '../tools/services/IngestCapabilityService';

export interface IngestConfirmOptions {
  filePath: string;
  fileType: 'pdf' | 'audio';
  defaultPdfMode: 'text' | 'vision';
  defaultOcrProvider?: string;
  defaultOcrModel?: string;
  defaultTranscriptionProvider?: string;
  defaultTranscriptionModel?: string;
  /** Provider + model options available for vision OCR */
  ocrProviders: IngestProviderOption[];
  /** Provider + model options available for transcription */
  transcriptionProviders: IngestProviderOption[];
}

export interface IngestConfirmResult {
  confirmed: boolean;
  pdfMode?: 'text' | 'vision';
  ocrProvider?: string;
  ocrModel?: string;
  transcriptionProvider?: string;
  transcriptionModel?: string;
}

export class IngestConfirmModal extends Modal {
  private options: IngestConfirmOptions;
  private resolvePromise: ((result: IngestConfirmResult) => void) | null = null;
  private result: IngestConfirmResult;
  private submitButton: HTMLButtonElement | null = null;

  constructor(app: App, options: IngestConfirmOptions) {
    super(app);
    this.options = options;
    const normalizedOcrSelection = normalizeIngestSelection(
      options.ocrProviders,
      options.defaultOcrProvider,
      options.defaultOcrModel
    );
    const normalizedTranscriptionSelection = normalizeIngestSelection(
      options.transcriptionProviders,
      options.defaultTranscriptionProvider,
      options.defaultTranscriptionModel
    );
    this.result = {
      confirmed: false,
      pdfMode: options.defaultPdfMode,
      ocrProvider: normalizedOcrSelection.provider,
      ocrModel: normalizedOcrSelection.model,
      transcriptionProvider: normalizedTranscriptionSelection.provider,
      transcriptionModel: normalizedTranscriptionSelection.model
    };
  }

  /**
   * Open modal and return a promise that resolves with the user's choice.
   */
  async prompt(): Promise<IngestConfirmResult> {
    return new Promise<IngestConfirmResult>((resolve) => {
      this.resolvePromise = resolve;
      this.open();
    });
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass('nexus-ingest-confirm-modal');

    // Title
    contentEl.createEl('h2', { text: 'Ingest file' });

    // File info block
    this.renderFileInfo(contentEl);

    // Mode-specific options
    if (this.options.fileType === 'pdf') {
      this.renderPdfOptions(contentEl);
    } else {
      this.renderAudioOptions(contentEl);
    }

    // Action buttons
    this.renderButtons(contentEl);
  }

  onClose(): void {
    const { contentEl } = this;
    contentEl.empty();

    // If the modal was closed without clicking Ingest, treat as cancel
    if (this.resolvePromise) {
      this.resolvePromise({ confirmed: false });
      this.resolvePromise = null;
    }
  }

  private renderFileInfo(container: HTMLElement): void {
    const infoBlock = container.createDiv({ cls: 'nexus-ingest-confirm-file-info' });

    const iconEl = infoBlock.createDiv({ cls: 'nexus-ingest-confirm-file-icon' });
    setIcon(iconEl, this.options.fileType === 'pdf' ? 'file-text' : 'headphones');

    const detailsEl = infoBlock.createDiv({ cls: 'nexus-ingest-confirm-file-details' });
    const filename = this.getFilename(this.options.filePath);
    detailsEl.createDiv({ cls: 'nexus-ingest-confirm-filename', text: filename });

    const typeLabel = this.options.fileType === 'pdf' ? 'PDF document' : 'Audio file';
    detailsEl.createDiv({ cls: 'nexus-ingest-confirm-filetype', text: typeLabel });
  }

  private renderPdfOptions(container: HTMLElement): void {
    const section = container.createDiv({ cls: 'nexus-ingest-confirm-options' });

    // PDF mode picker
    let visionSettingsContainer: HTMLElement | null = null;

    new Setting(section)
      .setName('Processing mode')
      .setDesc('Text extraction is free. Vision OCR uses an LLM for scanned documents.')
      .addDropdown(dropdown => {
        dropdown
          .addOption('text', 'Text extraction')
          .addOption('vision', 'Vision OCR')
          .setValue(this.result.pdfMode || 'text')
          .onChange(value => {
            this.result.pdfMode = value as 'text' | 'vision';
            if (visionSettingsContainer) {
              if (value === 'vision') {
                visionSettingsContainer.removeClass('nexus-ingest-confirm-hidden');
              } else {
                visionSettingsContainer.addClass('nexus-ingest-confirm-hidden');
              }
            }
            this.updateSubmitButtonState();
          });
      });

    // Vision provider/model settings (conditionally shown)
    visionSettingsContainer = section.createDiv({ cls: 'nexus-ingest-confirm-vision-settings' });
    if (this.result.pdfMode !== 'vision') {
      visionSettingsContainer.addClass('nexus-ingest-confirm-hidden');
    }

    this.renderProviderModelSettings(
      visionSettingsContainer,
      'OCR',
      this.options.ocrProviders,
      () => ({
        provider: this.result.ocrProvider,
        model: this.result.ocrModel
      }),
      (provider, model) => {
        this.result.ocrProvider = provider;
        this.result.ocrModel = model;
        this.updateSubmitButtonState();
      }
    );
  }

  private renderAudioOptions(container: HTMLElement): void {
    const section = container.createDiv({ cls: 'nexus-ingest-confirm-options' });

    this.renderProviderModelSettings(
      section,
      'Transcription',
      this.options.transcriptionProviders,
      () => ({
        provider: this.result.transcriptionProvider,
        model: this.result.transcriptionModel
      }),
      (provider, model) => {
        this.result.transcriptionProvider = provider;
        this.result.transcriptionModel = model;
        this.updateSubmitButtonState();
      }
    );
  }

  private renderButtons(container: HTMLElement): void {
    const buttonRow = container.createDiv({ cls: 'nexus-ingest-confirm-buttons' });

    const cancelBtn = buttonRow.createEl('button', {
      text: 'Cancel',
      cls: 'nexus-ingest-confirm-cancel'
    });
    cancelBtn.addEventListener('click', () => {
      this.close();
    });

    this.submitButton = buttonRow.createEl('button', {
      text: 'Ingest',
      cls: 'nexus-ingest-confirm-submit mod-cta'
    });
    this.submitButton.addEventListener('click', () => {
      this.result.confirmed = true;
      if (this.resolvePromise) {
        this.resolvePromise(this.result);
        this.resolvePromise = null;
      }
      this.close();
    });

    this.updateSubmitButtonState();
  }

  private renderProviderModelSettings(
    container: HTMLElement,
    labelPrefix: string,
    providers: IngestProviderOption[],
    getSelection: () => { provider?: string; model?: string },
    onSelectionChange: (provider?: string, model?: string) => void
  ): void {
    let modelSelectEl: HTMLSelectElement | null = null;

    const updateModelOptions = (): void => {
      if (!modelSelectEl) {
        return;
      }

      const selection = getSelection();
      const provider = providers.find(option => option.id === selection.provider);

      modelSelectEl.empty();

      if (!provider || provider.models.length === 0) {
        modelSelectEl.createEl('option', {
          value: '',
          text: providers.length === 0 ? `No ${labelPrefix.toLowerCase()} models available` : 'Select a provider first'
        });
        modelSelectEl.disabled = true;
        return;
      }

      provider.models.forEach(model => {
        modelSelectEl!.createEl('option', {
          value: model.id,
          text: model.name
        });
      });

      const normalized = normalizeIngestSelection(providers, selection.provider, selection.model);
      modelSelectEl.value = normalized.model || provider.models[0].id;
      modelSelectEl.disabled = false;
    };

    new Setting(container)
      .setName(`${labelPrefix} provider`)
      .addDropdown(dropdown => {
        if (providers.length === 0) {
          dropdown.addOption('', `No ${labelPrefix.toLowerCase()} providers available`);
          dropdown.setDisabled(true);
          onSelectionChange(undefined, undefined);
          return;
        }

        providers.forEach(provider => {
          dropdown.addOption(provider.id, provider.name);
        });

        const normalized = normalizeIngestSelection(
          providers,
          getSelection().provider,
          getSelection().model
        );
        dropdown.setValue(normalized.provider || providers[0].id);

        dropdown.onChange(value => {
          const nextSelection = normalizeIngestSelection(providers, value, undefined);
          onSelectionChange(nextSelection.provider, nextSelection.model);
          updateModelOptions();
        });
      });

    new Setting(container)
      .setName(`${labelPrefix} model`)
      .addDropdown(dropdown => {
        modelSelectEl = dropdown.selectEl;
        updateModelOptions();

        dropdown.onChange(value => {
          const selection = getSelection();
          onSelectionChange(selection.provider, value || undefined);
          updateModelOptions();
        });
      });
  }

  private updateSubmitButtonState(): void {
    if (!this.submitButton) {
      return;
    }

    this.submitButton.disabled = !this.canSubmit();
  }

  private canSubmit(): boolean {
    if (this.options.fileType === 'audio') {
      return !!(this.result.transcriptionProvider && this.result.transcriptionModel);
    }

    if (this.result.pdfMode === 'vision') {
      return !!(this.result.ocrProvider && this.result.ocrModel);
    }

    return true;
  }

  private getFilename(filePath: string): string {
    const parts = filePath.split('/');
    return parts[parts.length - 1] || filePath;
  }
}
