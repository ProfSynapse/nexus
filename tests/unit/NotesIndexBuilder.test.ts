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

/**
 * A fake with REAL emitter semantics: `on` returns a distinct ref, `offref`
 * only removes refs belonging to that emitter, and `emit` fires whatever is
 * still subscribed. `makeApp` above cannot show a teardown bug — its `offref`
 * is a no-op and its handler map keeps only the last registration, so a leaked
 * listener is invisible.
 */
function makeLiveApp(entries: Array<{ f: FakeFile; cache: { frontmatter?: unknown } }> = []) {
  const byPath = new Map(entries.map((e) => [e.f.path, e]));

  function emitter(tag: string) {
    const listeners: Array<{ name: string; cb: (...args: unknown[]) => void; ref: object }> = [];
    return {
      tag,
      listeners,
      on(name: string, cb: (...args: unknown[]) => void) {
        const ref = { tag, name };
        listeners.push({ name, cb, ref });
        return ref;
      },
      offref(ref: object) {
        const i = listeners.findIndex((l) => l.ref === ref);
        if (i >= 0) listeners.splice(i, 1);
      },
      emit(name: string, ...args: unknown[]) {
        for (const l of [...listeners]) if (l.name === name) l.cb(...args);
      },
      count(name: string) {
        return listeners.filter((l) => l.name === name).length;
      },
    };
  }

  const vault = emitter('vault');
  const metadataCache = emitter('metadataCache');
  const app = {
    vault: Object.assign(vault, {
      getMarkdownFiles: () => entries.map((e) => e.f),
      getAbstractFileByPath: (p: string) => byPath.get(p)?.f ?? null,
    }),
    metadataCache: Object.assign(metadataCache, {
      getFileCache: (f: FakeFile) => byPath.get(f.path)?.cache ?? {},
    }),
  };
  return { app, vault, metadataCache };
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

/**
 * Teardown. The builder writes through the plugin's SQLite connection, which
 * `close()` nulls at unload — so a builder that keeps listening after unload
 * keeps issuing statements against a dead handle and every one of them raises
 * "Database not initialized" out of an event handler nobody awaits. Reproduced
 * in Obsidian 1.13.7: 301 files dropped into the vault, plugin reloaded, 9-19
 * uncaught errors per reload and one extra leaked `changed` listener each time.
 */
describe('NotesIndexBuilder teardown', () => {
  it('removes every subscription on cleanup, so a later vault event writes nothing', async () => {
    const entries = [file('Projects/a.md', { status: 'active' })];
    const { app, vault, metadataCache } = makeLiveApp(entries);
    const service = mockService();
    const builder = new NotesIndexBuilder(app as never, service as unknown as NotesIndexService, { debounceMs: 0 });

    await builder.start();
    expect(metadataCache.count('changed')).toBe(1);
    expect(vault.count('delete')).toBe(1);
    service.upsertNote.mockClear();
    service.deleteNote.mockClear();

    // What the plugin's cleanup path actually calls (ServiceContainer.clear()
    // invokes `cleanup`, not `stop`).
    builder.cleanup();

    expect(metadataCache.count('changed')).toBe(0);
    expect(vault.count('delete')).toBe(0);
    expect(vault.count('rename')).toBe(0);

    metadataCache.emit('changed', makeFile('Projects/a.md'));
    vault.emit('delete', makeFile('Projects/a.md'));
    await tick();

    expect(service.upsertNote).not.toHaveBeenCalled();
    expect(service.deleteNote).not.toHaveBeenCalled();
  });

  it('hands every subscription to the plugin so unload detaches it even without cleanup', async () => {
    const { app } = makeLiveApp([]);
    const service = mockService();
    const plugin = { registerEvent: jest.fn() };
    const builder = new NotesIndexBuilder(app as never, service as unknown as NotesIndexService, { plugin });

    await builder.start();

    expect(plugin.registerEvent).toHaveBeenCalledTimes(3);
    builder.cleanup();
  });

  it('does not reject when the database closes under an already-scheduled flush', async () => {
    const entries = [file('Projects/a.md', { status: 'active' })];
    const { app, metadataCache } = makeLiveApp(entries);
    const service = mockService();
    const builder = new NotesIndexBuilder(app as never, service as unknown as NotesIndexService, { debounceMs: 0 });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      await builder.start();
      // The connection goes away after the builder is up and listening — the
      // shape of an unload landing between a scheduled flush and its writes.
      service.upsertNote.mockClear();
      service.upsertNote.mockRejectedValue(new Error('Database not initialized'));
      metadataCache.emit('changed', makeFile('Projects/a.md'));
      await tick();
      await tick();
    } finally {
      process.off('unhandledRejection', onUnhandled);
      builder.cleanup();
    }
    // Read the spy before restoring it — mockRestore() also clears its history.
    const warned = warn.mock.calls.length;
    warn.mockRestore();

    expect(service.upsertNote).toHaveBeenCalled();
    expect(unhandled).toEqual([]);
    expect(warned).toBeGreaterThan(0);
  });

  it('abandons the background walk once stopped instead of writing on', async () => {
    const entries = Array.from({ length: 6 }, (_, i) => file(`Projects/n${i}.md`));
    const { app } = makeLiveApp(entries);
    const service = mockService();
    const builder = new NotesIndexBuilder(app as never, service as unknown as NotesIndexService, { batchSize: 1 });

    // Stop as soon as the first note has been written; the walk yields between
    // batches, which is exactly where an unload lands.
    service.upsertNote.mockImplementation(async () => {
      builder.cleanup();
    });

    await builder.buildAll();

    expect(service.upsertNote).toHaveBeenCalledTimes(1);
    expect(service.pruneMissing).not.toHaveBeenCalled();
    expect(builder.isReady()).toBe(false);
  });
});
