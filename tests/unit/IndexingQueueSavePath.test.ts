/**
 * IndexingQueue save-path characterization.
 *
 * Phase 0 of docs/plans/sqlite-cache-persistence-plan.md. No production code
 * changes with these; they pin down what the code does today so Phase 2 has to
 * turn a red test green rather than change behaviour in silence.
 *
 * The real-world defect: on a large vault a full embedding index dies partway
 * through and the console says `[IndexingQueue] Failed to embed <path>`. No
 * embedding failed. `embedNote()` had already returned and the vector was
 * already in the in-memory database; what threw was the `db.save()` on every
 * tenth note, which sits inside the same per-note `try`. The note named is
 * whichever one happened to be tenth. TraceIndexer worked this out and says so
 * in a comment; this call site never got the same treatment.
 *
 * Both assertions below are therefore pinning WRONG behaviour, each with the
 * phase that flips it named on the test.
 *
 * What the fakes decide, and what they do not: the embedding service always
 * succeeds and the db.save() is made to reject, which is exactly the real
 * split. Everything asserted on (which message is logged, which note path it
 * names, whether phase `complete` is reached) is the real IndexingQueue
 * running its real processQueue(). Change the catch and these go red.
 */

import { IndexingQueue, IndexingProgress } from '../../src/services/embeddings/IndexingQueue';
import type { EmbeddingService } from '../../src/services/embeddings/EmbeddingService';
import type { SQLiteCacheManager } from '../../src/database/storage/SQLiteCacheManager';
import type { App, TFile } from 'obsidian';

/** The queue saves on every tenth processed note (IndexingQueue SAVE_INTERVAL). */
const SAVE_INTERVAL = 10;

function makeFiles(count: number): TFile[] {
  return Array.from({ length: count }, (_, i) => ({
    path: `notes/note-${i}.md`,
    basename: `note-${i}`,
    extension: 'md'
  })) as unknown as TFile[];
}

interface SavePathHarness {
  queue: IndexingQueue;
  save: jest.Mock<Promise<void>, []>;
  embedNote: jest.Mock<Promise<void>, [string]>;
  files: TFile[];
  phases(): string[];
  progress(): IndexingProgress[];
}

function createHarness(fileCount: number): SavePathHarness {
  const files = makeFiles(fileCount);

  const save = jest.fn<Promise<void>, []>().mockResolvedValue(undefined);
  const db = {
    // No embedding metadata for anything, so every note needs indexing.
    queryOne: jest.fn().mockResolvedValue(null),
    query: jest.fn().mockResolvedValue([]),
    run: jest.fn().mockResolvedValue(undefined),
    save
  } as unknown as SQLiteCacheManager;

  // Always succeeds. This is the point: in the reported failure the embedding
  // had already completed and the vector was already in memory.
  const embedNote = jest.fn<Promise<void>, [string]>().mockResolvedValue(undefined);
  const embeddingService = {
    isServiceEnabled: jest.fn().mockReturnValue(true),
    initialize: jest.fn().mockResolvedValue(undefined),
    embedNote
  } as unknown as EmbeddingService;

  const app = {
    vault: {
      getMarkdownFiles: () => files,
      cachedRead: jest.fn().mockResolvedValue('content')
    }
  } as unknown as App;

  const queue = new IndexingQueue(app, embeddingService, db);
  const progress: IndexingProgress[] = [];
  queue.on('progress', (event: IndexingProgress) => {
    progress.push({ ...event });
  });

  return {
    queue,
    save,
    embedNote,
    files,
    phases: () => progress.map(p => p.phase),
    progress: () => progress
  };
}

describe('IndexingQueue save path (Phase 0 characterization)', () => {
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  /** Every console.error message, composed argument only. */
  function loggedMessages(): string[] {
    return errorSpy.mock.calls.map(call => String(call[0]));
  }

  // PHASE 2 INVERTS THIS. Option B moves the periodic save out of the per-note
  // try, or wraps it in its own, so that a save failure says
  // "failed to save the cache" and names a byte count instead of blaming a note
  // that embedded perfectly well.
  it('reports a failed periodic save as a failure to embed the tenth note', async () => {
    const harness = createHarness(SAVE_INTERVAL);
    // Exactly what the field reports: the allocator refusing one contiguous
    // request while the whole database is exported.
    harness.save.mockRejectedValue(new RangeError('Array buffer allocation failed'));

    await harness.queue.startFullIndex();

    // The embedding of note 9 succeeded. It is named anyway, because the save
    // that follows it shares its try block.
    const tenthNotePath = harness.files[SAVE_INTERVAL - 1].path;
    expect(harness.embedNote).toHaveBeenCalledWith(tenthNotePath);
    expect(harness.embedNote).toHaveBeenCalledTimes(SAVE_INTERVAL);

    const embedFailures = loggedMessages().filter(m => m.includes('Failed to embed'));
    expect(embedFailures).toHaveLength(1);
    expect(embedFailures[0]).toContain(`Failed to embed ${tenthNotePath}`);

    // And nothing anywhere says the word "save", which is why the reported
    // stack was the only clue that this was persistence at all.
    expect(loggedMessages().some(m => /save/i.test(m))).toBe(false);
  });

  // The counterpart that must stay true through every phase: when the note
  // really did fail to embed, that is what gets said. Without this, a Phase 2
  // change could relabel genuine embed failures as save failures and no test
  // would notice.
  it('still reports a genuinely failed embedding against the note that failed', async () => {
    const harness = createHarness(3);
    harness.embedNote.mockImplementation(async (path: string) => {
      if (path === 'notes/note-1.md') {
        throw new Error('provider returned 429');
      }
    });

    await harness.queue.startFullIndex();

    const embedFailures = loggedMessages().filter(m => m.includes('Failed to embed'));
    expect(embedFailures).toHaveLength(1);
    expect(embedFailures[0]).toContain('Failed to embed notes/note-1.md');
  });

  // PHASE 2 INVERTS THIS. The final save sits outside the per-note try and
  // inside the outer one, so its throw reaches the outer handler, which logs
  // "Processing failed" and emits phase `error`. Phase `complete` is never
  // reached, so nothing downstream ever records that the run finished. A run
  // that embedded every note and could not write the snapshot is a partial
  // success with a loud warning, not an aborted run.
  it('aborts the whole run when the final save fails, never reaching phase complete', async () => {
    const harness = createHarness(3);
    harness.save.mockRejectedValue(new RangeError('Array buffer allocation failed'));

    await harness.queue.startFullIndex();

    // All three notes embedded. The vectors exist; only the snapshot failed.
    expect(harness.embedNote).toHaveBeenCalledTimes(3);
    // Three notes is below SAVE_INTERVAL, so the only save is the final one.
    expect(harness.save).toHaveBeenCalledTimes(1);

    expect(harness.phases()).toContain('error');
    expect(harness.phases()).not.toContain('complete');

    const errorEvent = harness.progress().find(p => p.phase === 'error');
    expect(errorEvent?.error).toContain('Array buffer allocation failed');
    expect(loggedMessages().some(m => m.includes('Processing failed'))).toBe(true);
  });

  // The same run with a save that works, so the failure above is attributable
  // to the save and not to anything else in the harness.
  it('reaches phase complete when the final save succeeds', async () => {
    const harness = createHarness(3);

    await harness.queue.startFullIndex();

    expect(harness.save).toHaveBeenCalledTimes(1);
    expect(harness.phases()).toContain('complete');
    expect(harness.phases()).not.toContain('error');
  });
});
