jest.mock('@dao-xyz/sqlite3-vec/wasm', () => jest.fn(), { virtual: true });

import type { App } from 'obsidian';
import { SQLiteCacheManager } from '../../src/database/storage/SQLiteCacheManager';
import { SQLitePersistenceService } from '../../src/database/storage/SQLitePersistenceService';
import { CURRENT_SCHEMA_VERSION } from '../../src/database/schema/SchemaMigrator';
import type { CacheBlobStore } from '../../src/database/storage/CacheBlobStore';

/**
 * Peak-allocation harness for the cache save path.
 *
 * Phase 0 of docs/plans/sqlite-cache-persistence-plan.md. This test changes no
 * behaviour; it produces the number every later phase is measured against, and
 * it fails if that number moves.
 *
 * The problem being measured: `SQLiteCacheManager.save()` exports the entire
 * database out of the WASM heap into one contiguous JS `ArrayBuffer`
 * (`sqlite3_js_db_export`) and hands it to a blob store that copies it again
 * (IndexedDB structured-clones on `put`; `vault.adapter.writeBinary` copies
 * across the platform boundary). The WASM heap copy never shrinks. So one save
 * holds roughly three times the database size at once, and because nothing
 * guards against overlap, the 30 s autosave timer routinely starts a second
 * full-size export while a queue-driven save is still awaiting its write.
 *
 * On a 150 MB cache that is a 450 MB peak for one save and a 750 MB peak for an
 * overlapping pair, in contiguous allocations, hundreds of times per full
 * index. The reported `RangeError: Array buffer allocation failed` is the
 * allocator refusing one of those once the heap has fragmented.
 *
 * WHAT THIS CAN AND CANNOT SEE. It counts allocations the save path asks for,
 * against a fake bridge and a fake blob store whose copy costs are modelled
 * from the real ones. It says nothing about allocator behaviour, fragmentation,
 * or when a real renderer actually refuses, which is only observable in the
 * running plugin (.skills/nexus-testing/protocols/live-loop.md). What it does
 * prove is the copy ledger: how many full-size buffers are alive at the same
 * moment, which is the thing every option in the plan is trying to reduce.
 *
 * Expected movement per phase:
 *   Phase 1 (save lock)          overlapping pair falls to the single-save peak
 *   Phase 5 option C (OPFS VFS)  per-save peak falls to roughly one page
 *   Phase 5 option D (NOCOPY +
 *     chunked write)             per-save peak falls to about 1x plus one chunk
 */

/** Database size to model. Small enough to be fast, large enough to be legible. */
const DB_SIZE_BYTES = readPositiveIntEnv('CACHE_SAVE_ALLOCATION_DB_MB', 16) * 1024 * 1024;

function readPositiveIntEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Tracks which full-size buffers are alive at each moment of a save.
 *
 * Three kinds, matching the three copies in the real path:
 *   wasm-heap   the serialized database inside the WASM linear memory. Present
 *               from the moment the database exists and never given back, which
 *               is why it is seeded rather than allocated per save.
 *   export      the contiguous JS ArrayBuffer sqlite3_js_db_export returns.
 *               Alive from the export until the write that consumes it returns.
 *   backend     the copy the backing store makes of that buffer. IndexedDB
 *               structured-clones on put and cannot be handed a transferable
 *               (recorded in docs/architecture/cloud-sync-cache-backend.md);
 *               vault.adapter.writeBinary copies across the platform boundary.
 *               Alive for the duration of the write.
 */
class AllocationLedger {
  private live = new Map<string, number>();
  private peakBytes = 0;
  private peakCount = 0;
  private nextId = 0;

  /**
   * Drop everything and start again holding only the WASM heap copy. Called
   * after initialize(), whose fresh-database save is setup and not part of any
   * measurement.
   */
  reset(wasmHeapBytes: number): void {
    this.live.clear();
    this.peakBytes = 0;
    this.peakCount = 0;
    this.allocate('wasm-heap', wasmHeapBytes);
  }

  allocate(label: string, bytes: number): string {
    const id = `${label}#${this.nextId++}`;
    this.live.set(id, bytes);
    this.sample();
    return id;
  }

  release(id: string): void {
    this.live.delete(id);
  }

  private sample(): void {
    let total = 0;
    for (const bytes of this.live.values()) {
      total += bytes;
    }
    if (total > this.peakBytes) {
      this.peakBytes = total;
      this.peakCount = this.live.size;
    }
  }

  /** Highest simultaneous live byte total seen. */
  getPeakBytes(): number {
    return this.peakBytes;
  }

  /** How many full-size buffers were alive at that peak. */
  getPeakBufferCount(): number {
    return this.peakCount;
  }
}

interface AllocationHarness {
  manager: SQLiteCacheManager;
  ledger: AllocationLedger;
  exportCount(): number;
  gateWrites(): void;
  releaseWrites(): void;
  dispose(): void;
}

async function createAllocationHarness(): Promise<AllocationHarness> {
  const ledger = new AllocationLedger();
  const held: Array<{ resolve: () => void }> = [];
  let gated = false;
  let exportCount = 0;

  const dbHandle = {
    exec: jest.fn(),
    prepare: jest.fn(),
    close: jest.fn(),
    changes: jest.fn(() => 0),
    selectValue: jest.fn(() => 'ok')
  };
  const sqlite3 = { oo1: {}, wasm: {}, capi: {} };

  /** Export id -> ledger id, so the write can release the buffer it consumed. */
  const exportedIds = new WeakMap<ArrayBuffer, string>();

  const bridge = {
    initializeModule: jest.fn(async () => sqlite3),
    createMemoryDatabase: jest.fn(() => dbHandle),
    deserializeDatabase: jest.fn(() => dbHandle),
    exportDatabase: jest.fn(() => {
      exportCount += 1;
      // A real allocation of the modelled size, so this fails the same way the
      // real one would if the number ever became absurd.
      const buffer = new ArrayBuffer(DB_SIZE_BYTES);
      exportedIds.set(buffer, ledger.allocate('export', DB_SIZE_BYTES));
      return buffer;
    }),
    exec: jest.fn(),
    executeStatement: jest.fn(),
    collectValues: jest.fn((_db: unknown, sql: string) => {
      if (sql.includes("name='schema_version'")) return [['schema_version']];
      if (sql.includes('MAX(version)')) return [[CURRENT_SCHEMA_VERSION]];
      return [];
    }),
    query: jest.fn(() => []),
    queryOne: jest.fn(() => null),
    run: jest.fn(() => ({ changes: 1, lastInsertRowid: 1 })),
    getIntegrityCheckResult: jest.fn(() => 'ok'),
    close: jest.fn()
  };

  const blobStore = {
    read: jest.fn(async () => null),
    write: jest.fn(async (buffer: ArrayBuffer) => {
      const backendId = ledger.allocate('backend', buffer.byteLength);
      try {
        if (gated) {
          await new Promise<void>(resolve => held.push({ resolve }));
        }
      } finally {
        ledger.release(backendId);
        const exportId = exportedIds.get(buffer);
        if (exportId) ledger.release(exportId);
      }
    }),
    remove: jest.fn(async () => undefined),
    getMetadata: jest.fn(async () => null)
  };

  const app = {
    vault: {
      configDir: '.obsidian',
      adapter: {
        exists: jest.fn(async () => true),
        readBinary: jest.fn(async () => new ArrayBuffer(8)),
        mkdir: jest.fn(async () => undefined),
        stat: jest.fn(async () => ({ size: DB_SIZE_BYTES }))
      }
    }
  } as unknown as App;

  const manager = new SQLiteCacheManager({
    app,
    dbPath: '.nexus/data/cache.db',
    autoSaveInterval: 0,
    blobStore: blobStore as unknown as CacheBlobStore
  });

  const internals = manager as unknown as {
    bridge: unknown;
    persistenceService: SQLitePersistenceService;
  };
  internals.bridge = bridge;
  internals.persistenceService = new SQLitePersistenceService({
    blobStore: blobStore as unknown as CacheBlobStore,
    bridge: bridge as unknown as ConstructorParameters<typeof SQLitePersistenceService>[0]['bridge']
  });

  await manager.initialize();

  // initialize() performs the fresh-database save. Everything measured below is
  // a save the test asked for, on a database that is already the modelled size.
  ledger.reset(DB_SIZE_BYTES);
  exportCount = 0;

  return {
    manager,
    ledger,
    exportCount: () => exportCount,
    gateWrites: () => { gated = true; },
    releaseWrites: () => {
      gated = false;
      while (held.length > 0) {
        held.shift()?.resolve();
      }
    },
    dispose: () => {
      gated = false;
      while (held.length > 0) {
        held.shift()?.resolve();
      }
      manager.stopAutoSave();
    }
  };
}

function formatMb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * One block, fixed field widths, every number derived. Stable enough to diff
 * between phases, which is the whole point of printing it.
 */
function report(rows: Array<{ scenario: string; exports: number; peakBytes: number; peakBuffers: number }>): void {
  const columns: Array<[string, number]> = [
    ['scenario', 18],
    ['exports', 7],
    ['buffers at peak', 15],
    ['peak bytes', 14],
    ['peak MB', 9],
    ['x db size', 9]
  ];
  const header = columns.map(([name, width]) => name.padEnd(width)).join('  ');
  const rule = columns.map(([, width]) => '-'.repeat(width)).join('  ');

  const lines = [
    '',
    '=== cache save peak allocation ===',
    `modelled database size: ${DB_SIZE_BYTES} bytes (${formatMb(DB_SIZE_BYTES)})`,
    '',
    header,
    rule
  ];
  for (const row of rows) {
    lines.push([
      row.scenario.padEnd(18),
      String(row.exports).padStart(7),
      String(row.peakBuffers).padStart(15),
      String(row.peakBytes).padStart(14),
      formatMb(row.peakBytes).padStart(9),
      `${(row.peakBytes / DB_SIZE_BYTES).toFixed(1)}x`.padStart(9)
    ].join('  '));
  }
  lines.push('');
  lines.push('Buffers counted: the WASM heap copy that never shrinks, the exported JS');
  lines.push('ArrayBuffer, and the copy the backing store makes of it. At a real 150 MB');
  lines.push('cache the same ratios are 450 MB for one save and 750 MB for a pair.');
  lines.push('');
  console.log(lines.join('\n'));
}

describe('cache save peak allocation', () => {
  let warnSpy: jest.SpyInstance;
  const rows: Array<{ scenario: string; exports: number; peakBytes: number; peakBuffers: number }> = [];

  beforeEach(() => {
    // The save path reports the cache size once a minute; not part of the
    // measurement and it would break the report block.
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  afterAll(() => {
    report(rows);
  });

  it('holds three full-size buffers during a single save', async () => {
    const harness = await createAllocationHarness();
    try {
      await harness.manager.save();

      const peakBytes = harness.ledger.getPeakBytes();
      rows.push({
        scenario: 'single save',
        exports: harness.exportCount(),
        peakBytes,
        peakBuffers: harness.ledger.getPeakBufferCount()
      });

      expect(harness.exportCount()).toBe(1);
      // WASM heap + exported buffer + the backend's copy of it.
      expect(harness.ledger.getPeakBufferCount()).toBe(3);
      expect(peakBytes).toBe(3 * DB_SIZE_BYTES);
    } finally {
      harness.dispose();
    }
  });

  // PHASE 1 CHANGES THIS NUMBER. Option A's single-flight guard means the
  // second save cannot start its own export, so this peak has to fall to the
  // single-save peak above. Until then a save requested while one is in flight
  // costs a second export and a second backend copy, and the 30 s autosave
  // timer requests exactly that on every queue-driven save, guaranteed rather
  // than occasionally: the dirty flag is not cleared until the first write
  // returns, so the timer never skips.
  it('holds five full-size buffers when two saves overlap', async () => {
    const harness = await createAllocationHarness();
    try {
      harness.gateWrites();

      const first = harness.manager.save();
      await flushMicrotasks();
      const second = harness.manager.save();
      await flushMicrotasks();

      const peakBytes = harness.ledger.getPeakBytes();
      const peakBuffers = harness.ledger.getPeakBufferCount();

      harness.releaseWrites();
      await Promise.all([first, second]);

      rows.push({
        scenario: 'overlapping pair',
        exports: harness.exportCount(),
        peakBytes,
        peakBuffers
      });

      expect(harness.exportCount()).toBe(2);
      // WASM heap + two exported buffers + two backend copies.
      expect(peakBuffers).toBe(5);
      expect(peakBytes).toBe(5 * DB_SIZE_BYTES);
      // The contract in one line: overlapping saves cost strictly more than a
      // single one. Phase 1 makes these equal, and this assertion is what says
      // so when it does.
      expect(peakBytes).toBeGreaterThan(3 * DB_SIZE_BYTES);
    } finally {
      harness.dispose();
    }
  });
});

/** Let queued microtasks run. */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 8; i++) {
    await Promise.resolve();
  }
}
