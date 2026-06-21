/**
 * NotesIndexBuilder unit tests — the vault walk, hash-gated skip, conservative
 * prune, graceful-degrade cap, and metadataCache/vault freshness. A hand-rolled
 * fake `app` + a mocked NotesIndexService (no Obsidian runtime, no real DB).
 */

import { TFile } from 'obsidian';
import { NotesIndexBuilder } from '../../src/database/services/notesIndex/NotesIndexBuilder';
import { computeContentHash } from '../../src/database/services/notesIndex/notesIndexMapping';
import type { NotesIndexService } from '../../src/database/services/notesIndex/NotesIndexService';

type FakeFile = TFile;

/** Build a real mock-TFile instance (needed so `instanceof TFile` holds in the builder). */
function makeFile(path: string, ext = 'md'): FakeFile {
  const name = path.split('/').pop() as string;
  const f = new TFile(name, path) as unknown as Record<string, unknown>;
  f.extension = ext;
  f.parent = { path: 'Projects' };
  f.stat = { ctime: 1, mtime: 2, size: 3 };
  return f as unknown as FakeFile;
}

function file(path: string, frontmatter: Record<string, unknown> = {}): { f: FakeFile; cache: { frontmatter?: unknown } } {
  return { f: makeFile(path), cache: { frontmatter } };
}

function makeApp(entries: Array<{ f: FakeFile; cache: { frontmatter?: unknown } }>) {
  const byPath = new Map(entries.map((e) => [e.f.path, e]));
  const handlers: Record<string, (...args: unknown[]) => void> = {};
  const app = {
    vault: {
      getMarkdownFiles: () => entries.map((e) => e.f),
      getAbstractFileByPath: (p: string) => byPath.get(p)?.f ?? null,
      on: (name: string, cb: (...args: unknown[]) => void) => {
        handlers[`vault:${name}`] = cb;
        return { name };
      },
      offref: () => undefined,
    },
    metadataCache: {
      getFileCache: (f: FakeFile) => byPath.get(f.path)?.cache ?? {},
      on: (name: string, cb: (...args: unknown[]) => void) => {
        handlers[`mc:${name}`] = cb;
        return { name };
      },
      offref: () => undefined,
    },
  };
  return { app, handlers };
}

function mockService(existing: Map<string, string> = new Map()) {
  return {
    ensureSchema: jest.fn().mockResolvedValue(undefined),
    getExistingHashes: jest.fn().mockResolvedValue(existing),
    upsertNote: jest.fn().mockResolvedValue(undefined),
    deleteNote: jest.fn().mockResolvedValue(undefined),
    pruneMissing: jest.fn().mockResolvedValue(undefined),
  };
}

const tick = () => new Promise((r) => setTimeout(r, 5));

describe('NotesIndexBuilder', () => {
  it('builds the index from every markdown file and prunes against the present set', async () => {
    const entries = [file('Projects/a.md', { status: 'active' }), file('Projects/b.md')];
    const { app } = makeApp(entries);
    const service = mockService();
    const builder = new NotesIndexBuilder(app as never, service as unknown as NotesIndexService);

    await builder.buildAll();

    expect(service.upsertNote).toHaveBeenCalledTimes(2);
    const present = service.pruneMissing.mock.calls[0][0] as Set<string>;
    expect(present).toEqual(new Set(['Projects/a.md', 'Projects/b.md']));
    expect(builder.isReady()).toBe(true);
  });

  it('skips notes whose content hash is unchanged', async () => {
    const entries = [file('Projects/a.md', { status: 'active' }), file('Projects/b.md')];
    const { app } = makeApp(entries);
    // a.md already indexed with a matching hash → should be skipped.
    const aHash = computeContentHash({ status: 'active' }, 2, 3);
    const service = mockService(new Map([['Projects/a.md', aHash]]));
    const builder = new NotesIndexBuilder(app as never, service as unknown as NotesIndexService);

    await builder.buildAll();

    const upserted = service.upsertNote.mock.calls.map((c) => (c[0] as { path: string }).path);
    expect(upserted).toEqual(['Projects/b.md']);
  });

  it('degrades (skips the build) above maxNotes', async () => {
    const entries = [file('a.md'), file('b.md'), file('c.md')];
    const { app } = makeApp(entries);
    const service = mockService();
    const builder = new NotesIndexBuilder(app as never, service as unknown as NotesIndexService, { maxNotes: 2 });

    await builder.buildAll();

    expect(builder.isDegraded()).toBe(true);
    expect(builder.isReady()).toBe(false);
    expect(service.upsertNote).not.toHaveBeenCalled();
    expect(service.pruneMissing).not.toHaveBeenCalled();
  });

  it('re-upserts a note on a debounced metadataCache change', async () => {
    const entries = [file('Projects/a.md', { status: 'active' })];
    const { app, handlers } = makeApp(entries);
    const service = mockService(new Map([['Projects/a.md', computeContentHash({ status: 'active' }, 2, 3)]]));
    const builder = new NotesIndexBuilder(app as never, service as unknown as NotesIndexService, { debounceMs: 0 });

    await builder.start();
    service.upsertNote.mockClear(); // ignore the initial build

    handlers['mc:changed']({ path: 'Projects/a.md' });
    await tick();

    expect(service.upsertNote).toHaveBeenCalledTimes(1);
    expect((service.upsertNote.mock.calls[0][0] as { path: string }).path).toBe('Projects/a.md');

    builder.stop();
  });

  it('deletes a note immediately on a vault delete event', async () => {
    const entries = [file('Projects/a.md')];
    const { app, handlers } = makeApp(entries);
    const service = mockService();
    const builder = new NotesIndexBuilder(app as never, service as unknown as NotesIndexService);

    await builder.start();

    handlers['vault:delete'](makeFile('Projects/a.md'));

    expect(service.deleteNote).toHaveBeenCalledWith('Projects/a.md');
    builder.stop();
  });

  it('ignores non-markdown files on delete', async () => {
    const { app, handlers } = makeApp([]);
    const service = mockService();
    const builder = new NotesIndexBuilder(app as never, service as unknown as NotesIndexService);

    await builder.start();
    handlers['vault:delete'](makeFile('Attachments/pic.png', 'png'));

    expect(service.deleteNote).not.toHaveBeenCalled();
    builder.stop();
  });
});
