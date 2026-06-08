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
    const appsSettings = this.config.plugin.settings?.settings.apps;
    const fingerprint = this.computeSettingsFingerprint(llmSettings, appsSettings);
    if (!this.readAloudService || this.settingsFingerprint !== fingerprint) {
      this.readAloudService?.stop();
      this.readAloudService = new ReadAloudService(llmSettings, appsSettings);
      this.settingsFingerprint = fingerprint;
    }
    return this.readAloudService;
  }

  /**
   * Build a change-detection fingerprint for the read-aloud settings WITHOUT
   * retaining any raw API key. The fingerprint stays in memory only (never
   * logged or persisted) and is used solely to decide whether the cached
   * ReadAloudService must be rebuilt.
   *
   * SEC-m2: the previous implementation JSON.stringify'd the full provider/app
   * configs (which include `apiKey`/`credentials.apiKey`) into this long-lived
   * field, leaving a plaintext key copy in memory. We now compose only
   * non-secret fields (provider/model/voice + enabled) plus a non-reversible
   * hash of each key. Hashing the key (rather than dropping it) preserves
   * change-detection across same-provider key rotation, which a plain
   * presence boolean would miss.
   */
  private computeSettingsFingerprint(
    llmSettings: Settings['settings']['llmProviders'] | null,
    appsSettings: Settings['settings']['apps'] | undefined
  ): string {
    const speech = llmSettings?.defaultSpeechModel;
    const openai = llmSettings?.providers?.openai;
    const elevenlabs = appsSettings?.apps.elevenlabs;

    const parts = [
      speech?.provider ?? '',
      speech?.model ?? '',
      speech?.voice ?? '',
      openai?.enabled ? '1' : '0',
      this.hashSecret(openai?.apiKey),
      elevenlabs?.enabled ? '1' : '0',
      this.hashSecret(elevenlabs?.credentials.apiKey),
    ];

    return parts.join('|');
  }

  /**
   * Non-cryptographic djb2 hash of a secret. Returns a short hex digest that
   * changes when the secret changes but never exposes the plaintext. Empty/
   * absent secrets collapse to a stable sentinel so an unset key is
   * distinguishable from a set one.
   */
  private hashSecret(secret: string | undefined): string {
    if (!secret) {
      return '0';
    }

    let hash = 5381;
    for (let index = 0; index < secret.length; index += 1) {
      hash = ((hash << 5) + hash + secret.charCodeAt(index)) | 0;
    }
    return (hash >>> 0).toString(16);
  }
}
