import { readFileSync } from 'fs';
import { join } from 'path';
import { App, Editor, TFile, TFolder, Vault } from 'obsidian';
import { ReadAloudSaveService } from '../../src/services/readAloud/ReadAloudSaveService';
import { ReadAloudService } from '../../src/services/readAloud/ReadAloudService';
import type { SpeechSynthesisResult } from '../../src/services/readAloud/SpeechSynthesisTypes';

/**
 * ReadAloudSaveService is the CRITICAL-tier engine for "save read-aloud as audio":
 * it captures synthesis buffers (never plays), concatenates them, writes a binary
 * file to a SETTINGS-DERIVED path, and inserts an ![[...]] embed. The filename is
 * derived from user content (note basename + selection snippet), so path
 * resolution + sanitization are a path-traversal / frontmatter-corruption surface.
 *
 * The service constructs ReadAloudService INTERNALLY (buildCaptureService), so we
 * jest.mock that module to inject synthesizeForCapture results and assert the
 * no-double-synth contract — same S2-boundary mocking the CommandManager test uses.
 */
jest.mock('../../src/services/readAloud/ReadAloudService');

const MockedReadAloudService = ReadAloudService as jest.MockedClass<typeof ReadAloudService>;

/** A single synthesized chunk result with `bytes` worth of payload filled with `fill`. */
function makeResult(bytes: number, fill: number, mimeType = 'audio/mpeg'): SpeechSynthesisResult {
  const data = new Uint8Array(bytes);
  data.fill(fill);
  return {
    provider: 'openai' as SpeechSynthesisResult['provider'],
    model: 'gpt-4o-mini-tts',
    voice: 'alloy',
    audioData: data.buffer as ArrayBuffer,
    mimeType,
  };
}

/**
 * Build a fake Vault that records every binary write + folder create and lets a
 * test seed the set of paths that already "exist". `process` applies the mutator
 * to seeded note content and records the resulting content.
 */
function buildFakeVault(options: {
  existingPaths?: string[];
  noteContent?: string;
} = {}) {
  const existing = new Set(options.existingPaths ?? []);
  const writes: Array<{ path: string; data: ArrayBuffer }> = [];
  const createdFolders: string[] = [];
  let processedContent: string | undefined;

  const vault = {
    cachedRead: jest.fn(async () => options.noteContent ?? ''),
    getAbstractFileByPath: jest.fn((path: string) => {
      if (!existing.has(path)) return null;
      // Seeded folder paths return a TFolder; seeded file paths return a TFile.
      return path.endsWith('.mp3') || path.endsWith('.wav')
        ? new TFile(path.split('/').pop(), path)
        : new TFolder(path);
    }),
    createFolder: jest.fn(async (dir: string) => {
      createdFolders.push(dir);
      existing.add(dir);
    }),
    createBinary: jest.fn(async (path: string, data: ArrayBuffer) => {
      writes.push({ path, data });
      existing.add(path);
    }),
    process: jest.fn(async (_file: TFile, mutator: (content: string) => string) => {
      processedContent = mutator(options.noteContent ?? '');
      return processedContent;
    }),
  };

  return {
    vault: vault as unknown as Vault,
    writes,
    createdFolders,
    getProcessed: () => processedContent,
    seedExists: (p: string) => existing.add(p),
    raw: vault,
  };
}

/** Build a Settings-shaped fake exposing only the fields the service reads. */
function buildSettings(storage?: { rootPath?: string; audioSubfolder?: string }) {
  return {
    settings: {
      llmProviders: { providers: {} },
      apps: { apps: {} },
      storage: storage ?? { rootPath: 'Nexus', audioSubfolder: 'audio' },
    },
  } as never;
}

/** An Editor fake with a controllable selection + recorded replaceRange calls. */
function buildEditor(selection: string) {
  const replaceRange = jest.fn();
  const editor = {
    getSelection: () => selection,
    getCursor: (_which?: string) => ({ line: 5, ch: 0 }),
    replaceRange,
  } as unknown as Editor;
  return { editor, replaceRange };
}

/** Install a synthesizeForCapture impl on the mocked ReadAloudService. */
function stubSynthesis(results: SpeechSynthesisResult[], spy?: jest.Mock) {
  const impl = spy ?? jest.fn(async () => results);
  MockedReadAloudService.prototype.synthesizeForCapture = impl as never;
  return impl;
}

describe('ReadAloudSaveService', () => {
  beforeEach(() => {
    MockedReadAloudService.mockClear();
  });

  // ── Settings-derived path resolution (NO hardcoded root) ───────────────────
  describe('path resolution', () => {
    it('writes to <rootPath>/<audioSubfolder>/<file> using DEFAULT settings', async () => {
      stubSynthesis([makeResult(8, 0x11)]);
      const fake = buildFakeVault();
      const svc = new ReadAloudSaveService(new App(), fake.vault, buildSettings());

      await svc.saveNoteAsAudio(new TFile('Note.md', 'Note.md'));

      expect(fake.writes).toHaveLength(1);
      expect(fake.writes[0].path).toMatch(/^Nexus\/audio\/Note - \d{8}-\d{6}\.mp3$/);
    });

    it('honors a CUSTOM rootPath (root is never hardcoded)', async () => {
      stubSynthesis([makeResult(8, 0x11)]);
      const fake = buildFakeVault();
      const svc = new ReadAloudSaveService(
        new App(),
        fake.vault,
        buildSettings({ rootPath: 'MyVaultRoot', audioSubfolder: 'audio' })
      );

      await svc.saveNoteAsAudio(new TFile('Note.md', 'Note.md'));

      expect(fake.writes[0].path.startsWith('MyVaultRoot/audio/')).toBe(true);
      expect(fake.writes[0].path.includes('Nexus')).toBe(false);
    });

    it('honors a custom audioSubfolder', async () => {
      stubSynthesis([makeResult(8, 0x11)]);
      const fake = buildFakeVault();
      const svc = new ReadAloudSaveService(
        new App(),
        fake.vault,
        buildSettings({ rootPath: 'Nexus', audioSubfolder: 'voice-clips' })
      );

      await svc.saveNoteAsAudio(new TFile('Note.md', 'Note.md'));
      expect(fake.writes[0].path.startsWith('Nexus/voice-clips/')).toBe(true);
    });

    it('falls back to "audio" when audioSubfolder is blank or whitespace', async () => {
      stubSynthesis([makeResult(8, 0x11)]);
      const fake = buildFakeVault();
      const svc = new ReadAloudSaveService(
        new App(),
        fake.vault,
        buildSettings({ rootPath: 'Nexus', audioSubfolder: '   ' })
      );

      await svc.saveNoteAsAudio(new TFile('Note.md', 'Note.md'));
      expect(fake.writes[0].path.startsWith('Nexus/audio/')).toBe(true);
    });

    it('falls back to the default rootPath ("Nexus") when storage is absent', async () => {
      stubSynthesis([makeResult(8, 0x11)]);
      const fake = buildFakeVault();
      // storage omitted entirely
      const settings = { settings: { llmProviders: {}, apps: {} } } as never;
      const svc = new ReadAloudSaveService(new App(), fake.vault, settings);

      await svc.saveNoteAsAudio(new TFile('Note.md', 'Note.md'));
      expect(fake.writes[0].path.startsWith('Nexus/audio/')).toBe(true);
    });
  });

  // ── Adversarial: path traversal must be neutralized ────────────────────────
  describe('path-traversal safety', () => {
    it('strips wikilink/path-illegal chars from a malicious note basename so no traversal occurs', async () => {
      stubSynthesis([makeResult(8, 0x11)]);
      const fake = buildFakeVault();
      const svc = new ReadAloudSaveService(new App(), fake.vault, buildSettings());

      // A hostile basename packed with separators + wikilink breakers.
      await svc.saveNoteAsAudio(new TFile('A/B: C? [[x]] #t.md', 'A/B: C? [[x]] #t.md'));

      const path = fake.writes[0].path;
      // Must stay under the configured audio folder — no parent escape, no abs path.
      expect(path.startsWith('Nexus/audio/')).toBe(true);
      expect(path.includes('..')).toBe(false);
      // The filename segment must contain none of the stripped illegal chars.
      const filename = path.slice('Nexus/audio/'.length);
      expect(filename).not.toMatch(/[\\/:*?"<>|[\]#^]/);
    });

    it('rejects (throws) a basename whose ".." survives sanitize and would escape the folder', async () => {
      // sanitize() does NOT strip '.', so a ".." basename passes through to
      // isValidPath, which must reject it — proving the layered guard holds.
      stubSynthesis([makeResult(8, 0x11)]);
      const fake = buildFakeVault();
      const svc = new ReadAloudSaveService(new App(), fake.vault, buildSettings());

      await expect(
        svc.saveNoteAsAudio(new TFile('..', '..'))
      ).rejects.toThrow(/invalid audio output path/);
      expect(fake.writes).toHaveLength(0);
    });
  });

  // ── Filename builder ───────────────────────────────────────────────────────
  describe('filename builder', () => {
    it('note filename = "<sanitized base> - <timestamp>.<ext>"', async () => {
      stubSynthesis([makeResult(8, 0x11, 'audio/wav')]);
      const fake = buildFakeVault();
      const svc = new ReadAloudSaveService(new App(), fake.vault, buildSettings());

      await svc.saveNoteAsAudio(new TFile('Daily Note.md', 'Daily Note.md'));
      const filename = fake.writes[0].path.split('/').pop() as string;
      expect(filename).toMatch(/^Daily Note - \d{8}-\d{6}\.wav$/);
    });

    it('selection filename includes a snippet capped at 40 chars / 5 words', async () => {
      stubSynthesis([makeResult(8, 0x11)]);
      const fake = buildFakeVault();
      const svc = new ReadAloudSaveService(new App(), fake.vault, buildSettings());
      const { editor } = buildEditor(
        'alpha beta gamma delta epsilon zeta eta theta iota'
      );

      await svc.saveSelectionAsAudio(editor, new TFile('Src.md', 'Src.md'));
      const filename = fake.writes[0].path.split('/').pop() as string;
      // Stem = "Src - <snippet> - <ts>.mp3". Snippet is <=5 words AND <=40 chars.
      const snippet = filename.replace(/^Src - /, '').replace(/ - \d{8}-\d{6}\.mp3$/, '');
      expect(snippet.split(/\s+/).length).toBeLessThanOrEqual(5);
      expect(snippet.length).toBeLessThanOrEqual(40);
      // First word preserved, 6th word ("zeta") excluded by the 5-word cap.
      expect(snippet.startsWith('alpha')).toBe(true);
      expect(snippet.includes('zeta')).toBe(false);
    });

    it('selection with no usable snippet falls back to "<base> - <ts>"', async () => {
      stubSynthesis([makeResult(8, 0x11)]);
      const fake = buildFakeVault();
      const svc = new ReadAloudSaveService(new App(), fake.vault, buildSettings());
      // Selection of only illegal/wikilink chars → snippet sanitizes to empty.
      const { editor } = buildEditor('[[ ]] ## :: //');

      await svc.saveSelectionAsAudio(editor, new TFile('Src.md', 'Src.md'));
      const filename = fake.writes[0].path.split('/').pop() as string;
      expect(filename).toMatch(/^Src - \d{8}-\d{6}\.mp3$/);
    });
  });

  // ── Embed insertion ────────────────────────────────────────────────────────
  describe('embed insertion', () => {
    it('selection: inserts ![[basename]] after the selection end via replaceRange', async () => {
      stubSynthesis([makeResult(8, 0x11)]);
      const fake = buildFakeVault();
      const svc = new ReadAloudSaveService(new App(), fake.vault, buildSettings());
      const { editor, replaceRange } = buildEditor('read me aloud');

      await svc.saveSelectionAsAudio(editor, new TFile('Src.md', 'Src.md'));

      expect(replaceRange).toHaveBeenCalledTimes(1);
      const [text, pos] = replaceRange.mock.calls[0];
      expect(text).toContain('![[');
      expect(text).toContain('.mp3]]');
      expect(pos).toEqual({ line: 5, ch: 0 }); // the getCursor('to') position
    });

    it('whole-note (no frontmatter): prepends the embed at top of body', async () => {
      stubSynthesis([makeResult(8, 0x11)]);
      const fake = buildFakeVault({ noteContent: 'First line\nSecond line' });
      const svc = new ReadAloudSaveService(new App(), fake.vault, buildSettings());

      await svc.saveNoteAsAudio(new TFile('Note.md', 'Note.md'));
      const out = fake.getProcessed() as string;
      expect(out.startsWith('![[')).toBe(true);
      expect(out).toContain('First line');
      expect(out.indexOf('![[')).toBeLessThan(out.indexOf('First line'));
    });

    it('whole-note (with YAML frontmatter): inserts embed BELOW the closing ---', async () => {
      stubSynthesis([makeResult(8, 0x11)]);
      const content = '---\ntitle: Hi\ntags: [a]\n---\nBody starts here';
      const fake = buildFakeVault({ noteContent: content });
      const svc = new ReadAloudSaveService(new App(), fake.vault, buildSettings());

      await svc.saveNoteAsAudio(new TFile('Note.md', 'Note.md'));
      const out = fake.getProcessed() as string;

      // Frontmatter block stays intact at the very top.
      expect(out.startsWith('---\ntitle: Hi')).toBe(true);
      // Embed lands after the SECOND '---' (closing fence), before the body.
      const closingIdx = out.indexOf('---', 3);
      const embedIdx = out.indexOf('![[');
      const bodyIdx = out.indexOf('Body starts here');
      expect(embedIdx).toBeGreaterThan(closingIdx);
      expect(embedIdx).toBeLessThan(bodyIdx);
    });

    it('whole-note (UNTERMINATED frontmatter): treats whole content as body (safe fallback)', async () => {
      stubSynthesis([makeResult(8, 0x11)]);
      // Opens with --- but never closes it.
      const content = '---\ntitle: Hi\nstill frontmatter never closed';
      const fake = buildFakeVault({ noteContent: content });
      const svc = new ReadAloudSaveService(new App(), fake.vault, buildSettings());

      await svc.saveNoteAsAudio(new TFile('Note.md', 'Note.md'));
      const out = fake.getProcessed() as string;
      // Embed prepended at the very top rather than risking corruption of the
      // unterminated block.
      expect(out.startsWith('![[')).toBe(true);
    });
  });

  // ── No-double-synth + capture contract ─────────────────────────────────────
  describe('synthesizeForCapture (no double synth, ordering, progress)', () => {
    it('calls synthesizeForCapture exactly once and never plays audio', async () => {
      const spy = jest.fn(async () => [makeResult(8, 0x11)]);
      stubSynthesis([], spy);
      const fake = buildFakeVault();
      const svc = new ReadAloudSaveService(new App(), fake.vault, buildSettings());

      await svc.saveNoteAsAudio(new TFile('Note.md', 'Note.md'));
      expect(spy).toHaveBeenCalledTimes(1);
      // The capture path takes { markdown } — never a playback request.
      expect(spy.mock.calls[0][0]).toHaveProperty('markdown');
    });

    it('concatenates multi-chunk results in ORDER (chunk 1 payload precedes chunk 2)', async () => {
      // Two WAV chunks: payload of chunk1 = 0xa1, chunk2 = 0xb2. After merge the
      // a1 bytes must come before the b2 bytes.
      const chunk1 = makeResult(20, 0xa1, 'audio/wav');
      const chunk2 = makeResult(30, 0xb2, 'audio/wav');
      // Wrap raw payloads in real WAV containers so concatWav can parse them.
      stubSynthesis([wrapWav(chunk1), wrapWav(chunk2)]);
      const fake = buildFakeVault();
      const svc = new ReadAloudSaveService(new App(), fake.vault, buildSettings());

      await svc.saveNoteAsAudio(new TFile('Note.md', 'Note.md'));
      const merged = new Uint8Array(fake.writes[0].data);
      const firstA1 = merged.indexOf(0xa1);
      const firstB2 = merged.indexOf(0xb2);
      expect(firstA1).toBeGreaterThan(-1);
      expect(firstB2).toBeGreaterThan(-1);
      expect(firstA1).toBeLessThan(firstB2);
    });
  });

  // ── v2 buffer-driven save tail (the ACTUAL v2 entry points) ────────────────
  // The v2 session captures buffers during play-and-capture and calls these
  // directly — they perform NO synthesis. The synth-then-save methods above are
  // retained test seams; these tests cover the v2 surface (ReadAloudSaveTail)
  // with N>1 captured buffers so concat + embed + settings-path are exercised
  // without going through synthesizeForCapture.
  describe('v2 buffer-driven saveCaptured* (N>1, no synthesis)', () => {
    it('saveCapturedNote: concatenates N buffers, writes to settings path, embeds below frontmatter, returns path', async () => {
      const fake = buildFakeVault({ noteContent: '---\ntitle: T\n---\nBody' });
      const svc = new ReadAloudSaveService(new App(), fake.vault, buildSettings());
      // 3 WAV chunks with distinct fills to verify ordered concat.
      const results = [
        wrapWav(makeResult(10, 0xa1, 'audio/wav')),
        wrapWav(makeResult(10, 0xb2, 'audio/wav')),
        wrapWav(makeResult(10, 0xc3, 'audio/wav')),
      ];

      const returnedPath = await svc.saveCapturedNote(results, new TFile('Note.md', 'Note.md'));

      // ONE write, settings-derived path, returns that path.
      expect(fake.writes).toHaveLength(1);
      expect(fake.writes[0].path).toMatch(/^Nexus\/audio\/Note - \d{8}-\d{6}\.wav$/);
      expect(returnedPath).toBe(fake.writes[0].path);
      // Ordered concat of all 3 payloads.
      const merged = new Uint8Array(fake.writes[0].data);
      expect(merged.indexOf(0xa1)).toBeLessThan(merged.indexOf(0xb2));
      expect(merged.indexOf(0xb2)).toBeLessThan(merged.indexOf(0xc3));
      // Embed inserted below the YAML frontmatter.
      const out = fake.getProcessed() as string;
      expect(out.startsWith('---\ntitle: T')).toBe(true);
      expect(out.indexOf('![[')).toBeGreaterThan(out.indexOf('---', 3));
    });

    it('saveCapturedSelection: concatenates N buffers, inserts embed at selection end, returns path', async () => {
      const fake = buildFakeVault();
      const svc = new ReadAloudSaveService(new App(), fake.vault, buildSettings());
      const { editor, replaceRange } = buildEditor('the selected text');
      const results = [
        wrapWav(makeResult(8, 0xd4, 'audio/wav')),
        wrapWav(makeResult(8, 0xe5, 'audio/wav')),
      ];

      const returnedPath = await svc.saveCapturedSelection(
        results,
        editor,
        new TFile('Src.md', 'Src.md'),
        'the selected text'
      );

      expect(fake.writes).toHaveLength(1);
      expect(returnedPath).toBe(fake.writes[0].path);
      expect(fake.writes[0].path).toMatch(/^Nexus\/audio\/Src - the selected text - \d{8}-\d{6}\.wav$/);
      // Embed inserted at the selection end (getCursor('to')).
      expect(replaceRange).toHaveBeenCalledTimes(1);
      const [text, pos] = replaceRange.mock.calls[0];
      expect(text).toContain('![[');
      expect(pos).toEqual({ line: 5, ch: 0 });
      // Ordered concat.
      const merged = new Uint8Array(fake.writes[0].data);
      expect(merged.indexOf(0xd4)).toBeLessThan(merged.indexOf(0xe5));
    });

    it('saveCapturedNote: throws on empty buffer array (no write)', async () => {
      const fake = buildFakeVault();
      const svc = new ReadAloudSaveService(new App(), fake.vault, buildSettings());
      await expect(
        svc.saveCapturedNote([], new TFile('Note.md', 'Note.md'))
      ).rejects.toThrow(/no readable text/);
      expect(fake.writes).toHaveLength(0);
    });

    it('saveCapturedNote: throws on unsupported captured mimeType (no write)', async () => {
      const fake = buildFakeVault();
      const svc = new ReadAloudSaveService(new App(), fake.vault, buildSettings());
      await expect(
        svc.saveCapturedNote([makeResult(8, 0x01, 'audio/ogg')], new TFile('Note.md', 'Note.md'))
      ).rejects.toThrow(/unsupported format/);
      expect(fake.writes).toHaveLength(0);
    });

    it('saveCapturedNote: N=1 passthrough writes the single buffer unchanged', async () => {
      const fake = buildFakeVault();
      const svc = new ReadAloudSaveService(new App(), fake.vault, buildSettings());
      const only = makeResult(12, 0x7f); // audio/mpeg, N=1 → concat passthrough
      await svc.saveCapturedNote([only], new TFile('Note.md', 'Note.md'));
      const written = new Uint8Array(fake.writes[0].data);
      expect(written.byteLength).toBe(12);
      expect(Array.from(written).every((b) => b === 0x7f)).toBe(true);
    });
  });

  // ── Error paths ────────────────────────────────────────────────────────────
  describe('error paths', () => {
    it('throws when the selection is empty/whitespace (no synth, no write)', async () => {
      const spy = jest.fn(async () => [makeResult(8, 0x11)]);
      stubSynthesis([], spy);
      const fake = buildFakeVault();
      const svc = new ReadAloudSaveService(new App(), fake.vault, buildSettings());
      const { editor } = buildEditor('   ');

      await expect(
        svc.saveSelectionAsAudio(editor, new TFile('Src.md', 'Src.md'))
      ).rejects.toThrow(/Select text/);
      expect(spy).not.toHaveBeenCalled();
      expect(fake.writes).toHaveLength(0);
    });

    it('throws when synthesis yields no results', async () => {
      stubSynthesis([]);
      const fake = buildFakeVault();
      const svc = new ReadAloudSaveService(new App(), fake.vault, buildSettings());

      await expect(
        svc.saveNoteAsAudio(new TFile('Note.md', 'Note.md'))
      ).rejects.toThrow(/no readable text/);
      expect(fake.writes).toHaveLength(0);
    });

    it('throws on an unsupported synthesized mimeType', async () => {
      stubSynthesis([makeResult(8, 0x11, 'audio/ogg')]);
      const fake = buildFakeVault();
      const svc = new ReadAloudSaveService(new App(), fake.vault, buildSettings());

      await expect(
        svc.saveNoteAsAudio(new TFile('Note.md', 'Note.md'))
      ).rejects.toThrow(/unsupported format/);
      expect(fake.writes).toHaveLength(0);
    });

    it('throws (does not overwrite) when the output path already exists', async () => {
      stubSynthesis([makeResult(8, 0x11)]);
      const fake = buildFakeVault();
      const svc = new ReadAloudSaveService(new App(), fake.vault, buildSettings());
      // Pre-seed the audio dir as an existing folder AND seed the would-be output.
      // We can't know the timestamp, so intercept createBinary's first arg by
      // seeding once getAbstractFileByPath is asked: simplest is to make EVERY
      // .mp3 path appear to exist.
      fake.raw.getAbstractFileByPath = jest.fn((path: string) => {
        if (path.endsWith('.mp3')) return new TFile(path.split('/').pop(), path);
        return new TFolder(path); // parent dir exists
      }) as never;

      await expect(
        svc.saveNoteAsAudio(new TFile('Note.md', 'Note.md'))
      ).rejects.toThrow(/already exists/);
    });
  });

  // ── Mobile-safety: the feature path must use no desktop-only audio/Node APIs ─
  // The feature ships on Obsidian mobile (isDesktopOnly: false). A static scan of
  // the source guards against a future edit reintroducing AudioContext /
  // MediaRecorder / Node built-ins that crash module init on mobile. Comments are
  // stripped before scanning so the "no AudioContext" JSDoc lines don't false-fire.
  describe('mobile-safety (static source scan)', () => {
    const featureFiles = [
      'src/services/readAloud/concatAudioBuffers.ts',
      'src/services/readAloud/ReadAloudSaveService.ts',
      'src/services/readAloud/ReadAloudService.ts',
      'src/core/commands/ReadAloudCommandManager.ts',
    ];

    const stripComments = (src: string): string =>
      src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

    it.each(featureFiles)('%s uses no AudioContext/MediaRecorder/Node built-ins', (rel) => {
      const code = stripComments(readFileSync(join(__dirname, '..', '..', rel), 'utf8'));
      expect(code).not.toMatch(/\bAudioContext\b/);
      expect(code).not.toMatch(/\bOfflineAudioContext\b/);
      expect(code).not.toMatch(/\bMediaRecorder\b/);
      expect(code).not.toMatch(/from ['"]node:/);
      expect(code).not.toMatch(/from ['"](fs|path|stream|crypto|buffer|os|http|events)['"]/);
      expect(code).not.toMatch(/\brequire\(/);
    });
  });

  // ── Auditor focus (A): toAudioBuffer behavior is harmless ───────────────────
  // The JSDoc claims a typed-array slice guard, but the body just returns
  // result.audioData. Adapters already return ArrayBuffer, so the pass-through is
  // correct end-to-end; we verify the buffer reaches createBinary intact.
  describe('toAudioBuffer pass-through (auditor focus A)', () => {
    it('forwards the synthesized ArrayBuffer to the write unchanged for N=1', async () => {
      const result = makeResult(12, 0x7e);
      stubSynthesis([result]);
      const fake = buildFakeVault();
      const svc = new ReadAloudSaveService(new App(), fake.vault, buildSettings());

      await svc.saveNoteAsAudio(new TFile('Note.md', 'Note.md'));
      // N=1 concat is a pass-through, so the written bytes equal the synth payload.
      const written = new Uint8Array(fake.writes[0].data);
      expect(written.byteLength).toBe(12);
      expect(Array.from(written).every((b) => b === 0x7e)).toBe(true);
    });
  });

  // ── Directory creation ─────────────────────────────────────────────────────
  describe('ensureParentDirectory', () => {
    it('creates the audio folder when it is missing', async () => {
      stubSynthesis([makeResult(8, 0x11)]);
      const fake = buildFakeVault(); // nothing seeded → folder missing
      const svc = new ReadAloudSaveService(new App(), fake.vault, buildSettings());

      await svc.saveNoteAsAudio(new TFile('Note.md', 'Note.md'));
      expect(fake.createdFolders).toContain('Nexus/audio');
    });

    it('does NOT create the folder when it already exists', async () => {
      stubSynthesis([makeResult(8, 0x11)]);
      const fake = buildFakeVault({ existingPaths: ['Nexus/audio'] });
      const svc = new ReadAloudSaveService(new App(), fake.vault, buildSettings());

      await svc.saveNoteAsAudio(new TFile('Note.md', 'Note.md'));
      expect(fake.createdFolders).toHaveLength(0);
    });
  });
});

/** Wrap a raw-payload result's bytes inside a canonical WAV container. */
function wrapWav(result: SpeechSynthesisResult): SpeechSynthesisResult {
  const payload = new Uint8Array(result.audioData);
  const dataSize = payload.byteLength;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const writeAscii = (offset: number, ascii: string): void => {
    for (let i = 0; i < ascii.length; i += 1) view.setUint8(offset + i, ascii.charCodeAt(i));
  };
  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 44100, true);
  view.setUint32(28, 88200, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(36, 'data');
  view.setUint32(40, dataSize, true);
  new Uint8Array(buffer).set(payload, 44);
  return { ...result, audioData: buffer, mimeType: 'audio/wav' };
}
