/**
 * Tests for how NoteEmbeddingService.embedNote reports failures.
 *
 * Re-embedding is debounced by ten seconds, so a note can move or be deleted
 * between being scheduled and being read. The existence guard at the top of
 * embedNote checks the vault INDEX while the read hits DISK, and those
 * disagree for a moment during a move — so the guard passes and the read
 * throws ENOENT anyway.
 *
 * That is a normal outcome, not a failure: the vault's rename and delete
 * handlers own re-pointing and removing the embedding. It used to surface as
 * a console error with a full stack, printed twice because the service logged
 * and rethrew while every caller logged again.
 */

import { App, TFile } from 'obsidian';
import { NoteEmbeddingService } from '../../src/services/embeddings/NoteEmbeddingService';
import type { EmbeddingEngine } from '../../src/services/embeddings/EmbeddingEngine';
import type { SQLiteCacheManager } from '../../src/database/storage/SQLiteCacheManager';

const NOTE_PATH = 'Notes/moved-away.md';

function enoent(path: string): NodeJS.ErrnoException {
  const error = new Error(
    `ENOENT: no such file or directory, open '${path}'`
  ) as NodeJS.ErrnoException;
  error.code = 'ENOENT';
  return error;
}

/**
 * Build a service whose vault still lists the note (a stale index) but whose
 * read fails with `readError`.
 */
function createService(readError: Error): {
  service: NoteEmbeddingService;
  queryOne: jest.Mock;
} {
  const file = new TFile('moved-away.md', NOTE_PATH);

  const app = {
    vault: {
      getAbstractFileByPath: (path: string) => (path === NOTE_PATH ? file : null),
      read: async () => { throw readError; }
    }
  } as unknown as App;

  // Reached only if the read unexpectedly succeeds.
  const queryOne = jest.fn().mockResolvedValue(undefined);
  const db = { queryOne, run: jest.fn() } as unknown as SQLiteCacheManager;

  const engine = {
    generateEmbedding: jest.fn(),
    getModelInfo: () => ({ id: 'test-model' })
  } as unknown as EmbeddingEngine;

  return { service: new NoteEmbeddingService(app, db, engine), queryOne };
}

describe('NoteEmbeddingService.embedNote — a note that moved mid-flight', () => {
  let consoleError: jest.SpyInstance;

  beforeEach(() => {
    consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleError.mockRestore();
  });

  it('skips a note whose file is gone instead of failing', async () => {
    const { service } = createService(enoent(`/vault/${NOTE_PATH}`));

    await expect(service.embedNote(NOTE_PATH)).resolves.toBeUndefined();
  });

  it('says nothing on the console when a note simply moved', async () => {
    const { service } = createService(enoent(`/vault/${NOTE_PATH}`));

    await service.embedNote(NOTE_PATH);

    expect(consoleError).not.toHaveBeenCalled();
  });

  it('recognises a missing file from the message alone, without an errno code', async () => {
    // Not every layer preserves `code` — Obsidian's adapter and the various
    // promise wrappers between here and fs can hand back a plain Error.
    const { service } = createService(
      new Error(`ENOENT: no such file or directory, open '/vault/${NOTE_PATH}'`)
    );

    await expect(service.embedNote(NOTE_PATH)).resolves.toBeUndefined();
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('still propagates a real failure to the caller', async () => {
    const { service } = createService(new Error('disk is on fire'));

    await expect(service.embedNote(NOTE_PATH)).rejects.toThrow('disk is on fire');
  });

  it('leaves reporting a real failure to the caller, which has the context', async () => {
    const { service } = createService(new Error('disk is on fire'));

    await expect(service.embedNote(NOTE_PATH)).rejects.toThrow();

    // The service used to log AND rethrow, so EmbeddingWatcher and
    // IndexingQueue each printed the same failure a second time.
    expect(consoleError).not.toHaveBeenCalled();
  });
});
