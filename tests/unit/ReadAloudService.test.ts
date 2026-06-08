import type { Editor, TFile } from 'obsidian';
import {
  ReadAloudService,
  type AudioPlaybackFactory,
  type AudioPlaybackHandle,
  type ReadAloudSaveTail
} from '../../src/services/readAloud/ReadAloudService';
import { SpeechSynthesisService } from '../../src/services/readAloud/SpeechSynthesisService';
import type { SpeechSynthesisResult } from '../../src/services/readAloud/SpeechSynthesisTypes';
import {
  DEFAULT_LLM_PROVIDER_SETTINGS,
  type LLMProviderConfig,
  type LLMProviderSettings
} from '../../src/types/llm/ProviderTypes';

function providerConfig(overrides: Partial<LLMProviderConfig> = {}): LLMProviderConfig {
  return {
    apiKey: 'test-key',
    enabled: true,
    ...overrides
  };
}

function makeSettings(overrides: Partial<LLMProviderSettings> = {}): LLMProviderSettings {
  return {
    ...DEFAULT_LLM_PROVIDER_SETTINGS,
    providers: {
      ...DEFAULT_LLM_PROVIDER_SETTINGS.providers,
      ...overrides.providers
    },
    ...overrides
  };
}

class FakePlaybackHandle implements AudioPlaybackHandle {
  played: Array<{ audioData: ArrayBuffer; mimeType: string }> = [];
  stopped = false;

  async play(audioData: ArrayBuffer, mimeType: string): Promise<void> {
    this.played.push({ audioData, mimeType });
  }

  stop(): void {
    this.stopped = true;
  }
}

class FakePlaybackFactory implements AudioPlaybackFactory {
  handles: FakePlaybackHandle[] = [];

  create(): AudioPlaybackHandle {
    const handle = new FakePlaybackHandle();
    this.handles.push(handle);
    return handle;
  }
}

describe('ReadAloudService', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('preprocesses markdown and plays generated audio', async () => {
    const synthesizeSpy = jest.spyOn(SpeechSynthesisService.prototype, 'synthesize')
      .mockResolvedValue({
        provider: 'openai',
        model: 'gpt-4o-mini-tts',
        voice: 'marin',
        audioData: new Uint8Array([1, 2, 3]).buffer,
        mimeType: 'audio/mpeg'
      });

    const playbackFactory = new FakePlaybackFactory();
    const service = new ReadAloudService(makeSettings({
      providers: {
        ...DEFAULT_LLM_PROVIDER_SETTINGS.providers,
        openai: providerConfig()
      },
      defaultSpeechModel: {
        provider: 'openai',
        model: 'gpt-4o-mini-tts',
        source: 'user'
      }
    }), playbackFactory);

    const result = await service.read({
      sourceName: 'Test note',
      markdown: [
        '---',
        'title: Hidden',
        '---',
        '# Visible heading',
        'Read **this** aloud.'
      ].join('\n')
    });

    expect(result).toEqual({ sourceName: 'Test note', chunkCount: 1 });
    expect(synthesizeSpy).toHaveBeenCalledWith({
      text: 'Visible heading Read this aloud.'
    });
    expect(playbackFactory.handles).toHaveLength(1);
    expect(playbackFactory.handles[0].played).toHaveLength(1);
    expect(playbackFactory.handles[0].stopped).toBe(true);
  });
});

// ── v2 play-and-capture session ───────────────────────────────────────────────

/** A playback handle whose play() can be made to block until stopped. */
class ControllablePlaybackHandle implements AudioPlaybackHandle {
  played: Array<{ audioData: ArrayBuffer; mimeType: string }> = [];
  stopped = false;
  private rejectPlay: ((e: Error) => void) | null = null;

  constructor(private readonly block: boolean) {}

  play(audioData: ArrayBuffer, mimeType: string): Promise<void> {
    this.played.push({ audioData, mimeType });
    if (!this.block) {
      return Promise.resolve();
    }
    // Block until stop() rejects with the canonical sentinel (mirrors BrowserAudioPlaybackHandle).
    return new Promise<void>((_resolve, reject) => {
      this.rejectPlay = reject;
    });
  }

  stop(): void {
    this.stopped = true;
    this.rejectPlay?.(new Error('Read aloud playback was stopped.'));
    this.rejectPlay = null;
  }
}

class ControllablePlaybackFactory implements AudioPlaybackFactory {
  handles: ControllablePlaybackHandle[] = [];
  /** Indices (0-based chunk) whose play() should block until stopPlayback. */
  constructor(private readonly blockingIndices: Set<number> = new Set()) {}

  create(): AudioPlaybackHandle {
    const handle = new ControllablePlaybackHandle(this.blockingIndices.has(this.handles.length));
    this.handles.push(handle);
    return handle;
  }
}

function makeSessionService(
  playbackFactory: AudioPlaybackFactory,
  audioMime = 'audio/mpeg'
): { service: ReadAloudService; synthSpy: jest.SpyInstance } {
  const synthSpy = jest
    .spyOn(SpeechSynthesisService.prototype, 'synthesize')
    .mockImplementation(async ({ text }: { text: string }) => ({
      provider: 'openai',
      model: 'gpt-4o-mini-tts',
      voice: 'marin',
      audioData: new Uint8Array([text.length & 0xff]).buffer,
      mimeType: audioMime
    } as SpeechSynthesisResult));

  const service = new ReadAloudService(
    makeSettings({
      providers: { ...DEFAULT_LLM_PROVIDER_SETTINGS.providers, openai: providerConfig() },
      defaultSpeechModel: { provider: 'openai', model: 'gpt-4o-mini-tts', source: 'user' }
    }),
    playbackFactory
  );
  return { service, synthSpy };
}

/** A markdown long enough to split into N chunks (each ~one sentence per maxChunkChars). */
function multiChunkMarkdown(): string {
  // MarkdownSpeechPreprocessor splits at ~3,600 chars. Build 3 long paragraphs.
  const para = 'This sentence is repeated many times to fill a chunk. '.repeat(80);
  return [para, para, para].join('\n\n');
}

function fakeFile(name = 'Note.md'): TFile {
  return { basename: name.replace(/\.md$/, ''), path: name, name } as unknown as TFile;
}

describe('ReadAloudService.startReadAloudSession', () => {
  afterEach(() => jest.restoreAllMocks());

  it('save=false: plays each chunk once, never double-synths, resolves with no savedPath', async () => {
    const playbackFactory = new ControllablePlaybackFactory();
    const { service, synthSpy } = makeSessionService(playbackFactory);
    const markdown = multiChunkMarkdown();

    const session = service.startReadAloudSession({
      mode: 'note',
      file: fakeFile(),
      markdown,
      save: false
    });

    const progress: Array<[number, number]> = [];
    session.onProgress((d, t) => progress.push([d, t]));

    const out = await session.completed;
    expect(out).toEqual({}); // no savedPath
    // One synth per chunk (no double-synth) and one playback per chunk.
    expect(synthSpy).toHaveBeenCalledTimes(playbackFactory.handles.length);
    expect(playbackFactory.handles.length).toBeGreaterThan(1);
    playbackFactory.handles.forEach((h) => expect(h.played).toHaveLength(1));
    // Progress: an initial (0, total) tick, then once per chunk, ending at total.
    const total = playbackFactory.handles.length;
    expect(progress[0]).toEqual([0, total]);
    expect(progress.length).toBe(total + 1);
    expect(progress[progress.length - 1]).toEqual([total, total]);
  });

  it('save=true with stopPlayback mid-run: continues synth-only and still saves all chunks (no double-synth)', async () => {
    // First chunk's play() blocks; we stopPlayback while it's in flight. The loop
    // must continue synthesizing the remaining chunks WITHOUT playing them, then save.
    const playbackFactory = new ControllablePlaybackFactory(new Set([0]));
    const { service, synthSpy } = makeSessionService(playbackFactory, 'audio/mpeg');

    const captured: SpeechSynthesisResult[][] = [];
    const saveService: ReadAloudSaveTail = {
      saveCapturedNote: jest.fn(async (results) => {
        captured.push(results);
        return 'Nexus/audio/Note - 20260608-000000.mp3';
      }),
      saveCapturedSelection: jest.fn(async () => 'unused')
    };

    const markdown = multiChunkMarkdown();
    const session = service.startReadAloudSession({
      mode: 'note',
      file: fakeFile(),
      markdown,
      save: true,
      saveService
    });

    const progress: Array<[number, number]> = [];
    session.onProgress((d, t) => progress.push([d, t]));

    // Let the first chunk synthesize + start playing, then stop playback.
    await new Promise((r) => setTimeout(r, 0));
    session.stopPlayback();

    const out = await session.completed;

    // Save completed despite the cancel.
    expect(out.savedPath).toMatch(/\.mp3$/);
    expect(saveService.saveCapturedNote).toHaveBeenCalledTimes(1);

    const totalChunks = synthSpy.mock.calls.length;
    expect(totalChunks).toBeGreaterThan(1);
    // Exactly ONE synth per chunk — no double-synthesis for the save tail.
    expect(captured[0]).toHaveLength(totalChunks);
    // Only the first chunk was played (the rest were synth-only after stop).
    expect(playbackFactory.handles[0].played).toHaveLength(1);
    expect(playbackFactory.handles).toHaveLength(1);
    // Progress kept ticking through the synth-only phase, ending at total.
    expect(progress[progress.length - 1]).toEqual([totalChunks, totalChunks]);
  });

  it('save=true to completion: saves and resolves with the saved path', async () => {
    const playbackFactory = new ControllablePlaybackFactory();
    const { service } = makeSessionService(playbackFactory);
    const saveService: ReadAloudSaveTail = {
      saveCapturedNote: jest.fn(async () => 'Nexus/audio/Note - 20260608-000000.mp3'),
      saveCapturedSelection: jest.fn(async () => 'unused')
    };

    const session = service.startReadAloudSession({
      mode: 'note',
      file: fakeFile(),
      markdown: multiChunkMarkdown(),
      save: true,
      saveService
    });

    const out = await session.completed;
    expect(out.savedPath).toBe('Nexus/audio/Note - 20260608-000000.mp3');
    expect(saveService.saveCapturedNote).toHaveBeenCalledTimes(1);
  });

  it('completed REJECTS when the save tail throws', async () => {
    const playbackFactory = new ControllablePlaybackFactory();
    const { service } = makeSessionService(playbackFactory);
    const saveService: ReadAloudSaveTail = {
      saveCapturedNote: jest.fn(async () => {
        throw new Error('An audio file already exists at Nexus/audio/x.mp3.');
      }),
      saveCapturedSelection: jest.fn(async () => 'unused')
    };

    const session = service.startReadAloudSession({
      mode: 'note',
      file: fakeFile(),
      markdown: multiChunkMarkdown(),
      save: true,
      saveService
    });

    await expect(session.completed).rejects.toThrow(/already exists/);
  });

  it('completed REJECTS when there is no readable text', async () => {
    const playbackFactory = new ControllablePlaybackFactory();
    const { service } = makeSessionService(playbackFactory);

    const session = service.startReadAloudSession({
      mode: 'note',
      file: fakeFile(),
      markdown: '---\ntitle: only metadata\n---',
      save: false
    });

    await expect(session.completed).rejects.toThrow(/no readable text/);
  });

  it('throws synchronously when save=true without a save service', () => {
    const playbackFactory = new ControllablePlaybackFactory();
    const { service } = makeSessionService(playbackFactory);

    expect(() =>
      service.startReadAloudSession({
        mode: 'note',
        file: fakeFile(),
        markdown: 'hello world',
        save: true
      })
    ).toThrow(/save service is required/);
  });

  it('selection save routes to saveCapturedSelection with the editor + selection text', async () => {
    const playbackFactory = new ControllablePlaybackFactory();
    const { service } = makeSessionService(playbackFactory);
    const editor = { getCursor: () => ({ line: 0, ch: 0 }), replaceRange: jest.fn() } as unknown as Editor;
    const saveService: ReadAloudSaveTail = {
      saveCapturedNote: jest.fn(async () => 'unused'),
      saveCapturedSelection: jest.fn(async () => 'Nexus/audio/Src - hi - 20260608-000000.mp3')
    };

    const session = service.startReadAloudSession({
      mode: 'selection',
      file: fakeFile('Src.md'),
      markdown: 'hi there reader',
      selection: 'hi there reader',
      save: true,
      editor,
      saveService
    });

    const out = await session.completed;
    expect(out.savedPath).toMatch(/^Nexus\/audio\/Src/);
    expect(saveService.saveCapturedSelection).toHaveBeenCalledTimes(1);
    const args = (saveService.saveCapturedSelection as jest.Mock).mock.calls[0];
    expect(args[1]).toBe(editor);
    expect(args[3]).toBe('hi there reader');
  });
});

/**
 * A playback handle whose play() REJECTS with a chosen error on a chosen 0-based
 * chunk index — used to drive the non-sentinel-error propagation path. Default
 * message is a NON-sentinel error so it must propagate (not be swallowed).
 */
class ErroringPlaybackHandle implements AudioPlaybackHandle {
  played: Array<{ audioData: ArrayBuffer; mimeType: string }> = [];
  stopped = false;
  constructor(private readonly shouldReject: boolean, private readonly message: string) {}

  play(audioData: ArrayBuffer, mimeType: string): Promise<void> {
    this.played.push({ audioData, mimeType });
    return this.shouldReject ? Promise.reject(new Error(this.message)) : Promise.resolve();
  }

  stop(): void {
    this.stopped = true;
  }
}

class ErroringPlaybackFactory implements AudioPlaybackFactory {
  handles: ErroringPlaybackHandle[] = [];
  constructor(
    private readonly failIndex: number,
    private readonly message = 'Audio playback failed.'
  ) {}

  create(): AudioPlaybackHandle {
    const handle = new ErroringPlaybackHandle(this.handles.length === this.failIndex, this.message);
    this.handles.push(handle);
    return handle;
  }
}

describe('ReadAloudService.startReadAloudSession — v2 edge hardening', () => {
  afterEach(() => jest.restoreAllMocks());

  // (b) NON-sentinel playback error PROPAGATES and rejects completed.
  it('completed REJECTS when a NON-sentinel playback error occurs mid-run', async () => {
    const playbackFactory = new ErroringPlaybackFactory(1, 'Audio playback failed.');
    const { service, synthSpy } = makeSessionService(playbackFactory);

    const session = service.startReadAloudSession({
      mode: 'note',
      file: fakeFile(),
      markdown: multiChunkMarkdown(),
      save: false
    });

    await expect(session.completed).rejects.toThrow('Audio playback failed.');
    // The loop aborted on the unhandled throw at chunk 1 (0-based) — chunk 2 (index 2)
    // was never synthesized. So synth ran for chunks 0 and 1 only.
    expect(synthSpy.mock.calls.length).toBe(2);
  });

  // (b) sentinel contract guard: the EXACT stop sentinel must be SWALLOWED (no reject).
  // Pairs with the test above — if the sentinel wording ever drifts, one of these fails.
  it('does NOT reject when play() rejects with the EXACT stop sentinel (swallowed)', async () => {
    // failIndex 0 rejects chunk 0's play with the canonical stop sentinel.
    const playbackFactory = new ErroringPlaybackFactory(0, 'Read aloud playback was stopped.');
    const { service, synthSpy } = makeSessionService(playbackFactory);

    const session = service.startReadAloudSession({
      mode: 'note',
      file: fakeFile(),
      markdown: multiChunkMarkdown(),
      save: false
    });

    // Resolves (no reject) — the sentinel is swallowed and the loop continues
    // synth-only through ALL chunks.
    const out = await session.completed;
    expect(out).toEqual({});
    expect(synthSpy.mock.calls.length).toBeGreaterThan(1);
  });

  // (2, backend target) SYNTH failure mid-loop rejects completed AND (save case)
  // writes NO partial file — the save tail is never reached.
  it('completed REJECTS when synthesize() throws mid-loop and writes NO partial file', async () => {
    const playbackFactory = new ControllablePlaybackFactory();
    // Make synth succeed for chunk 0, throw on chunk 1.
    let call = 0;
    const synthSpy = jest
      .spyOn(SpeechSynthesisService.prototype, 'synthesize')
      .mockImplementation(async ({ text }: { text: string }) => {
        call += 1;
        if (call === 2) {
          throw new Error('Speech synthesis failed (HTTP 500).');
        }
        return {
          provider: 'openai',
          model: 'gpt-4o-mini-tts',
          voice: 'marin',
          audioData: new Uint8Array([text.length & 0xff]).buffer,
          mimeType: 'audio/mpeg'
        } as SpeechSynthesisResult;
      });
    const service = new ReadAloudService(
      makeSettings({
        providers: { ...DEFAULT_LLM_PROVIDER_SETTINGS.providers, openai: providerConfig() },
        defaultSpeechModel: { provider: 'openai', model: 'gpt-4o-mini-tts', source: 'user' }
      }),
      playbackFactory
    );

    const saveService: ReadAloudSaveTail = {
      saveCapturedNote: jest.fn(async () => 'should-not-be-called'),
      saveCapturedSelection: jest.fn(async () => 'should-not-be-called')
    };

    const session = service.startReadAloudSession({
      mode: 'note',
      file: fakeFile(),
      markdown: multiChunkMarkdown(),
      save: true,
      saveService
    });

    await expect(session.completed).rejects.toThrow(/HTTP 500/);
    // No partial file: the save tail is never reached on a mid-loop synth failure.
    expect(saveService.saveCapturedNote).not.toHaveBeenCalled();
    expect(synthSpy.mock.calls.length).toBe(2); // chunk 0 ok, chunk 1 threw, stopped
  });

  // (1, backend target) Single-synth invariant when stopped AFTER chunk K plays:
  // chunk 0 plays, stop after it, remaining chunks synth-only, exactly N synth calls.
  it('stop AFTER chunk 0 plays: only chunk 0 played, all chunks synth-only saved, N synths', async () => {
    // Block chunk 0 so we can stop while it is the active playback.
    const playbackFactory = new ControllablePlaybackFactory(new Set([0]));
    const { service, synthSpy } = makeSessionService(playbackFactory, 'audio/mpeg');
    const captured: SpeechSynthesisResult[][] = [];
    const saveService: ReadAloudSaveTail = {
      saveCapturedNote: jest.fn(async (results) => {
        captured.push(results);
        return 'Nexus/audio/Note - 20260608-000000.mp3';
      }),
      saveCapturedSelection: jest.fn(async () => 'unused')
    };

    const session = service.startReadAloudSession({
      mode: 'note',
      file: fakeFile(),
      markdown: multiChunkMarkdown(),
      save: true,
      saveService
    });

    await new Promise((r) => setTimeout(r, 0)); // let chunk 0 synth + begin blocking play
    session.stopPlayback();

    const out = await session.completed;
    expect(out.savedPath).toMatch(/\.mp3$/);

    const n = synthSpy.mock.calls.length;
    expect(n).toBeGreaterThan(1);
    expect(captured[0]).toHaveLength(n); // exactly one synth per chunk → N captured
    // Only chunk 0 created a playback handle and played once; rest were synth-only.
    expect(playbackFactory.handles).toHaveLength(1);
    expect(playbackFactory.handles[0].played).toHaveLength(1);
  });

  // (1) stop BEFORE any chunk plays: a stop issued before the first play still
  // saves all chunks synth-only, with zero playback handles created.
  it('stop BEFORE chunk 0 plays: zero playback, all chunks synth-only saved', async () => {
    const playbackFactory = new ControllablePlaybackFactory();
    const { service, synthSpy } = makeSessionService(playbackFactory);
    const captured: SpeechSynthesisResult[][] = [];
    const saveService: ReadAloudSaveTail = {
      saveCapturedNote: jest.fn(async (results) => {
        captured.push(results);
        return 'Nexus/audio/Note - 20260608-000000.mp3';
      }),
      saveCapturedSelection: jest.fn(async () => 'unused')
    };

    const session = service.startReadAloudSession({
      mode: 'note',
      file: fakeFile(),
      markdown: multiChunkMarkdown(),
      save: true,
      saveService
    });
    // Stop synchronously, before the async loop body runs its first play().
    session.stopPlayback();

    const out = await session.completed;
    expect(out.savedPath).toMatch(/\.mp3$/);
    const n = synthSpy.mock.calls.length;
    expect(captured[0]).toHaveLength(n); // every chunk synthesized exactly once
    // No chunk ever played → no handle created.
    expect(playbackFactory.handles).toHaveLength(0);
  });

  // (a/3) onProgress: initial (0,total) tick + monotonic per-chunk ticks through the
  // post-stop synth-only phase. Asserted timing-robust (monotonic + endpoints), not
  // by exact array identity.
  it('onProgress emits (0,total) then monotonic ticks to (total,total) incl. post-stop phase', async () => {
    const playbackFactory = new ControllablePlaybackFactory(new Set([0]));
    const { service } = makeSessionService(playbackFactory, 'audio/mpeg');
    const saveService: ReadAloudSaveTail = {
      saveCapturedNote: jest.fn(async () => 'Nexus/audio/Note - 20260608-000000.mp3'),
      saveCapturedSelection: jest.fn(async () => 'unused')
    };

    const session = service.startReadAloudSession({
      mode: 'note',
      file: fakeFile(),
      markdown: multiChunkMarkdown(),
      save: true,
      saveService
    });

    const progress: Array<[number, number]> = [];
    session.onProgress((d, t) => progress.push([d, t]));

    await new Promise((r) => setTimeout(r, 0));
    session.stopPlayback();
    await session.completed;

    const total = progress[0][1];
    // Initial tick is (0, total).
    expect(progress[0]).toEqual([0, total]);
    // Last tick is (total, total).
    expect(progress[progress.length - 1]).toEqual([total, total]);
    // `done` is monotonically non-decreasing and `total` is constant throughout
    // (robust to exact scheduling — no order-fragile equality on the whole array).
    for (let i = 1; i < progress.length; i += 1) {
      expect(progress[i][1]).toBe(total);
      expect(progress[i][0]).toBeGreaterThanOrEqual(progress[i - 1][0]);
    }
    // One tick per chunk synthesized plus the initial tick — covers the post-stop
    // synth-only chunks too.
    expect(progress.length).toBe(total + 1);
  });

  // (5) save=true selection without an editor throws synchronously.
  it('throws synchronously when save=true selection without an editor', () => {
    const playbackFactory = new ControllablePlaybackFactory();
    const { service } = makeSessionService(playbackFactory);
    const saveService: ReadAloudSaveTail = {
      saveCapturedNote: jest.fn(async () => 'unused'),
      saveCapturedSelection: jest.fn(async () => 'unused')
    };

    expect(() =>
      service.startReadAloudSession({
        mode: 'selection',
        file: fakeFile('Src.md'),
        markdown: 'hi',
        selection: 'hi',
        save: true,
        saveService
        // editor omitted
      })
    ).toThrow(/editor is required/);
  });

  // (d) save=false NEVER touches the save service.
  it('save=false never calls saveService methods', async () => {
    const playbackFactory = new ControllablePlaybackFactory();
    const { service } = makeSessionService(playbackFactory);
    const saveService: ReadAloudSaveTail = {
      saveCapturedNote: jest.fn(async () => 'unused'),
      saveCapturedSelection: jest.fn(async () => 'unused')
    };

    const session = service.startReadAloudSession({
      mode: 'note',
      file: fakeFile(),
      markdown: multiChunkMarkdown(),
      save: false,
      saveService // present but must be ignored when save=false
    });

    await session.completed;
    expect(saveService.saveCapturedNote).not.toHaveBeenCalled();
    expect(saveService.saveCapturedSelection).not.toHaveBeenCalled();
  });
});
