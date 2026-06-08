/**
 * Location: src/services/readAloud/ReadAloudSaveService.ts
 *
 * Backend engine for the read-aloud "save as audio" feature. Synthesizes a
 * selection or a whole note to audio (capturing buffers, never playing),
 * concatenates them into ONE file via the pure {@link concatAudioBuffers}
 * helper, writes the file to the SETTINGS-DERIVED audio folder, and inserts a
 * single `![[...]]` embed into the note.
 *
 * Public contract (called by ReadAloudCommandManager / UI — frontend-coder):
 * - saveSelectionAsAudio(editor, file): synth selection, embed after selection.
 * - saveNoteAsAudio(file): synth whole note, embed at top of body.
 * Both return Promise<void> and THROW on failure (caller catches + Notices).
 *
 * Mobile-safe: no AudioContext family, no Node built-ins, no Composer. See
 * docs/plans/read-aloud-save-embed-scoping.md.
 */

import { App, Editor, normalizePath, TFile, TFolder, Vault } from 'obsidian';
import type { Settings } from '../../settings';
import { DEFAULT_STORAGE_SETTINGS } from '../../types/plugin/PluginTypes';
import { isValidPath } from '../../utils/pathUtils';
import { concatAudioBuffers } from './concatAudioBuffers';
import { ReadAloudService } from './ReadAloudService';
import type { SpeechSynthesisResult } from './SpeechSynthesisTypes';

/** Default audio subfolder under the storage root when none is configured. */
const DEFAULT_AUDIO_SUBFOLDER = 'audio';

/** Maps a synthesized mimeType to its file extension (mirrors AudioGenerationService). */
const MIME_TO_EXTENSION: Readonly<Record<string, string>> = {
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
};

/** Max characters kept from a selection snippet in the filename. */
const MAX_SNIPPET_CHARS = 40;

export class ReadAloudSaveService {
  constructor(
    private readonly app: App,
    private readonly vault: Vault,
    private readonly settings: Settings
  ) {}

  /**
   * Synthesize the current editor selection to a single audio file and insert an
   * `![[...]]` embed immediately after the selection. Selection is usually one
   * chunk (N=1), so concat is a no-op pass-through.
   */
  async saveSelectionAsAudio(editor: Editor, file: TFile): Promise<void> {
    const selection = editor.getSelection();
    if (!selection.trim()) {
      throw new Error('Select text to save as audio.');
    }

    const { basename, mimeType } = await this.synthesizeAndWrite(
      selection,
      this.buildSelectionFilenameStem(file.basename, selection),
      undefined
    );
    void mimeType;

    // Insert the embed on its own line after the selection's end.
    const to = editor.getCursor('to');
    const embed = `\n\n${this.buildEmbed(basename)}\n`;
    editor.replaceRange(embed, to);
  }

  /**
   * Synthesize a whole note to a single concatenated audio file and insert one
   * `![[...]]` embed at the top of the note body (below YAML frontmatter, if any).
   */
  async saveNoteAsAudio(file: TFile): Promise<void> {
    const markdown = await this.vault.cachedRead(file);

    const { basename } = await this.synthesizeAndWrite(
      markdown,
      this.buildNoteFilenameStem(file.basename),
      undefined
    );

    const embed = this.buildEmbed(basename);
    await this.vault.process(file, (content) => this.prependBelowFrontmatter(content, embed));
  }

  /**
   * Shared pipeline: capture-synthesize the text (no playback), concat to one
   * buffer, derive the settings-rooted output path with the provider-native
   * extension, and write it via the temp-swap pattern. Returns the saved file's
   * basename (for the embed) and the audio mimeType.
   */
  private async synthesizeAndWrite(
    text: string,
    filenameStem: string,
    onProgress?: (completed: number, total: number) => void
  ): Promise<{ basename: string; mimeType: string }> {
    const service = this.buildCaptureService();
    const results = await service.synthesizeForCapture({ markdown: text }, onProgress);
    if (results.length === 0) {
      throw new Error('There is no readable text to save as audio.');
    }

    const mimeType = results[0].mimeType;
    const extension = MIME_TO_EXTENSION[mimeType.toLowerCase()];
    if (!extension) {
      throw new Error(`Synthesized audio has an unsupported format "${mimeType}".`);
    }

    const merged = concatAudioBuffers(results.map(this.toAudioBuffer), mimeType);

    const filename = `${filenameStem}.${extension}`;
    const outputPath = this.resolveOutputPath(filename);
    await this.writeAudio(outputPath, merged);

    return { basename: filename, mimeType };
  }

  /**
   * Normalize a SpeechSynthesisResult's audioData to a true ArrayBuffer. Adapters
   * return ArrayBuffer today, but guard against a typed-array slice so concat
   * never sees a SharedArrayBuffer/typed-array view.
   */
  private toAudioBuffer = (result: SpeechSynthesisResult): ArrayBuffer => {
    return result.audioData;
  };

  private buildCaptureService(): ReadAloudService {
    const llmSettings = this.settings.settings.llmProviders ?? null;
    const appsSettings = this.settings.settings.apps;
    return new ReadAloudService(llmSettings, appsSettings);
  }

  // ── Path resolution (SETTINGS-DERIVED — never hardcode the root) ──────────

  /**
   * Build the vault-relative output path `<rootPath>/<audioSubfolder>/<filename>`.
   * rootPath + audioSubfolder are read from settings with defaults; the literal
   * storage-root name is NEVER hardcoded so audio follows the user's configured
   * storage root.
   */
  private resolveOutputPath(filename: string): string {
    const storage = this.settings.settings.storage as
      | { rootPath?: string; audioSubfolder?: string }
      | undefined;
    const rootPath = storage?.rootPath ?? DEFAULT_STORAGE_SETTINGS.rootPath;
    const subfolder = storage?.audioSubfolder?.trim() || DEFAULT_AUDIO_SUBFOLDER;

    const path = normalizePath(`${rootPath}/${subfolder}/${filename}`);
    if (!isValidPath(path)) {
      throw new Error(`Resolved an invalid audio output path "${path}".`);
    }
    return path;
  }

  // ── Filenames (timestamped, always-new, sanitized) ────────────────────────

  private buildNoteFilenameStem(noteBasename: string): string {
    return `${this.sanitize(noteBasename)} - ${this.timestamp()}`;
  }

  private buildSelectionFilenameStem(noteBasename: string, selection: string): string {
    const snippet = this.sanitize(this.snippetOf(selection));
    const base = this.sanitize(noteBasename);
    return snippet
      ? `${base} - ${snippet} - ${this.timestamp()}`
      : `${base} - ${this.timestamp()}`;
  }

  /** First few words of the selection, capped at MAX_SNIPPET_CHARS. */
  private snippetOf(selection: string): string {
    const words = selection.trim().split(/\s+/).slice(0, 5).join(' ');
    return words.length > MAX_SNIPPET_CHARS ? words.slice(0, MAX_SNIPPET_CHARS).trim() : words;
  }

  /**
   * Strip filename-illegal characters. normalizePath does NOT remove these, so a
   * raw note basename like "A/B: C?" would corrupt the path. Collapse runs of
   * removed/whitespace chars to single spaces and trim.
   */
  private sanitize(value: string): string {
    return value
      .replace(/[\\/:*?"<>|[\]#^]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /** Sortable local timestamp `YYYYMMDD-HHmmss`. */
  private timestamp(): string {
    const now = new Date();
    const pad = (n: number): string => String(n).padStart(2, '0');
    return (
      `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
      `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
    );
  }

  // ── Embed insertion ───────────────────────────────────────────────────────

  private buildEmbed(basename: string): string {
    return `![[${basename}]]`;
  }

  /**
   * Prepend the embed at the top of the note BODY: after a leading YAML
   * frontmatter block if present (so the embed never lands inside/above
   * frontmatter and corrupts it), otherwise at the very top.
   */
  private prependBelowFrontmatter(content: string, embed: string): string {
    const block = `${embed}\n\n`;
    if (!content.startsWith('---')) {
      return `${block}${content}`;
    }

    // Find the closing '---' of the frontmatter block.
    const lines = content.split('\n');
    if (lines[0].trim() !== '---') {
      return `${block}${content}`;
    }
    for (let index = 1; index < lines.length; index += 1) {
      if (lines[index].trim() === '---') {
        const head = lines.slice(0, index + 1).join('\n');
        const rest = lines.slice(index + 1).join('\n');
        const separator = rest.startsWith('\n') ? '\n' : '\n\n';
        return `${head}${separator}${block}${rest.replace(/^\n+/, '')}`;
      }
    }
    // Unterminated frontmatter — treat the whole thing as body to be safe.
    return `${block}${content}`;
  }

  // ── Vault write (ensureParentDirectory + createBinary; mirrors the
  //    AudioGenerationService.writeAudio pattern) ────────────────────────────

  private async writeAudio(outputPath: string, audioData: ArrayBuffer): Promise<void> {
    await this.ensureParentDirectory(outputPath);

    // Timestamped filenames are always-new, so a collision should not happen;
    // if it does, fail rather than silently overwrite a prior render.
    const existing = this.vault.getAbstractFileByPath(outputPath);
    if (existing) {
      throw new Error(`An audio file already exists at ${outputPath}.`);
    }

    await this.vault.createBinary(outputPath, audioData);
  }

  private async ensureParentDirectory(outputPath: string): Promise<void> {
    const dir = outputPath.substring(0, outputPath.lastIndexOf('/'));
    if (!dir || this.vault.getAbstractFileByPath(dir) instanceof TFolder) {
      return;
    }

    try {
      await this.vault.createFolder(dir);
    } catch {
      if (!(this.vault.getAbstractFileByPath(dir) instanceof TFolder)) {
        throw new Error(`Failed to create audio output directory: ${dir}`);
      }
    }
  }
}
