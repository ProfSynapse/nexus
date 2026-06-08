import type { Editor, TFile } from 'obsidian';
import type { LLMProviderSettings } from '../../types/llm/ProviderTypes';
import type { AppsSettings } from '../../types/apps/AppTypes';
import { MarkdownSpeechPreprocessor, SpeechTextChunk } from './MarkdownSpeechPreprocessor';
import { SpeechSynthesisService } from './SpeechSynthesisService';
import type { SpeechSynthesisResult } from './SpeechSynthesisTypes';

export interface ReadAloudRequest {
  markdown: string;
  sourceName?: string;
}

export interface ReadAloudResult {
  sourceName?: string;
  chunkCount: number;
}

/**
 * The buffer-driven save tail the v2 session depends on. ReadAloudSaveService
 * structurally satisfies this; declaring it as a local interface (rather than
 * importing the class) breaks the ReadAloudService ⇄ ReadAloudSaveService import
 * cycle. The session captures buffers itself, then hands them here — so synthesis
 * happens exactly once, in the session loop.
 */
export interface ReadAloudSaveTail {
  saveCapturedSelection(
    results: SpeechSynthesisResult[],
    editor: Editor,
    file: TFile,
    selection: string
  ): Promise<string>;
  saveCapturedNote(results: SpeechSynthesisResult[], file: TFile): Promise<string>;
}

/**
 * Options for {@link ReadAloudService.startReadAloudSession}. `saveService` is
 * REQUIRED when `save` is true (it persists the captured buffers); ignored when
 * `save` is false. `editor` is REQUIRED when `mode` is 'selection' (for the
 * embed insert) and `selection` carries the selected text for the filename snippet.
 */
export interface ReadAloudSessionOptions {
  mode: 'selection' | 'note';
  file: TFile;
  /** Markdown to synthesize: the selection (selection mode) or whole note (note mode). */
  markdown: string;
  save: boolean;
  editor?: Editor;
  /** The raw selected text (selection mode, save case) — used for the filename snippet. */
  selection?: string;
  saveService?: ReadAloudSaveTail;
}

/**
 * A running play-and-capture read-aloud session. Playback is cancellable via
 * {@link stopPlayback}; the SAVE (when requested) is NOT — after playback stops,
 * the remaining chunks are still synthesized (synth-only) so the saved file is
 * complete. {@link onProgress} ticks per chunk synthesized, INCLUDING the
 * post-stopPlayback synth-only phase. {@link completed} resolves once playback
 * finishes naturally OR (save case) once the background save + embed completes;
 * it REJECTS on a synth/write failure.
 */
export interface ReadAloudSession {
  onProgress(cb: (done: number, total: number) => void): void;
  stopPlayback(): void;
  completed: Promise<{ savedPath?: string }>;
}

export interface AudioPlaybackHandle {
  play(audioData: ArrayBuffer, mimeType: string): Promise<void>;
  stop(): void;
}

export interface AudioPlaybackFactory {
  create(): AudioPlaybackHandle;
}

export class BrowserAudioPlaybackHandle implements AudioPlaybackHandle {
  private audio: HTMLAudioElement | null = null;
  private objectUrl: string | null = null;
  private rejectPlayback: ((error: Error) => void) | null = null;

  async play(audioData: ArrayBuffer, mimeType: string): Promise<void> {
    this.stop();
    const blob = new Blob([audioData], { type: mimeType });
    this.objectUrl = URL.createObjectURL(blob);
    this.audio = new Audio(this.objectUrl);

    await new Promise<void>((resolve, reject) => {
      const audio = this.audio;
      if (!audio) {
        reject(new Error('Audio playback was not initialized.'));
        return;
      }

      this.rejectPlayback = reject;
      audio.onended = () => {
        this.rejectPlayback = null;
        resolve();
      };
      audio.onerror = () => {
        this.rejectPlayback = null;
        reject(new Error('Audio playback failed.'));
      };
      void audio.play().catch(reject);
    });
  }

  stop(): void {
    const rejectPlayback = this.rejectPlayback;
    this.rejectPlayback = null;

    if (this.audio) {
      this.audio.pause();
      this.audio.src = '';
      this.audio.load();
      this.audio = null;
    }

    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
    }

    rejectPlayback?.(new Error('Read aloud playback was stopped.'));
  }
}

export class BrowserAudioPlaybackFactory implements AudioPlaybackFactory {
  create(): AudioPlaybackHandle {
    return new BrowserAudioPlaybackHandle();
  }
}

export class ReadAloudService {
  private speechService: SpeechSynthesisService;
  private activePlayback: AudioPlaybackHandle | null = null;
  private runId = 0;

  constructor(
    llmSettings: LLMProviderSettings | null,
    appsSettingsOrPlaybackFactory?: AppsSettings | AudioPlaybackFactory,
    private playbackFactory: AudioPlaybackFactory = new BrowserAudioPlaybackFactory()
  ) {
    const appsSettings = isAudioPlaybackFactory(appsSettingsOrPlaybackFactory)
      ? undefined
      : appsSettingsOrPlaybackFactory;
    if (isAudioPlaybackFactory(appsSettingsOrPlaybackFactory)) {
      this.playbackFactory = appsSettingsOrPlaybackFactory;
    }
    this.speechService = new SpeechSynthesisService(llmSettings, { appsSettings });
  }

  isPlaying(): boolean {
    return this.activePlayback !== null;
  }

  stop(): void {
    this.runId += 1;
    this.activePlayback?.stop();
    this.activePlayback = null;
  }

  async read(request: ReadAloudRequest): Promise<ReadAloudResult> {
    const chunks = MarkdownSpeechPreprocessor.preprocess(request.markdown);
    if (chunks.length === 0) {
      throw new Error('There is no readable text in this note.');
    }

    this.stop();
    const currentRun = this.runId;
    this.activePlayback = this.playbackFactory.create();

    try {
      for (const chunk of chunks) {
        this.assertCurrentRun(currentRun);
        await this.playChunk(chunk, currentRun);
      }

      return {
        sourceName: request.sourceName,
        chunkCount: chunks.length,
      };
    } finally {
      if (this.runId === currentRun) {
        this.activePlayback?.stop();
        this.activePlayback = null;
      }
    }
  }

  /**
   * Synthesize the markdown chunk-by-chunk and RETURN every
   * SpeechSynthesisResult WITHOUT playing any audio. This is the capture path
   * for "save as audio": it reuses the same preprocessor + speech service as
   * {@link read} but never touches playback, so saving does not force the user
   * to listen (and never double-synthesizes — each chunk is synthesized once).
   *
   * Results are returned in chunk order so the caller can concatenate them into
   * a single file. Throws if there is no readable text.
   *
   * @param onProgress optional callback after each chunk synthesizes (e.g. for a
   *   long-note progress UI). Index is 0-based; total is the chunk count.
   */
  async synthesizeForCapture(
    request: ReadAloudRequest,
    onProgress?: (completed: number, total: number) => void
  ): Promise<SpeechSynthesisResult[]> {
    const chunks = MarkdownSpeechPreprocessor.preprocess(request.markdown);
    if (chunks.length === 0) {
      throw new Error('There is no readable text in this note.');
    }

    const results: SpeechSynthesisResult[] = [];
    for (let index = 0; index < chunks.length; index += 1) {
      results.push(await this.speechService.synthesize({ text: chunks[index].text }));
      onProgress?.(index + 1, chunks.length);
    }
    return results;
  }

  /**
   * Start a v2 PLAY-AND-CAPTURE read-aloud session: synthesize each chunk ONCE,
   * play it while playback is active, and (save case) capture the SAME buffer for
   * saving — a single synth pass, never double-synthesized.
   *
   * Cancellable playback / non-cancellable save: {@link ReadAloudSession.stopPlayback}
   * halts current + further PLAYBACK, but when `save` is true the loop CONTINUES
   * synthesizing the remaining chunks (synth-only) so the saved file is complete.
   * On loop end (save case) the captured buffers are concatenated and persisted via
   * the injected save tail, and `completed` resolves with the saved path. With
   * `save` false, `completed` resolves once playback ends (or is stopped) with no
   * path. `completed` REJECTS on a synth or write failure.
   *
   * `onProgress` fires after each chunk is synthesized, INCLUDING the post-stopPlayback
   * synth-only phase — the caller detaches its listener when its UI closes.
   *
   * S2: this method orchestrates synth+playback+capture; the actual file write +
   * embed live in the {@link ReadAloudSaveTail} (ReadAloudSaveService), reused
   * unchanged.
   */
  startReadAloudSession(options: ReadAloudSessionOptions): ReadAloudSession {
    if (options.save && !options.saveService) {
      throw new Error('A save service is required to save read-aloud audio.');
    }
    if (options.save && options.mode === 'selection' && !options.editor) {
      throw new Error('An editor is required to save a selection as audio.');
    }

    // Playback is cancellable independently of the synth loop: stopPlayback flips
    // this flag (so remaining chunks skip play()) and stops the active handle (so
    // the in-flight chunk's play() promise rejects with the stop sentinel, which
    // the loop swallows). The synth loop itself is never aborted by a stop.
    let playbackStopped = false;
    let activePlayback: AudioPlaybackHandle | null = null;
    let progressCb: ((done: number, total: number) => void) | null = null;

    const stopPlayback = (): void => {
      playbackStopped = true;
      activePlayback?.stop();
      activePlayback = null;
    };

    const completed = this.runSession(options, {
      isPlaybackStopped: () => playbackStopped,
      setActivePlayback: (handle) => {
        activePlayback = handle;
      },
      clearActivePlayback: () => {
        activePlayback = null;
      },
      emitProgress: (done, total) => progressCb?.(done, total),
    });

    return {
      onProgress: (cb) => {
        progressCb = cb;
      },
      stopPlayback,
      completed,
    };
  }

  /**
   * Drives the single synth pass for a session. Synthesizes each chunk once;
   * plays it if playback is still active; collects it if saving. Swallows the
   * playback stop sentinel so a mid-run stop never aborts the save's synth loop.
   */
  private async runSession(
    options: ReadAloudSessionOptions,
    hooks: {
      isPlaybackStopped: () => boolean;
      setActivePlayback: (handle: AudioPlaybackHandle | null) => void;
      clearActivePlayback: () => void;
      emitProgress: (done: number, total: number) => void;
    }
  ): Promise<{ savedPath?: string }> {
    const chunks = MarkdownSpeechPreprocessor.preprocess(options.markdown);
    if (chunks.length === 0) {
      throw new Error('There is no readable text in this note.');
    }

    // Yield one microtask so the synchronous caller can register its onProgress
    // listener (startReadAloudSession returns BEFORE this body runs), then emit an
    // initial (0, total) tick so a progress UI can show "0 of N" before chunk 1.
    await Promise.resolve();
    hooks.emitProgress(0, chunks.length);

    const captured: SpeechSynthesisResult[] = [];

    for (let index = 0; index < chunks.length; index += 1) {
      // ONE synthesis per chunk — the buffer is reused for both play and save.
      const result = await this.speechService.synthesize({ text: chunks[index].text });
      if (options.save) {
        captured.push(result);
      }

      if (!hooks.isPlaybackStopped()) {
        await this.playSessionChunk(result, hooks);
      }

      hooks.emitProgress(index + 1, chunks.length);
    }

    hooks.clearActivePlayback();

    if (!options.save) {
      return {};
    }

    const savedPath = await this.persistCaptured(options, captured);
    return { savedPath };
  }

  /**
   * Play a single already-synthesized chunk. If playback is stopped mid-chunk the
   * handle rejects with the stop sentinel; we SWALLOW that one sentinel so the
   * surrounding synth loop continues (for the save). Any other playback error
   * propagates and rejects the session's `completed`.
   */
  private async playSessionChunk(
    result: SpeechSynthesisResult,
    hooks: {
      isPlaybackStopped: () => boolean;
      setActivePlayback: (handle: AudioPlaybackHandle | null) => void;
    }
  ): Promise<void> {
    const playback = this.playbackFactory.create();
    hooks.setActivePlayback(playback);
    try {
      await playback.play(result.audioData, result.mimeType);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message === 'Read aloud playback was stopped.') {
        return; // expected cancel — continue the loop (synth-only) for the save
      }
      throw error;
    } finally {
      hooks.setActivePlayback(null);
    }
  }

  /** Persist the captured session buffers via the injected save tail. */
  private async persistCaptured(
    options: ReadAloudSessionOptions,
    captured: SpeechSynthesisResult[]
  ): Promise<string> {
    const saveService = options.saveService;
    if (!saveService) {
      throw new Error('A save service is required to save read-aloud audio.');
    }

    if (options.mode === 'selection') {
      if (!options.editor) {
        throw new Error('An editor is required to save a selection as audio.');
      }
      return saveService.saveCapturedSelection(
        captured,
        options.editor,
        options.file,
        options.selection ?? options.markdown
      );
    }
    return saveService.saveCapturedNote(captured, options.file);
  }

  private async playChunk(chunk: SpeechTextChunk, runId: number): Promise<void> {
    const playback = this.activePlayback;
    if (!playback) {
      throw new Error('Read aloud playback was stopped.');
    }

    const result = await this.speechService.synthesize({ text: chunk.text });
    this.assertCurrentRun(runId);
    await playback.play(result.audioData, result.mimeType);
  }

  private assertCurrentRun(runId: number): void {
    if (this.runId !== runId) {
      throw new Error('Read aloud playback was stopped.');
    }
  }
}

function isAudioPlaybackFactory(value: AppsSettings | AudioPlaybackFactory | undefined): value is AudioPlaybackFactory {
  return typeof value === 'object' && value !== null && typeof (value as AudioPlaybackFactory).create === 'function';
}
