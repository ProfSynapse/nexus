/**
 * Startup-ordering tests for the `notesIndex` service definition.
 *
 * The notes index issues DDL on the storage adapter's shared SQLite
 * connection. Starting it before that connection exists throws
 * "Database not initialized" out of a background promise and leaves the index
 * empty for the whole session, silently. These tests pin the gate:
 *
 *  1. no SQL before the adapter reports query-ready, and
 *  2. a storage adapter that never became usable produces a loud, specific
 *     failure naming the real cause — not a generic SQLite error, and not a
 *     swallowed one.
 *
 * Real NotesIndexService/NotesIndexBuilder, fake adapter + fake vault; no
 * Obsidian runtime and no real database.
 */

import { CORE_SERVICE_DEFINITIONS, type ServiceCreationContext } from '../../src/core/services/ServiceDefinitions';
import type { NotesIndexBuilder } from '../../src/database/services/notesIndex/NotesIndexBuilder';

function notesIndexDefinition() {
  const def = CORE_SERVICE_DEFINITIONS.find((d) => d.name === 'notesIndex');
  if (!def) throw new Error('notesIndex service definition missing');
  return def;
}

interface FakeAdapterOptions {
  /** Resolution of waitForQueryReady(). */
  queryReady: boolean;
  /** Whether the adapter itself initialized (db open). */
  ready: boolean;
  initError?: Error | null;
  /** Delay (ms) before waitForQueryReady settles. */
  gateDelayMs?: number;
}

function makeFakeAdapter(opts: FakeAdapterOptions) {
  const exec = jest.fn().mockResolvedValue(undefined);
  const sqlite = {
    exec,
    query: jest.fn().mockResolvedValue([]),
    queryOne: jest.fn().mockResolvedValue(null),
    run: jest.fn().mockResolvedValue(undefined),
    transaction: jest.fn(async (fn: () => Promise<unknown>) => fn()),
  };

  const adapter = {
    isReady: () => opts.ready,
    getInitError: () => opts.initError ?? null,
    getSqliteCache: () => sqlite,
    waitForQueryReady: jest.fn(
      () =>
        new Promise<boolean>((resolve) => {
          setTimeout(() => resolve(opts.queryReady), opts.gateDelayMs ?? 0);
        })
    ),
  };

  return { adapter, sqlite, exec };
}

function makeContext(adapter: unknown): ServiceCreationContext {
  const app = {
    vault: {
      getMarkdownFiles: () => [],
      getAbstractFileByPath: () => null,
      on: () => ({}),
      offref: () => undefined,
    },
    metadataCache: {
      getFileCache: () => ({}),
      on: () => ({}),
      offref: () => undefined,
    },
  };

  return {
    plugin: { app } as unknown as ServiceCreationContext['plugin'],
    app: app as unknown as ServiceCreationContext['app'],
    settings: {} as ServiceCreationContext['settings'],
    manifest: {} as ServiceCreationContext['manifest'],
    serviceManager: {
      getService: jest.fn().mockResolvedValue(adapter),
      getServiceIfReady: jest.fn().mockReturnValue(adapter),
    } as unknown as ServiceCreationContext['serviceManager'],
  };
}

describe('notesIndex service definition (startup ordering)', () => {
  it('issues no SQL until the storage adapter reports query-ready', async () => {
    const { adapter, exec } = makeFakeAdapter({ queryReady: true, ready: true, gateDelayMs: 20 });
    const pending = notesIndexDefinition().create(makeContext(adapter));

    // Gate still open: the schema must not have been touched yet.
    await new Promise((r) => setTimeout(r, 5));
    expect(exec).not.toHaveBeenCalled();

    const builder = (await pending) as NotesIndexBuilder;
    expect(adapter.waitForQueryReady).toHaveBeenCalled();
    expect(exec).toHaveBeenCalledTimes(1);
    expect(String(exec.mock.calls[0][0])).toContain('CREATE TABLE IF NOT EXISTS notes');
    builder.stop();
  });

  it('fails loudly with the real cause when storage never initialized', async () => {
    const { adapter, exec } = makeFakeAdapter({
      queryReady: false,
      ready: false,
      initError: new Error('sqlite3.wasm not found'),
    });

    await expect(notesIndexDefinition().create(makeContext(adapter))).rejects.toThrow(
      /storage adapter failed to initialize.*sqlite3\.wasm not found/
    );
    // Crucially: it never touched the dead connection.
    expect(exec).not.toHaveBeenCalled();
  });

  it('still builds the index when hydration degraded but the connection is open', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const { adapter, exec } = makeFakeAdapter({ queryReady: false, ready: true });
      const builder = (await notesIndexDefinition().create(makeContext(adapter))) as NotesIndexBuilder;

      expect(exec).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalled();
      builder.stop();
    } finally {
      warn.mockRestore();
    }
  });
});
