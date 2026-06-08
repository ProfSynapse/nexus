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
import type { ReadAloudSession } from '../../services/readAloud/ReadAloudService';
import { ReadAloudSaveService } from '../../services/readAloud/ReadAloudSaveService';
import { SavePromptModal, SavePromptChoice } from '../../ui/readAloud/SavePromptModal';
import { ReadAloudProgressModal } from '../../ui/readAloud/ReadAloudProgressModal';

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

type ReadAloudTarget = { mode: 'selection' | 'note'; file: TFile; editor?: Editor };

export class ReadAloudCommandManager {
  private readAloudService: ReadAloudService | null = null;
  private settingsFingerprint: string | null = null;
  private readAloudSaveService: ReadAloudSaveService | null = null;

  constructor(private config: ReadAloudCommandManagerConfig) {}

  registerCommands(): void {
    this.registerReadActiveNoteCommand();
    this.registerReadSelectionCommand();
    this.registerStopCommand();
    this.registerEditorMenu();
    this.registerFileMenu();
  }

  private registerReadActiveNoteCommand(): void {
    this.config.plugin.addCommand({
      id: 'read-active-note-aloud',
      name: 'Read note aloud',
      checkCallback: (checking) => {
        const view = this.config.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view?.file) {
          return false;
        }

        if (!checking) {
          this.promptAndRead({ mode: 'note', file: view.file });
        }

        return true;
      }
    });
  }

  private registerReadSelectionCommand(): void {
    this.config.plugin.addCommand({
      id: 'read-selection-aloud',
      name: 'Read selection aloud',
      editorCheckCallback: (checking, editor, ctx) => {
        const file = ctx.file;
        if (!file || !editor.somethingSelected()) {
          return false;
        }

        if (!checking) {
          this.promptAndRead({ mode: 'selection', file, editor });
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
      this.config.app.workspace.on('editor-menu', (menu, editor, info) => {
        if (!editor.somethingSelected()) {
          return;
        }

        const file = info.file;
        if (!(file instanceof TFile) || file.extension !== 'md') {
          return;
        }

        menu.addItem((item) => {
          item
            .setTitle('Read selection aloud')
            .setIcon('volume-2')
            .onClick(() => {
              this.promptAndRead({ mode: 'selection', file, editor });
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
              this.promptAndRead({ mode: 'note', file });
            });
        });
      })
    );
  }

  /**
   * The single v2 read-aloud entry point. Asks save-or-not, then runs an
   * animated reading-aloud session. "Save & read" plays AND saves+embeds (the
   * save continues in the background even if the modal is dismissed mid-play);
   * "Just read" plays only; dismissing the progress modal stops playback.
   */
  private promptAndRead(target: ReadAloudTarget): void {
    new SavePromptModal(this.config.app, (choice: SavePromptChoice) => {
      if (choice === 'cancel') {
        return;
      }
      void this.runReadAloudSession(target, choice === 'save');
    }).open();
  }

  /**
   * Resolve the text to synthesize: the live selection (selection mode) or the
   * whole note (note mode). Returns null with a Notice if there's nothing to read.
   */
  private async resolveMarkdown(target: ReadAloudTarget): Promise<string | null> {
    if (target.mode === 'selection') {
      const selection = target.editor?.getSelection() ?? '';
      if (!selection.trim()) {
        new Notice('Please select text to read aloud.');
        return null;
      }
      return selection;
    }

    const content = await this.config.app.vault.cachedRead(target.file);
    if (!content.trim()) {
      new Notice('There is no readable text in this note.');
      return null;
    }
    return content;
  }

  /**
   * Start a read-aloud session and drive the progress modal. Wiring rules:
   * - onProgress updates the modal until the modal is closed (listener detached).
   * - User-dismissing the modal stops playback; a chosen save keeps running in
   *   the background (the backend session is modal-agnostic).
   * - session.completed resolves with a savedPath on save, resolves empty on
   *   just-read, and rejects on synth/write failure (-> error Notice).
   */
  private async runReadAloudSession(target: ReadAloudTarget, save: boolean): Promise<void> {
    const markdown = await this.resolveMarkdown(target);
    if (markdown === null) {
      return;
    }

    let session: ReadAloudSession;
    try {
      session = this.getReadAloudService().startReadAloudSession({
        mode: target.mode,
        file: target.file,
        markdown,
        editor: target.editor,
        selection: target.mode === 'selection' ? markdown : undefined,
        save,
        saveService: save ? this.getReadAloudSaveService() : undefined
      });
    } catch (error) {
      new Notice(`Read aloud failed: ${this.errorMessage(error)}`);
      return;
    }

    let listening = true;
    const modal = new ReadAloudProgressModal(
      this.config.app,
      target.file.basename,
      () => {
        // User dismissed: stop playback, stop reacting to progress. A chosen
        // save continues in the background and inserts its embed on completion.
        listening = false;
        session.stopPlayback();
      }
    );

    session.onProgress((done, total) => {
      if (listening) {
        modal.setProgress(done, total);
      }
    });

    modal.open();

    void session.completed
      .then((result) => {
        modal.finish();
        if (result.savedPath) {
          new Notice(`Saved read-aloud audio to ${result.savedPath}`);
        }
      })
      .catch((error) => {
        modal.finish();
        new Notice(`Read aloud save failed: ${this.errorMessage(error)}`);
      });
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
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
   * Lazily build the backend ReadAloudSaveService (the save tail passed to the
   * session when saving). It holds the live Settings object and resolves the
   * storage config (incl. the settings-derived audio subfolder, never hardcoded)
   * on each call, so one cached instance stays correct across settings changes.
   */
  private getReadAloudSaveService(): ReadAloudSaveService {
    if (!this.readAloudSaveService) {
      const settings = this.config.plugin.settings;
      if (!settings) {
        throw new Error('Read aloud settings are not available yet.');
      }
      this.readAloudSaveService = new ReadAloudSaveService(
        this.config.app,
        this.config.app.vault,
        settings
      );
    }
    return this.readAloudSaveService;
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
