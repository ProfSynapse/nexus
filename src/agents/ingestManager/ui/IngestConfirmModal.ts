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

export interface IngestConfirmOptions {
  filePath: string;
  fileType: 'pdf' | 'audio';
  defaultPdfMode: 'text' | 'vision';
  defaultOcrProvider?: string;
  defaultOcrModel?: string;
  defaultTranscriptionProvider?: string;
  defaultTranscriptionModel?: string;
  /** Provider names available for vision OCR */
  ocrProviders: Array<{ id: string; name: string }>;
  /** Provider names available for transcription */
  transcriptionProviders: Array<{ id: string; name: string }>;
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

  constructor(app: App, options: IngestConfirmOptions) {
    super(app);
    this.options = options;
    this.result = {
      confirmed: false,
      pdfMode: options.defaultPdfMode,
      ocrProvider: options.defaultOcrProvider,
      ocrModel: options.defaultOcrModel,
      transcriptionProvider: options.defaultTranscriptionProvider,
      transcriptionModel: options.defaultTranscriptionModel
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
          });
      });

    // Vision provider/model settings (conditionally shown)
    visionSettingsContainer = section.createDiv({ cls: 'nexus-ingest-confirm-vision-settings' });
    if (this.result.pdfMode !== 'vision') {
      visionSettingsContainer.addClass('nexus-ingest-confirm-hidden');
    }

    new Setting(visionSettingsContainer)
      .setName('OCR provider')
      .addDropdown(dropdown => {
        for (const provider of this.options.ocrProviders) {
          dropdown.addOption(provider.id, provider.name);
        }
        if (this.result.ocrProvider) {
          dropdown.setValue(this.result.ocrProvider);
        }
        dropdown.onChange(value => {
          this.result.ocrProvider = value;
        });
      });
  }

  private renderAudioOptions(container: HTMLElement): void {
    const section = container.createDiv({ cls: 'nexus-ingest-confirm-options' });

    new Setting(section)
      .setName('Transcription provider')
      .setDesc('Select the provider for audio transcription.')
      .addDropdown(dropdown => {
        for (const provider of this.options.transcriptionProviders) {
          dropdown.addOption(provider.id, provider.name);
        }
        if (this.result.transcriptionProvider) {
          dropdown.setValue(this.result.transcriptionProvider);
        }
        dropdown.onChange(value => {
          this.result.transcriptionProvider = value;
        });
      });
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

    const ingestBtn = buttonRow.createEl('button', {
      text: 'Ingest',
      cls: 'nexus-ingest-confirm-submit mod-cta'
    });
    ingestBtn.addEventListener('click', () => {
      this.result.confirmed = true;
      if (this.resolvePromise) {
        this.resolvePromise(this.result);
        this.resolvePromise = null;
      }
      this.close();
    });
  }

  private getFilename(filePath: string): string {
    const parts = filePath.split('/');
    return parts[parts.length - 1] || filePath;
  }
}
