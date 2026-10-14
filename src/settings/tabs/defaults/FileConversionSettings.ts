/**
 * The File conversion fold on Defaults.
 *
 * Rows, in order: File import (the `enableIngestion` switch, which gates PDF,
 * document and audio conversion), then only while it is on: Reading method,
 * Vision provider and Vision model (only for Vision), and Convert new files
 * automatically. The fold redraws its own rows when the switch or the method
 * changes, so dependent rows never sit above the switch or linger while it is off.
 */

import { Setting } from 'obsidian';
import type { LLMProviderSettings } from '../../../types/llm/ProviderTypes';
import {
  normalizeIngestSelection,
  type IngestProviderOption,
} from '../../../agents/ingestManager/tools/services/IngestCapabilityService';
import { renderIngestModelDropdowns } from '../../../components/shared/IngestModelDropdownRenderer';
import { FILE_CONVERSION_COPY, FOLD_ICONS, FOLD_IDS, FOLD_TITLES } from '../../../components/shared/chatSettings/copy';
import { fileConversionSummary } from '../../../components/shared/chatSettings/sectionSummaries';
import type { FoldDefinition, FoldHost } from '../../../components/shared/chatSettings/types';

/** The plugin settings this fold reads and writes. */
export interface FileConversionPluginSettings {
  enableIngestion?: boolean;
  autoIngestion?: boolean;
}

export interface FileConversionDeps {
  getPluginSettings(): FileConversionPluginSettings;
  getLlmSettings(): LLMProviderSettings;
  /** Apply a change and queue a save behind any save already in flight. */
  save(mutate: () => void): void;
  /** Vision-capable providers for PDF reading. */
  loadOcrProviders(): Promise<IngestProviderOption[]>;
}

type OcrState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; providers: IngestProviderOption[] }
  | { status: 'failed' };

export class FileConversionSettings implements FoldDefinition {
  readonly id = FOLD_IDS.fileConversion;
  readonly title = FOLD_TITLES.fileConversion;
  readonly icon = FOLD_ICONS.fileConversion;
  private ocr: OcrState = { status: 'idle' };
  private destroyed = false;

  constructor(private readonly deps: FileConversionDeps) {}

  getSummary(): string {
    const plugin = this.deps.getPluginSettings();
    return fileConversionSummary({
      enabled: plugin.enableIngestion !== false,
      vision: this.deps.getLlmSettings().defaultPdfMode === 'vision',
      autoConvert: plugin.autoIngestion === true
    });
  }

  render(itemsEl: HTMLElement, host: FoldHost): void {
    const plugin = this.deps.getPluginSettings();
    const llm = this.deps.getLlmSettings();
    const enabled = plugin.enableIngestion !== false;

    new Setting(itemsEl)
      .setName(FILE_CONVERSION_COPY.fileImport)
      .setDesc(FILE_CONVERSION_COPY.fileImportDesc)
      .addToggle(toggle => toggle
        .setValue(enabled)
        .onChange(value => {
          this.deps.save(() => { this.deps.getPluginSettings().enableIngestion = value; });
          host.redraw();
        }));

    if (enabled) {
      const vision = llm.defaultPdfMode === 'vision';
      new Setting(itemsEl)
        .setName(FILE_CONVERSION_COPY.readingMethod)
        .setDesc(FILE_CONVERSION_COPY.readingMethodDesc)
        .addDropdown(dropdown => dropdown
          .addOption('text', FILE_CONVERSION_COPY.textExtraction)
          .addOption('vision', FILE_CONVERSION_COPY.vision)
          .setValue(vision ? 'vision' : 'text')
          .onChange(value => {
            this.deps.save(() => { this.deps.getLlmSettings().defaultPdfMode = value === 'vision' ? 'vision' : 'text'; });
            host.redraw();
          }));

      if (vision) this.renderVisionRows(itemsEl, host);

      new Setting(itemsEl)
        .setName(FILE_CONVERSION_COPY.autoConvert)
        .setDesc(FILE_CONVERSION_COPY.autoConvertDesc)
        .addToggle(toggle => toggle
          .setValue(plugin.autoIngestion === true)
          .onChange(value => {
            this.deps.save(() => { this.deps.getPluginSettings().autoIngestion = value; });
            host.setSummary(this.getSummary());
          }));
    }

    host.setSummary(this.getSummary());
  }

  private renderVisionRows(itemsEl: HTMLElement, host: FoldHost): void {
    const state = this.ocr;
    if (state.status === 'idle' || state.status === 'loading') {
      new Setting(itemsEl).setName(FILE_CONVERSION_COPY.visionProvider).setDesc('Loading vision models...');
      if (state.status === 'idle') this.loadOcr(host);
      return;
    }
    if (state.status === 'failed') {
      new Setting(itemsEl).setName(FILE_CONVERSION_COPY.visionProvider).setDesc(FILE_CONVERSION_COPY.visionUnavailable);
      return;
    }

    const llm = this.deps.getLlmSettings();
    const normalized = normalizeIngestSelection(state.providers, llm.defaultOcrModel?.provider, llm.defaultOcrModel?.model);
    renderIngestModelDropdowns(itemsEl, {
      labelPrefix: FILE_CONVERSION_COPY.vision,
      providers: state.providers,
      getSelection: () => {
        const current = this.deps.getLlmSettings().defaultOcrModel;
        if (current?.provider && current.model) return current;
        return normalized.provider && normalized.model ? { provider: normalized.provider, model: normalized.model } : undefined;
      },
      onChange: (provider, model) => {
        this.deps.save(() => {
          this.deps.getLlmSettings().defaultOcrModel = provider && model ? { provider, model } : undefined;
        });
      },
      providerSettingName: FILE_CONVERSION_COPY.visionProvider,
      modelSettingName: FILE_CONVERSION_COPY.visionModel
    });
  }

  private loadOcr(host: FoldHost): void {
    this.ocr = { status: 'loading' };
    void this.deps.loadOcrProviders().then(providers => {
      this.ocr = { status: 'ready', providers };
    }).catch((error: unknown) => {
      console.error('[FileConversionSettings] Failed to load vision models:', error);
      this.ocr = { status: 'failed' };
    }).then(() => {
      if (!this.destroyed) host.redraw();
    });
  }

  destroy(): void {
    this.destroyed = true;
  }
}
