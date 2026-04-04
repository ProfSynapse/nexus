import {
  App,
  Events,
  Menu,
  Notice,
  Plugin,
  TAbstractFile,
  TFile,
  normalizePath
} from 'obsidian';
import type { AgentManager } from '../../services/AgentManager';
import type { Settings } from '../../settings';
import { detectFileType, isSupportedFile } from '../../agents/ingestManager/tools/services/FileTypeDetector';
import type { IngestToolResult } from '../../agents/ingestManager/types';

declare module 'obsidian' {
  interface Workspace extends Events {
    on(
      name: 'file-menu',
      callback: (menu: Menu, file: TAbstractFile, source: string) => void
    ): import('obsidian').EventRef;
  }
}

interface PluginWithServices extends Plugin {
  settings?: Settings;
  getService<T>(name: string, timeoutMs?: number): Promise<T | null>;
}

export interface VaultIngestionManagerConfig {
  plugin: PluginWithServices;
  app: App;
  getService: <T>(name: string, timeoutMs?: number) => Promise<T | null>;
}

type IngestionSource = 'manual' | 'auto';

const AUTO_INGEST_DELAY_MS = 1500;

export class VaultIngestionManager {
  private inFlight = new Set<string>();
  private autoWatcherRegistered = false;

  constructor(private config: VaultIngestionManagerConfig) {}

  register(): void {
    this.registerFileMenu();
    this.registerAutoIngestionWatcher();
  }

  private registerFileMenu(): void {
    this.config.plugin.registerEvent(
      this.config.app.workspace.on('file-menu', (menu, file) => {
        if (!(file instanceof TFile)) {
          return;
        }

        if (this.isIngestionDisabled() || !isSupportedFile(file.path)) {
          return;
        }

        menu.addItem((item) => {
          item
            .setTitle('Convert to Markdown')
            .setIcon('file-text')
            .onClick(() => {
              void this.convertFile(file, 'manual');
            });
        });
      })
    );
  }

  private registerAutoIngestionWatcher(): void {
    this.config.app.workspace.onLayoutReady(() => {
      if (this.autoWatcherRegistered) {
        return;
      }

      this.autoWatcherRegistered = true;
      this.config.plugin.registerEvent(
        this.config.app.vault.on('create', (file) => {
          if (!(file instanceof TFile)) {
            return;
          }

          if (!this.shouldAutoIngest(file)) {
            return;
          }

          window.setTimeout(() => {
            void this.convertFile(file, 'auto');
          }, AUTO_INGEST_DELAY_MS);
        })
      );
    });
  }

  private shouldAutoIngest(file: TFile): boolean {
    const settings = this.config.plugin.settings?.settings;
    if (!settings || settings.enableIngestion === false || settings.autoIngestion !== true) {
      return false;
    }

    if (!isSupportedFile(file.path)) {
      return false;
    }

    if (this.inFlight.has(file.path)) {
      return false;
    }

    const outputFile = this.getOutputFile(file);
    if (outputFile) {
      return false;
    }

    return true;
  }

  private async convertFile(file: TFile, source: IngestionSource): Promise<void> {
    if (this.inFlight.has(file.path)) {
      if (source === 'manual') {
        new Notice(`Already converting ${file.name}.`);
      }
      return;
    }

    const request = this.buildRequest(file);
    if (!request.ready) {
      if (source === 'manual' || request.noticeOnSkip) {
        new Notice(request.message, 7000);
      }
      return;
    }

    this.inFlight.add(file.path);
    new Notice(
      `${source === 'auto' ? 'Auto-converting' : 'Converting'} ${file.name} to Markdown...`,
      3000
    );

    try {
      const agentManager = await this.config.getService<AgentManager>('agentManager');
      if (!agentManager) {
        throw new Error('Agent manager not available');
      }

      const ingestAgent = agentManager.getAgent('ingestManager');
      if (!ingestAgent) {
        throw new Error('Ingest agent not available');
      }

      const ingestTool = ingestAgent.getTool('ingest');
      if (!ingestTool) {
        throw new Error('Ingest tool not available');
      }

      const result = await ingestTool.execute(request.params) as IngestToolResult;
      if (!result.success) {
        throw new Error(result.error || 'Ingestion failed');
      }

      const outputPaths = result.outputPaths ?? (result.outputPath ? [result.outputPath] : []);
      if (outputPaths.length > 1) {
        new Notice(`Converted ${file.name} into ${outputPaths.length} Markdown notes.`, 5000);
      } else {
        const outputPath = outputPaths[0] || this.getOutputPath(file.path);
        new Notice(`Converted ${file.name} -> ${outputPath}`, 5000);
      }

      if (result.warnings && result.warnings.length > 0) {
        new Notice(result.warnings.join(' '), 7000);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unexpected ingestion error';
      new Notice(`Failed to convert ${file.name}: ${message}`, 8000);
    } finally {
      this.inFlight.delete(file.path);
    }
  }

  private buildRequest(file: TFile):
    | { ready: true; params: { filePath: string; mode?: 'text' | 'vision'; ocrProvider?: string; ocrModel?: string; transcriptionProvider?: string; transcriptionModel?: string } }
    | { ready: false; message: string; noticeOnSkip: boolean } {
    const settings = this.config.plugin.settings?.settings;
    const llmSettings = settings?.llmProviders;

    if (!settings || settings.enableIngestion === false) {
      return {
        ready: false,
        message: 'Ingestion is disabled in settings.',
        noticeOnSkip: false
      };
    }

    const fileType = detectFileType(file.path);
    if (!fileType) {
      return {
        ready: false,
        message: `Unsupported file type: ${file.name}`,
        noticeOnSkip: false
      };
    }

    if (!llmSettings) {
      return {
        ready: false,
        message: 'LLM provider settings are not available.',
        noticeOnSkip: true
      };
    }

    if (fileType.type === 'pdf') {
      const mode = llmSettings.defaultPdfMode || 'text';
      if (mode === 'vision') {
        const ocrProvider = llmSettings.defaultOcrModel?.provider;
        const ocrModel = llmSettings.defaultOcrModel?.model;
        if (!ocrProvider || !ocrModel) {
          return {
            ready: false,
            message: 'Set a default OCR provider and model before converting PDFs in vision mode.',
            noticeOnSkip: true
          };
        }

        return {
          ready: true,
          params: {
            filePath: file.path,
            mode,
            ocrProvider,
            ocrModel
          }
        };
      }

      return {
        ready: true,
        params: {
          filePath: file.path,
          mode
        }
      };
    }

    if (fileType.type === 'docx' || fileType.type === 'pptx' || fileType.type === 'xlsx') {
      return {
        ready: true,
        params: {
          filePath: file.path
        }
      };
    }


    const transcriptionProvider = llmSettings.defaultTranscriptionModel?.provider;
    const transcriptionModel = llmSettings.defaultTranscriptionModel?.model;
    if (!transcriptionProvider || !transcriptionModel) {
      return {
        ready: false,
        message: 'Set a default transcription provider and model before converting audio files.',
        noticeOnSkip: true
      };
    }

    return {
      ready: true,
      params: {
        filePath: file.path,
        transcriptionProvider,
        transcriptionModel
      }
    };
  }

  private getOutputFile(file: TFile): TFile | null {
    const fileType = detectFileType(file.path);
    if (fileType?.type === 'xlsx') {
      return null;
    }
    return this.config.app.vault.getFileByPath(this.getOutputPath(file.path));
  }

  private getOutputPath(filePath: string): string {
    const normalizedPath = normalizePath(filePath);
    const dotIndex = normalizedPath.lastIndexOf('.');
    if (dotIndex === -1) {
      return `${normalizedPath}.md`;
    }
    return `${normalizedPath.slice(0, dotIndex)}.md`;
  }

  private isIngestionDisabled(): boolean {
    return this.config.plugin.settings?.settings?.enableIngestion === false;
  }
}
