/**
 * Location: src/services/readAloud/ReadAloudSaveService.ts
 *
 * Backend SAVE-TAIL for the read-aloud "save as audio" feature: given the
 * per-chunk synthesis buffers, concatenates them into ONE file via the pure
 * {@link concatAudioBuffers} helper, writes the file to the SETTINGS-DERIVED
 * audio folder, and inserts a single `![[...]]` embed into the note.
 *
 * v2 contract (called by ReadAloudService.startReadAloudSession during the
 * play-and-capture session — synthesis happens ONCE, in the session loop):
 * - saveCapturedSelection(results, editor, file, selection): write + embed after selection.
 * - saveCapturedNote(results, file): write + embed at top of body (below frontmatter).
 * Both return the saved vault-relative path and THROW on failure (the session's
 * `completed` promise rejects; the UI catches + Notices).
 *
 * The synthesize-then-save methods {@link saveSelectionAsAudio} /
 * {@link saveNoteAsAudio} are RETAINED as test seams that drive the full
 * capture→write→embed pipeline; production traffic goes through the session.
 *
 * Mobile-safe: no AudioContext family, no Node built-ins, no Composer. See
 * docs/plans/read-aloud-save-embed-scoping.md §1b.
 */

import { App, Editor, normalizePath, TFile, TFolder, Vault } from 'obsidian';
import type { Settings } from '../../settings';
import { DEFAULT_STORAGE_SETTINGS } from '../../types/plugin/PluginTypes';
import { tryResolveVaultPath } from '../../core/vaultPath';
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
   * Persist ALREADY-captured selection buffers (from the v2 play-and-capture
   * session) to one audio file and insert the `![[...]]` embed after the selection.
   * No synthesis happens here — the session synthesized each chunk exactly once.
   * Selection is usually one chunk (N=1), so concat is a no-op pass-through.
   * Returns the saved vault-relative path; throws on failure.
   */
  async saveCapturedSelection(
    results: SpeechSynthesisResult[],
    editor: Editor,
    file: TFile,
    selection: string
  ): Promise<string> {
    const { filename, outputPath } = await this.writeCaptured(
      results,
      this.buildSelectionFilenameStem(file.basename, selection)
    );

    // Insert the embed on its own line after the selection's end.
    const to = editor.getCursor('to');
    const embed = `\n\n${this.buildEmbed(filename)}\n`;
    editor.replaceRange(embed, to);
    return outputPath;
  }

  /**
   * Persist ALREADY-captured whole-note buffers (from the v2 session) to one
   * concatenated audio file and insert the `![[...]]` embed at the top of the note
   * body (below YAML frontmatter, if any). No synthesis happens here. Returns the
   * saved vault-relative path; throws on failure.
   */
  async saveCapturedNote(results: SpeechSynthesisResult[], file: TFile): Promise<string> {
    const { filename, outputPath } = await this.writeCaptured(
      results,
      this.buildNoteFilenameStem(file.basename)
    );

    const embed = this.buildEmbed(filename);
    await this.vault.process(file, (content) => this.prependBelowFrontmatter(content, embed));
    return outputPath;
  }

  /**
   * RETAINED test seam: synthesize the current editor selection (capturing, no
   * playback) and persist it via {@link saveCapturedSelection}. The v2 session
   * does NOT call this — it captures during play-and-capture so synthesis happens
   * once. Kept to exercise the full capture→write→embed pipeline in unit tests.
   */
  async saveSelectionAsAudio(editor: Editor, file: TFile): Promise<void> {
    const selection = editor.getSelection();
    if (!selection.trim()) {
      throw new Error('Select text to save as audio.');
    }

    const results = await this.captureResults(selection);
    await this.saveCapturedSelection(results, editor, file, selection);
  }

  /**
   * RETAINED test seam: synthesize a whole note (capturing, no playback) and
   * persist it via {@link saveCapturedNote}. See {@link saveSelectionAsAudio}.
   */
  async saveNoteAsAudio(file: TFile): Promise<void> {
    const markdown = await this.vault.cachedRead(file);
    const results = await this.captureResults(markdown);
    await this.saveCapturedNote(results, file);
  }

  /**
   * Capture-synthesize text chunk-by-chunk (no playback) and return the per-chunk
   * results. Used only by the retained synthesize-then-save seams; the v2 session
   * supplies its own captured results.
   */
  private async captureResults(text: string): Promise<SpeechSynthesisResult[]> {
    const service = this.buildCaptureService();
    return service.synthesizeForCapture({ markdown: text });
  }

  /**
   * Shared write tail: validate + concat the captured buffers to one buffer, derive
   * the settings-rooted output path with the provider-native extension, and write
   * it. Returns the saved file's basename (for the embed) and the vault path.
   */
  private async writeCaptured(
    results: SpeechSynthesisResult[],
    filenameStem: string
  ): Promise<{ filename: string; mimeType: string; outputPath: string }> {
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

    return { filename, mimeType, outputPath };
  }

  /**
   * Extract a SpeechSynthesisResult's audioData. Adapters already return a true
   * ArrayBuffer (see SpeechSynthesisResult.audioData), so this is a direct
   * pass-through used as the map projection into concatAudioBuffers.
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
    if (!tryResolveVaultPath(path).ok) {
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
