import { SQLitePersistenceService } from '../../src/database/storage/SQLitePersistenceService';
import type {
  SQLiteDatabaseHandle,
  SQLiteWasmBridge,
  SQLiteWasmModule
} from '../../src/database/storage/SQLiteWasmBridge';
import type { CacheBlobStore } from '../../src/database/storage/CacheBlobStore';

interface MockBlobStore extends CacheBlobStore {
  read: jest.Mock<Promise<ArrayBuffer | null>, []>;
  write: jest.Mock<Promise<void>, [ArrayBuffer]>;
  remove: jest.Mock<Promise<void>, []>;
  getMetadata: jest.Mock<Promise<{ size: number; mtime?: number } | null>, []>;
}

function createService() {
  const blobStore: MockBlobStore = {
    read: jest.fn().mockResolvedValue(null),
    write: jest.fn().mockResolvedValue(undefined),
    remove: jest.fn().mockResolvedValue(undefined),
    getMetadata: jest.fn().mockResolvedValue(null)
  };

  const db = {
    exec: jest.fn<void, [string]>(),
    prepare: jest.fn(),
    close: jest.fn(),
    changes: jest.fn(),
    selectValue: jest.fn()
  } as unknown as SQLiteDatabaseHandle;

  const bridge = {
    createMemoryDatabase: jest.fn().mockReturnValue(db),
    exec: jest.fn(),
    exportDatabase: jest.fn().mockReturnValue(new ArrayBuffer(8)),
    deserializeDatabase: jest.fn().mockReturnValue(db),
    getIntegrityCheckResult: jest.fn().mockReturnValue('ok')
  } as unknown as SQLiteWasmBridge;

  const sqlite3 = {} as SQLiteWasmModule;

  return {
    service: new SQLitePersistenceService({ blobStore, bridge }),
    blobStore,
    bridge,
    db,
    sqlite3
  };
}

/** Flatten every argument of every call into one searchable string. */
function messagesFrom(spy: jest.SpyInstance): string {
  return spy.mock.calls
    .map(call => call.map(arg => (arg instanceof Error ? arg.message : String(arg))).join(' '))
    .join('\n');
}

/**
 * Only the composed message — `call[0]` — with the trailing Error argument
 * excluded.
 *
 * This distinction is the whole assertion, not a detail. The Error object is
 * also handed to `console.error` as a second argument, so a message that
 * interpolated *none* of the cause would still satisfy a search across all
 * arguments and the test would pass while the useful half of the report had
 * been deleted. What a bug report actually carries is the red line someone
 * copies; an object the console renders behind a disclosure triangle is not
 * that. So assert the cause against the composed string.
 */
function formattedFrom(spy: jest.SpyInstance): string {
  return spy.mock.calls.map(call => String(call[0])).join('\n');
}

describe('SQLitePersistenceService', () => {
  it('creates a fresh schema database when the blob store has no data', async () => {
    const { service, blobStore, bridge, db, sqlite3 } = createService();
    blobStore.read.mockResolvedValue(null);

    const result = await service.loadDatabase(sqlite3, 'CREATE TABLE test (id TEXT);');

    expect(result).toBe(db);
    expect(bridge.createMemoryDatabase).toHaveBeenCalledWith(sqlite3);
    expect(bridge.exec).toHaveBeenCalledWith(db, 'CREATE TABLE test (id TEXT);');
    expect(bridge.deserializeDatabase).not.toHaveBeenCalled();
  });

  it('writes the exported buffer to the blob store on save', async () => {
    const { service, blobStore, bridge, db, sqlite3 } = createService();

    await service.saveDatabase(sqlite3, db);

    expect(bridge.exportDatabase).toHaveBeenCalledWith(sqlite3, db);
    expect(blobStore.write).toHaveBeenCalledWith(expect.any(ArrayBuffer));
  });

  it('recreates the database when integrity check fails', async () => {
    const { service, blobStore, bridge, db, sqlite3 } = createService();
    blobStore.read.mockResolvedValue(new Uint8Array([1, 2, 3]).buffer);
    bridge.getIntegrityCheckResult = jest.fn().mockReturnValue('corrupt') as typeof bridge.getIntegrityCheckResult;

    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const result = await service.loadDatabase(sqlite3, 'CREATE TABLE test (id TEXT);');

      expect(result).toBe(db);
      expect(blobStore.remove).toHaveBeenCalled();
      expect(blobStore.write).toHaveBeenCalledWith(expect.any(ArrayBuffer));
    } finally {
      errSpy.mockRestore();
    }
  });

  // Regression (#209): this recovery ran inside a bare `catch {}`. The cache was
  // discarded and rebuilt with nothing written to the console, so the reporter's
  // log showed only the downstream symptom and the cause stayed invisible for
  // months. The rebuild must announce itself.
  describe('corrupt-cache recovery is observable', () => {
    it('logs the integrity failure, its cause and the rebuild-from-event-store consequence', async () => {
      const { service, blobStore, bridge, sqlite3 } = createService();
      blobStore.read.mockResolvedValue(new Uint8Array([1, 2, 3, 4, 5]).buffer);
      bridge.getIntegrityCheckResult = jest.fn()
        .mockReturnValue('*** in database main ***\nPage 3 is never used') as typeof bridge.getIntegrityCheckResult;

      const errSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        await service.loadDatabase(sqlite3, 'CREATE TABLE test (id TEXT);');

        expect(errSpy).toHaveBeenCalled();
        const formatted = formattedFrom(errSpy);
        expect(formatted).toContain('integrity check');
        expect(formatted).toContain('rebuilding from scratch');
        // The sqlite integrity_check output must survive into the composed
        // message — it is the only clue about what actually went wrong, and it
        // has to be in the line someone copies, not only in the Error argument.
        expect(formatted).toContain('Page 3 is never used');
        // And the user has to be told the rebuild itself did not destroy anything.
        expect(formatted).toContain('event store');
        expect(formatted).toContain('5 bytes');
        // The Error object still goes along for a console reader who wants the stack.
        expect(errSpy.mock.calls.some(call => call[1] instanceof Error)).toBe(true);
      } finally {
        errSpy.mockRestore();
      }
    });

    // The two halves of the reassurance are different claims and must not be
    // collapsed: "this rebuild threw nothing away" is a fact about the rebuild,
    // whereas "your data is back" depends on a replay that happens elsewhere and
    // can independently fail. A message that only promised the second would send
    // someone with a genuinely broken replay away reassured.
    it('separates "the rebuild lost nothing" from "the replay has to run"', async () => {
      const { service, blobStore, bridge, sqlite3 } = createService();
      blobStore.read.mockResolvedValue(new Uint8Array([1, 2, 3]).buffer);
      bridge.getIntegrityCheckResult = jest.fn().mockReturnValue('corrupt') as typeof bridge.getIntegrityCheckResult;

      const errSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        await service.loadDatabase(sqlite3, 'CREATE TABLE test (id TEXT);');

        const formatted = formattedFrom(errSpy);
        expect(formatted).toContain('deletes no user data');
        expect(formatted).toContain('source of truth');
        expect(formatted).toContain('replayed');
        expect(formatted).toContain('if anything still looks missing after this');
      } finally {
        errSpy.mockRestore();
      }
    });

    it('logs when the integrity check itself throws rather than returning a verdict', async () => {
      const { service, blobStore, bridge, sqlite3 } = createService();
      blobStore.read.mockResolvedValue(new Uint8Array([1, 2, 3]).buffer);
      bridge.getIntegrityCheckResult = jest.fn(() => {
        throw new Error('database disk image is malformed');
      }) as typeof bridge.getIntegrityCheckResult;

      const errSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        await service.loadDatabase(sqlite3, 'CREATE TABLE test (id TEXT);');

        const formatted = formattedFrom(errSpy);
        expect(formatted).toContain('integrity check');
        expect(formatted).toContain('database disk image is malformed');
        expect(formatted).toContain('event store');
      } finally {
        errSpy.mockRestore();
      }
    });

    it('logs when the blob cannot be deserialized at all', async () => {
      const { service, blobStore, bridge, sqlite3 } = createService();
      blobStore.read.mockResolvedValue(new Uint8Array([1, 2, 3]).buffer);
      bridge.deserializeDatabase = jest.fn(() => {
        throw new Error('not a database');
      }) as typeof bridge.deserializeDatabase;

      const errSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        await service.loadDatabase(sqlite3, 'CREATE TABLE test (id TEXT);');

        const formatted = formattedFrom(errSpy);
        expect(formatted).toContain('not a database');
        expect(formatted).toContain('rebuilding from scratch');
        expect(formatted).toContain('event store');
      } finally {
        errSpy.mockRestore();
      }
    });

    it('warns but still rebuilds when the corrupt blob cannot be deleted', async () => {
      const { service, blobStore, bridge, db, sqlite3 } = createService();
      blobStore.read.mockResolvedValue(new Uint8Array([1, 2, 3]).buffer);
      bridge.getIntegrityCheckResult = jest.fn().mockReturnValue('corrupt') as typeof bridge.getIntegrityCheckResult;
      blobStore.remove.mockRejectedValue(new Error('EPERM: operation not permitted'));

      const errSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        const result = await service.loadDatabase(sqlite3, 'CREATE TABLE test (id TEXT);');

        // Behaviour unchanged: the rebuild still happens.
        expect(result).toBe(db);
        expect(blobStore.write).toHaveBeenCalledWith(expect.any(ArrayBuffer));

        const warned = messagesFrom(warnSpy);
        expect(warned).toContain('EPERM: operation not permitted');
      } finally {
        warnSpy.mockRestore();
        errSpy.mockRestore();
      }
    });
  });

  // The other half of "say so": a report that also fires on ordinary launches is
  // worth nothing, because every user learns to ignore it. None of these is
  // corruption, and none of them may produce a line.
  describe('benign launches stay silent', () => {
    async function expectSilent(
      arrange: (ctx: ReturnType<typeof createService>) => void
    ): Promise<void> {
      const ctx = createService();
      arrange(ctx);

      const errSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        await ctx.service.loadDatabase(ctx.sqlite3, 'CREATE TABLE test (id TEXT);');

        expect(messagesFrom(errSpy)).toBe('');
        expect(messagesFrom(warnSpy)).toBe('');
        // Recovery must not have been entered at all.
        expect(ctx.blobStore.remove).not.toHaveBeenCalled();
      } finally {
        warnSpy.mockRestore();
        errSpy.mockRestore();
      }
    }

    it('says nothing on a first launch, when no cache blob exists yet', async () => {
      await expectSilent(({ blobStore }) => {
        blobStore.read.mockResolvedValue(null);
      });
    });

    it('says nothing when the cache blob exists but is zero bytes', async () => {
      await expectSilent(({ blobStore }) => {
        blobStore.read.mockResolvedValue(new ArrayBuffer(0));
      });
    });

    it('says nothing when a healthy cache loads normally', async () => {
      await expectSilent(({ blobStore }) => {
        blobStore.read.mockResolvedValue(new Uint8Array([1, 2, 3]).buffer);
      });
    });

    // A cache written by an older schema version is upgraded by SchemaMigrator
    // *after* loadDatabase returns. `PRAGMA integrity_check` reports on page
    // structure and says nothing about `user_version`, so an upgrade must reach
    // the migrator as an ordinary healthy load — never be mistaken for
    // corruption and thrown away, which would turn every version bump into a
    // full rebuild.
    it('hands an older-schema cache back intact rather than treating the upgrade as corruption', async () => {
      const { service, blobStore, bridge, db, sqlite3 } = createService();
      blobStore.read.mockResolvedValue(new Uint8Array([1, 2, 3]).buffer);
      // Structurally sound database, older `user_version` — exactly what a
      // pre-v16 install presents on the launch that upgrades it.
      bridge.getIntegrityCheckResult = jest.fn().mockReturnValue('ok') as typeof bridge.getIntegrityCheckResult;

      const errSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        const result = await service.loadDatabase(sqlite3, 'CREATE TABLE test (id TEXT);');

        // The deserialized handle survives, so the migrator upgrades real data
        // instead of an empty replacement.
        expect(result).toBe(db);
        expect(bridge.deserializeDatabase).toHaveBeenCalled();
        expect(blobStore.remove).not.toHaveBeenCalled();
        expect(messagesFrom(errSpy)).toBe('');
      } finally {
        errSpy.mockRestore();
      }
    });
  });
});
