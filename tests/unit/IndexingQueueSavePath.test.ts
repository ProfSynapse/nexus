/**
 * IndexingQueue save path.
 *
 * Written as Phase 0 characterization for
 * docs/plans/sqlite-cache-persistence-plan.md, pinning what the code did so
 * Phase 2 had to turn a red test green rather than change behaviour in
 * silence. Phase 2 has landed and the two assertions it inverted say so.
 *
 * The real-world defect: on a large vault a full embedding index dies partway
 * through and the console says `[IndexingQueue] Failed to embed <path>`. No
 * embedding failed. `embedNote()` had already returned and the vector was
 * already in the in-memory database; what threw was the `db.save()` on every
 * tenth note, which sits inside the same per-note `try`. The note named is
 * whichever one happened to be tenth. TraceIndexer worked this out and says so
 * in a comment; this call site never got the same treatment.
 *
 * Two assertions here used to pin that wrong behaviour. Phase 2 inverted both,
 * and each says on itself what it used to pin.
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

/**
 * The floor the queue saves on when it has no idea how big the database is
 * (IndexingQueue MIN_SAVE_ITEMS). With a size in hand the interval scales up
 * from here; see CacheSavePolicy and the cadence tests at the bottom.
 */
const SAVE_INTERVAL = 10;

/** The size that motivated the plan, and the one the spike timed at ~378 ms a save. */
const LARGE_CACHE_BYTES = 152 * 1024 * 1024;

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
  initializeEmbeddings: jest.Mock<Promise<void>, []>;
  files: TFile[];
  phases(): string[];
  progress(): IndexingProgress[];
}

/**
 * @param cacheSizeBytes what the cache manager reports as the size of the last
 * snapshot. `null` is a cache that has never been written, which is what every
 * test here used before the cadence became size aware, and which still means
 * "save on the flat floor".
 */
function createHarness(fileCount: number, cacheSizeBytes: number | null = null): SavePathHarness {
  const files = makeFiles(fileCount);

  const save = jest.fn<Promise<void>, []>().mockResolvedValue(undefined);
  const db = {
    // No embedding metadata for anything, so every note needs indexing.
    queryOne: jest.fn().mockResolvedValue(null),
    query: jest.fn().mockResolvedValue([]),
    run: jest.fn().mockResolvedValue(undefined),
    getLastSavedBytes: jest.fn(() => cacheSizeBytes),
    save
  } as unknown as SQLiteCacheManager;

  // Always succeeds. This is the point: in the reported failure the embedding
  // had already completed and the vector was already in memory.
  const embedNote = jest.fn<Promise<void>, [string]>().mockResolvedValue(undefined);
  const initializeEmbeddings = jest.fn<Promise<void>, []>().mockResolvedValue(undefined);
  const embeddingService = {
    isServiceEnabled: jest.fn().mockReturnValue(true),
    initialize: initializeEmbeddings,
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
    initializeEmbeddings,
    files,
    phases: () => progress.map(p => p.phase),
    progress: () => progress
  };
}

describe('IndexingQueue save path', () => {
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

  // PHASE 2 INVERTED THIS. It used to assert exactly one "Failed to embed
  // <tenth note>" line and that nothing anywhere said the word "save": the
  // periodic save sat inside the per-note try, so a persistence failure was
  // reported as an embedding failure against whichever note happened to be
  // tenth although its vector was already in the database. The save has moved
  // out of that try and carries its own message and the byte count, which is
  // the number that explains the failure.
  it('reports a failed periodic save as a save failure, naming the byte count and no note', async () => {
    const harness = createHarness(SAVE_INTERVAL, LARGE_CACHE_BYTES);
    // Exactly what the field reports: the allocator refusing one contiguous
    // request while the whole database is exported.
    harness.save.mockRejectedValue(new RangeError('Array buffer allocation failed'));

    await harness.queue.startFullIndex();

    const tenthNotePath = harness.files[SAVE_INTERVAL - 1].path;
    expect(harness.embedNote).toHaveBeenCalledWith(tenthNotePath);
    expect(harness.embedNote).toHaveBeenCalledTimes(SAVE_INTERVAL);

    // No note is blamed for a failure that was not its fault.
    expect(loggedMessages().some(m => m.includes('Failed to embed'))).toBe(false);

    const saveFailures = loggedMessages().filter(m => m.includes('Failed to save the cache'));
    expect(saveFailures.length).toBeGreaterThan(0);
    expect(saveFailures[0]).toContain(String(LARGE_CACHE_BYTES));
    expect(saveFailures[0]).not.toContain(tenthNotePath);
  });

  // The byte count has to come from the cache manager, not from a constant, or
  // the message is decoration. With nothing written yet there is no number to
  // give and the message says so rather than inventing a zero.
  it('says the size is unknown when the cache has never been written', async () => {
    const harness = createHarness(3);
    harness.save.mockRejectedValue(new RangeError('Array buffer allocation failed'));

    await harness.queue.startFullIndex();

    const saveFailures = loggedMessages().filter(m => m.includes('Failed to save the cache'));
    expect(saveFailures.length).toBeGreaterThan(0);
    expect(saveFailures[0]).toContain('size unknown');
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

  // PHASE 2 INVERTED THIS. It used to assert phase `error` and no phase
  // `complete`: the final save sat inside the outer try, so its throw reached
  // the outer handler, which logged "Processing failed" and emitted `error`,
  // and nothing downstream ever recorded that the run had finished. A run that
  // embedded every note and could not write the snapshot is a partial success
  // with a loud warning, not an aborted run.
  it('reaches phase complete when the final save fails, and says loudly that it failed', async () => {
    const harness = createHarness(3, LARGE_CACHE_BYTES);
    harness.save.mockRejectedValue(new RangeError('Array buffer allocation failed'));

    await harness.queue.startFullIndex();

    // All three notes embedded. The vectors exist; only the snapshot failed.
    expect(harness.embedNote).toHaveBeenCalledTimes(3);
    // Three notes is below the save floor, so the only save is the final one.
    expect(harness.save).toHaveBeenCalledTimes(1);

    expect(harness.phases()).toContain('complete');
    expect(harness.phases()).not.toContain('error');

    // Loud: the failure is still reported, with what failed and how big it was.
    const saveFailures = loggedMessages().filter(m => m.includes('Failed to save the cache'));
    expect(saveFailures).toHaveLength(1);
    expect(saveFailures[0]).toContain('final save');
    expect(saveFailures[0]).toContain(String(LARGE_CACHE_BYTES));
    expect(loggedMessages().some(m => m.includes('Processing failed'))).toBe(false);
  });

  // A genuine failure in the run itself still aborts it. Without this, the
  // change above would read as "IndexingQueue no longer reports errors".
  it('still emits phase error when something other than the save fails', async () => {
    const harness = createHarness(3);
    harness.initializeEmbeddings.mockRejectedValue(new Error('model failed to load'));

    await harness.queue.startFullIndex();

    expect(harness.phases()).toContain('error');
    expect(harness.phases()).not.toContain('complete');
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

/**
 * Phase 2, Option B item 1: the cadence is a function of what a save costs.
 *
 * These drive the real IndexingQueue and count the saves it actually asks for.
 * The only thing the fake decides is how big it says the cache is, which is
 * the input the policy is supposed to be reading.
 */
describe('IndexingQueue save cadence', () => {
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('saves on the flat floor when nothing knows how big the cache is', async () => {
    const harness = createHarness(2 * SAVE_INTERVAL);

    await harness.queue.startFullIndex();

    // Two periodic saves plus the final one, which is what the flat
    // "every tenth note" rule did and still does at an unknown size.
    expect(harness.save).toHaveBeenCalledTimes(3);
  });

  // The change that matters on the vault this plan was written for. At 152 MB
  // a save is ~378 ms of wall clock, so twenty of them per two hundred notes
  // is most of a minute spent copying the database instead of embedding.
  it('stops saving every tenth note once the cache is large', async () => {
    const harness = createHarness(2 * SAVE_INTERVAL, LARGE_CACHE_BYTES);

    await harness.queue.startFullIndex();

    // Only the final save: at this size the policy asks for roughly ninety
    // notes between snapshots, and twenty is nowhere near it.
    expect(harness.save).toHaveBeenCalledTimes(1);
  });
});
