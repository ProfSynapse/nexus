/**
 * Indexing progress must describe the work actually being done.
 *
 * Observed in a real vault on startup: the status bar read "Indexing: 0/6644"
 * for about six minutes, then the pass ended "complete 117/117". Two passes
 * were reporting under one label:
 *
 * - the trace backfill counted 6,644 traces as work although almost all of
 *   them were too short to embed ("Used tool"), and only reported progress at
 *   its start and end (covered in TraceIndexer.test.ts);
 * - the note pass compared every note's content hash before it knew what to
 *   embed, and reported nothing while it did.
 *
 * Here: the note hash check reports phase 'checking' with notes-compared
 * counts, 'indexing' counts only notes being embedded, every event names its
 * scope, and the status bar text follows both.
 */

import { IndexingQueue, type IndexingProgress } from '../../src/services/embeddings/IndexingQueue';
import { describeCompletion, describeProgress } from '../../src/services/embeddings/EmbeddingStatusBar';
import { hashContent, preprocessContent } from '../../src/services/embeddings/EmbeddingUtils';
import type { EmbeddingService } from '../../src/services/embeddings/EmbeddingService';
import type { SQLiteCacheManager } from '../../src/database/storage/SQLiteCacheManager';
import type { App, TFile } from 'obsidian';

function makeFiles(count: number): TFile[] {
  return Array.from({ length: count }, (_, i) => ({
    path: `note-${i}.md`,
    basename: `note-${i}`,
    extension: 'md'
  })) as unknown as TFile[];
}

/**
 * `changed` notes have no stored hash; the rest match what is stored, as
 * IndexingQueue computes it from the content "same content for every note".
 */
function createHarness(fileCount: number, changed: number) {
  const files = makeFiles(fileCount);
  const changedPaths = new Set(files.slice(0, changed).map(f => f.path));
  const storedHash = hashContent(preprocessContent('same content for every note') ?? '');

  const db = {
    queryOne: jest.fn(async (_sql: string, params?: unknown[]) => {
      const path = String(params?.[0] ?? '');
      return changedPaths.has(path) ? null : { contentHash: storedHash };
    }),
    query: jest.fn().mockResolvedValue([]),
    run: jest.fn().mockResolvedValue(undefined),
    save: jest.fn().mockResolvedValue(undefined)
  } as unknown as SQLiteCacheManager;

  const embeddingService = {
    isServiceEnabled: jest.fn().mockReturnValue(true),
    initialize: jest.fn().mockResolvedValue(undefined),
    embedNote: jest.fn().mockResolvedValue(undefined)
  } as unknown as EmbeddingService;

  const app = {
    vault: {
      getMarkdownFiles: () => files,
      cachedRead: jest.fn().mockResolvedValue('same content for every note')
    }
  } as unknown as App;

  const queue = new IndexingQueue(app, embeddingService, db);
  const events: IndexingProgress[] = [];
  queue.on('progress', (...data: unknown[]) => { events.push({ ...(data[0] as IndexingProgress) }); });

  return { queue, events, embeddingService, db };
}

describe('IndexingQueue honest progress', () => {
  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  async function runFullIndex(queue: IndexingQueue): Promise<void> {
    const run = queue.startFullIndex();
    // processQueue yields 50 ms between notes.
    for (let i = 0; i < 50; i++) {
      await Promise.resolve();
      await jest.advanceTimersByTimeAsync(60);
    }
    await run;
  }

  it('reports the hash check as checking, then indexes only the changed notes', async () => {
    const { queue, events, embeddingService } = createHarness(250, 3);

    await runFullIndex(queue);

    const checking = events.filter(e => e.phase === 'checking');
    expect(checking.length).toBeGreaterThan(1);
    expect(checking.every(e => e.totalNotes === 250 && e.scope === 'notes')).toBe(true);
    // Advances during the scan instead of sitting at 0.
    expect(checking.map(e => e.processedNotes)).toEqual([0, 100, 200]);

    const indexing = events.filter(e => e.phase === 'indexing');
    expect(indexing.length).toBeGreaterThan(0);
    // Embedding counts are the real work: 3 changed notes, never the vault size.
    expect(indexing.every(e => e.totalNotes === 3 && e.scope === 'notes')).toBe(true);

    const last = events[events.length - 1];
    expect(last).toMatchObject({ phase: 'complete', totalNotes: 3, processedNotes: 3, scope: 'notes' });
    expect(embeddingService.embedNote).toHaveBeenCalledTimes(3);

    // No event before the scan finished claimed notes were being indexed.
    const firstIndexing = events.findIndex(e => e.phase === 'indexing' || e.phase === 'loading_model');
    const lastChecking = events.map(e => e.phase).lastIndexOf('checking');
    expect(firstIndexing).toBeGreaterThan(lastChecking);
  });

  it('is visible as a running pass while checking, and stops on cancel', async () => {
    const { queue, events, db } = createHarness(500, 0);
    const queryOne = db.queryOne as jest.Mock;
    let seenRunning: boolean | null = null;
    let seenProgress: IndexingProgress | null = null;
    queryOne.mockImplementation(async () => {
      if (queryOne.mock.calls.length === 150) {
        seenRunning = queue.isIndexing();
        seenProgress = queue.getProgress();
        queue.cancel();
      }
      return null;
    });

    await runFullIndex(queue);

    expect(seenRunning).toBe(true);
    expect(seenProgress).toMatchObject({ phase: 'checking', totalNotes: 500, processedNotes: 150, scope: 'notes' });
    // The cancelled scan neither embedded anything nor ran to the end.
    expect(queryOne).toHaveBeenCalledTimes(150);
    expect(events.some(e => e.phase === 'loading_model' || e.phase === 'indexing')).toBe(false);
    expect(events[events.length - 1].phase).toBe('idle');
    expect(queue.isIndexing()).toBe(false);
  });

  it('reports nothing to do as complete with zero, not as the vault size', async () => {
    const { queue, events, embeddingService } = createHarness(120, 0);

    await runFullIndex(queue);

    expect(events[events.length - 1]).toMatchObject({ phase: 'complete', totalNotes: 0, processedNotes: 0 });
    expect(events.some(e => e.phase === 'indexing')).toBe(false);
    expect(embeddingService.embedNote).not.toHaveBeenCalled();
  });
});

describe('EmbeddingStatusBar text', () => {
  const base: IndexingProgress = {
    phase: 'indexing', totalNotes: 6644, processedNotes: 0, currentNote: null, estimatedTimeRemaining: null
  };

  it('names what each pass is working through', () => {
    expect(describeProgress({ ...base, phase: 'checking', scope: 'notes', processedNotes: 1200, totalNotes: 7640 }))
      .toBe('Checking notes: 1200/7640');
    expect(describeProgress({ ...base, scope: 'notes', processedNotes: 3, totalNotes: 117 })).toBe('Indexing notes: 3/117');
    expect(describeProgress({ ...base, scope: 'conversations', processedNotes: 5, totalNotes: 52 })).toBe('Indexing chats: 5/52');
    expect(describeProgress({ ...base, scope: 'traces', processedNotes: 2, totalNotes: 21 })).toBe('Indexing memory: 2/21');
    expect(describeProgress({ ...base, processedNotes: 1, totalNotes: 2 })).toBe('Indexing: 1/2');
  });

  it('does not call traces or chats notes when a pass completes', () => {
    expect(describeCompletion({ ...base, phase: 'complete', scope: 'notes', processedNotes: 117 }))
      .toBe('Embedding complete! 117 notes indexed.');
    expect(describeCompletion({ ...base, phase: 'complete', scope: 'conversations', processedNotes: 1 }))
      .toBe('Embedding complete! 1 chat indexed.');
    expect(describeCompletion({ ...base, phase: 'complete', scope: 'traces', processedNotes: 21 }))
      .toBe('Embedding complete! 21 memory traces indexed.');
  });
});
