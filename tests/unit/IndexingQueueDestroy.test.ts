/**
 * IndexingQueue teardown tests.
 *
 * Regression cover for the orphaned background-indexing loop: an IndexingQueue
 * belonging to an unloaded plugin instance kept iterating against the
 * SQLiteCacheManager that the same instance's unload had already closed, logging
 * "Database not initialized" once per item for minutes, with the burst growing
 * on every reload.
 *
 * The mock db here deliberately throws that exact error once close() has been
 * called. A mock that kept answering after close would make every test below
 * pass against the un-fixed code, which is precisely how the bug shipped.
 */

import { IndexingQueue } from '../../src/services/embeddings/IndexingQueue';
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

function createHarness(fileCount: number) {
  let closed = false;

  const queryOne = jest.fn(async () => {
    if (closed) {
      // Exactly what SQLiteCacheManager.getDbOrThrow() does after close().
      throw new Error('Database not initialized');
    }
    return null;
  });

  const db = {
    queryOne,
    query: jest.fn().mockResolvedValue([]),
    run: jest.fn().mockResolvedValue(undefined),
    save: jest.fn().mockResolvedValue(undefined),
    close: () => { closed = true; }
  } as unknown as SQLiteCacheManager & { close(): void };

  const embeddingService = {
    isServiceEnabled: jest.fn().mockReturnValue(true),
    initialize: jest.fn().mockResolvedValue(undefined),
    embedNote: jest.fn().mockResolvedValue(undefined)
  } as unknown as EmbeddingService;

  const files = makeFiles(fileCount);
  const app = {
    vault: {
      getMarkdownFiles: () => files,
      cachedRead: jest.fn().mockResolvedValue('content')
    }
  } as unknown as App;

  const queue = new IndexingQueue(app, embeddingService, db);

  return { queue, db, embeddingService, queryOne, files };
}

describe('IndexingQueue teardown', () => {
  it('stops scanning notes as soon as destroy() is called', async () => {
    // filterUnindexedNotes() runs one queryOne per markdown file, and it runs
    // with isRunning === false -- the window the old cancel() could not touch.
    const { queue, db, queryOne } = createHarness(50);

    const DESTROY_AFTER = 3;
    queryOne.mockImplementation(async () => {
      if (queryOne.mock.calls.length === DESTROY_AFTER) {
        queue.destroy();
        (db as unknown as { close(): void }).close();
      }
      return null;
    });

    await queue.startFullIndex();

    // Before the fix the loop ran all 50 files, every one of them throwing
    // "Database not initialized" into the console.
    expect(queryOne).toHaveBeenCalledTimes(DESTROY_AFTER);
  });

  it('refuses to start the trace phase after destroy()', async () => {
    // runBackgroundIndexing awaits three phases in sequence. Aborting phase 1
    // used to leave phases 2 and 3 free to start, each minting a fresh
    // AbortController against the now-closed handle.
    const { queue, db, embeddingService } = createHarness(1);

    queue.destroy();
    (db as unknown as { close(): void }).close();
    (embeddingService.isServiceEnabled as jest.Mock).mockClear();

    await queue.startTraceIndex();

    expect(embeddingService.isServiceEnabled).not.toHaveBeenCalled();
  });

  it('refuses to start the conversation phase after destroy()', async () => {
    const { queue, db, embeddingService } = createHarness(1);

    queue.destroy();
    (db as unknown as { close(): void }).close();
    (embeddingService.isServiceEnabled as jest.Mock).mockClear();

    await queue.startConversationIndex();

    expect(embeddingService.isServiceEnabled).not.toHaveBeenCalled();
  });

  it('refuses to restart the note phase after destroy()', async () => {
    const { queue, db, queryOne } = createHarness(5);

    queue.destroy();
    (db as unknown as { close(): void }).close();
    queryOne.mockClear();

    await queue.startFullIndex();

    expect(queryOne).not.toHaveBeenCalled();
  });

  it('is idempotent -- a second destroy() is harmless', async () => {
    const { queue, db, queryOne } = createHarness(5);

    queue.destroy();
    queue.destroy();
    (db as unknown as { close(): void }).close();
    queryOne.mockClear();

    await expect(queue.startFullIndex()).resolves.toBeUndefined();
    expect(queryOne).not.toHaveBeenCalled();
  });
});
