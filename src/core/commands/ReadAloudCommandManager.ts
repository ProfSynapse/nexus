import {
  App,
  Editor,
  Events,
  MarkdownFileInfo,
  MarkdownView,
  Menu,
  Notice,
  Plugin,
  TAbstractFile,
  TFile,
} from 'obsidian';
import type { Settings } from '../../settings';
import { ReadAloudService } from '../../services/readAloud/ReadAloudService';

declare module 'obsidian' {
  interface Workspace extends Events {
    on(name: 'editor-menu', callback: (menu: Menu, editor: Editor, info: MarkdownView | MarkdownFileInfo) => void): import('obsidian').EventRef;
    on(name: 'file-menu', callback: (menu: Menu, file: TAbstractFile, source: string) => void): import('obsidian').EventRef;
  }
}

interface PluginWithSettings extends Plugin {
  settings?: Settings;
}

export interface ReadAloudCommandManagerConfig {
  plugin: PluginWithSettings;
  app: App;
}

export class ReadAloudCommandManager {
  private readAloudService: ReadAloudService | null = null;
  private settingsFingerprint: string | null = null;

  constructor(private config: ReadAloudCommandManagerConfig) {}

  registerCommands(): void {
    this.registerReadActiveNoteCommand();
    this.registerStopCommand();
    this.registerEditorMenu();
    this.registerFileMenu();
  }

  private registerReadActiveNoteCommand(): void {
    this.config.plugin.addCommand({
      id: 'read-active-note-aloud',
      name: 'Read active note aloud',
      checkCallback: (checking) => {
        const view = this.config.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view?.file) {
          return false;
        }

        if (!checking) {
          void this.readFile(view.file);
        }

        return true;
      }
    });
  }

  private registerStopCommand(): void {
    this.config.plugin.addCommand({
      id: 'stop-read-aloud',
      name: 'Stop read aloud',
      checkCallback: (checking) => {
        const isPlaying = this.readAloudService?.isPlaying() === true;
        if (!isPlaying) {
          return false;
        }

        if (!checking) {
          this.readAloudService?.stop();
          new Notice('Read aloud stopped.');
        }

        return true;
      }
    });
  }

  private registerEditorMenu(): void {
    this.config.plugin.registerEvent(
      this.config.app.workspace.on('editor-menu', (menu, editor) => {
        if (!editor.somethingSelected()) {
          return;
        }

        menu.addItem((item) => {
          item
            .setTitle('Read selection aloud')
            .setIcon('volume-2')
            .onClick(() => {
              void this.readSelection(editor);
            });
        });
      })
    );
  }

  private registerFileMenu(): void {
    this.config.plugin.registerEvent(
      this.config.app.workspace.on('file-menu', (menu, file) => {
        if (!(file instanceof TFile) || file.extension !== 'md') {
          return;
        }

        menu.addItem((item) => {
          item
            .setTitle('Read note aloud')
            .setIcon('volume-2')
            .onClick(() => {
              void this.readFile(file);
            });
        });
      })
    );
  }

  private async readSelection(editor: Editor): Promise<void> {
    const selectedText = editor.getSelection();
    if (!selectedText.trim()) {
      new Notice('Please select text to read aloud.');
      return;
    }

    await this.startReadAloud(selectedText, 'Selection');
  }

  private async readFile(file: TFile): Promise<void> {
    const content = await this.config.app.vault.cachedRead(file);
    await this.startReadAloud(content, file.basename);
  }

  private async startReadAloud(markdown: string, sourceName: string): Promise<void> {
    const service = this.getReadAloudService();
    const notice = new Notice(`Reading ${sourceName} aloud...`, 0);

    try {
      const result = await service.read({ markdown, sourceName });
      notice.hide();
      new Notice(`Finished reading ${result.sourceName ?? 'text'} aloud.`);
    } catch (error) {
      notice.hide();
      const message = error instanceof Error ? error.message : String(error);
      if (message === 'Read aloud playback was stopped.') {
        return;
      }
      new Notice(`Read aloud failed: ${message}`);
    }
  }

  private getReadAloudService(): ReadAloudService {
    const llmSettings = this.config.plugin.settings?.settings.llmProviders ?? null;
    const fingerprint = JSON.stringify(llmSettings?.defaultSpeechModel ?? {}) +
      JSON.stringify(llmSettings?.providers?.openai ?? {});
    if (!this.readAloudService || this.settingsFingerprint !== fingerprint) {
      this.readAloudService?.stop();
      this.readAloudService = new ReadAloudService(llmSettings);
      this.settingsFingerprint = fingerprint;
    }
    return this.readAloudService;
  }
}
