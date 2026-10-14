/**
 * IndexingQueue when the embedding model cannot load.
 *
 * EmbeddingService.initialize() swallows a load failure and turns the service
 * off; from then on embedNote() returns without doing anything. The note pass
 * used to carry on regardless, count every note as processed, and finish with
 * phase 'complete', 7 of 7, over an index with nothing in it. That is what the
 * settings fold and the status bar showed in the live failure.
 *
 * The fake service models exactly that contract: initialize() resolves and
 * flips isServiceEnabled() to false. The queue is real.
 */

import { IndexingQueue, IndexingProgress } from '../../src/services/embeddings/IndexingQueue';
import type { EmbeddingService } from '../../src/services/embeddings/EmbeddingService';
import type { SQLiteCacheManager } from '../../src/database/storage/SQLiteCacheManager';
import type { App, TFile } from 'obsidian';

describe('IndexingQueue: embedding model fails to load', () => {
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('ends the note pass with phase error instead of claiming every note was indexed', async () => {
    const files = Array.from({ length: 7 }, (_, i) => ({
      path: `note-${i}.md`, basename: `note-${i}`, extension: 'md'
    })) as unknown as TFile[];

    let enabled = true;
    const embedNote = jest.fn().mockResolvedValue(undefined);
    const embeddingService = {
      isServiceEnabled: jest.fn(() => enabled),
      // The real initialize(): logs, turns itself off, resolves.
      initialize: jest.fn(() => { enabled = false; return Promise.resolve(); }),
      embedNote
    } as unknown as EmbeddingService;

    const db = {
      queryOne: jest.fn().mockResolvedValue(null),
      query: jest.fn().mockResolvedValue([]),
      run: jest.fn().mockResolvedValue(undefined),
      getLastSavedBytes: jest.fn(() => null),
      save: jest.fn().mockResolvedValue(undefined)
    } as unknown as SQLiteCacheManager;

    const app = {
      vault: {
        getMarkdownFiles: () => files,
        cachedRead: jest.fn().mockResolvedValue('content')
      }
    } as unknown as App;

    const queue = new IndexingQueue(app, embeddingService, db);
    const progress: IndexingProgress[] = [];
    queue.on('progress', (event: IndexingProgress) => { progress.push({ ...event }); });

    await queue.startFullIndex();

    const last = progress[progress.length - 1];
    expect(last.phase).toBe('error');
    expect(last.processedNotes).toBe(0);
    expect(last.error).toMatch(/embedding model could not be loaded/i);
    expect(progress.map(p => p.phase)).not.toContain('complete');
    expect(embedNote).not.toHaveBeenCalled();
    expect(queue.isIndexing()).toBe(false);
  });
});
