jest.mock('@dao-xyz/sqlite3-vec/wasm', () => jest.fn(), { virtual: true });

import {
  SQLiteWasmBridge,
  deserializeSlackBytes
} from '../../src/database/storage/SQLiteWasmBridge';
import type { SQLiteWasmModule, SQLiteDatabaseHandle } from '../../src/database/storage/SQLiteWasmBridge';

const NOCOPY = 1;

/**
 * A fake sqlite3 module over a real byte heap: alloc is a bump allocator, and
 * sqlite3_serialize(NOCOPY) hands back the buffer a database was deserialized
 * from, the way memdb does, or 0 for a database that was never deserialized.
 */
function fakeModule(heapBytes = 4096) {
  const heap = new Uint8Array(heapBytes);
  let next = 8;
  const buffers = new Map<object, { ptr: number; size: number; capacity: number }>();
  const allocs: number[] = [];
  const module = {
    oo1: { DB: jest.fn().mockImplementation(() => ({ exec: jest.fn(), prepare: jest.fn(), close: jest.fn(), changes: jest.fn(), selectValue: jest.fn() })) },
    wasm: {
      allocFromTypedArray: jest.fn(),
      alloc: jest.fn((n: number) => { allocs.push(n); if (next + n > heap.byteLength) throw new Error('Failed to allocate'); const p = next; next += n; return p; }),
      dealloc: jest.fn(),
      heap8u: () => heap,
      peek64: (p: number) => new DataView(heap.buffer).getBigInt64(p, true)
    },
    capi: {
      SQLITE_DESERIALIZE_FREEONCLOSE: 1,
      SQLITE_DESERIALIZE_RESIZEABLE: 2,
      SQLITE_SERIALIZE_NOCOPY: NOCOPY,
      sqlite3_deserialize: jest.fn((db: object, _s: string, ptr: number, size: number, capacity: number) => { buffers.set(db, { ptr, size, capacity }); return 0; }),
      sqlite3_serialize: jest.fn((db: object, _s: string, sizePtr: number, flags: number) => {
        const b = buffers.get(db);
        new DataView(heap.buffer).setBigInt64(sizePtr, BigInt(b?.size ?? 0), true);
        return flags === NOCOPY && b ? b.ptr : 0;
      }),
      sqlite3_js_db_export: jest.fn(() => new Uint8Array([9, 9, 9])),
      sqlite3_get_autocommit: jest.fn(() => 1),
      sqlite3_last_insert_rowid: jest.fn()
    }
  };
  return { module: module as unknown as SQLiteWasmModule & typeof module, heap, buffers, allocs };
}

describe('SQLiteWasmBridge memory behaviour', () => {
  const bridge = new SQLiteWasmBridge();

  it('opens a database with slack behind it, so the first new page does not double the buffer', () => {
    const { module, buffers } = fakeModule(16 * 1024 * 1024);
    const data = new Uint8Array([1, 2, 3, 4]);
    const db = bridge.deserializeDatabase(module, data);
    const b = buffers.get(db as unknown as object)!;
    expect(b.size).toBe(4);
    expect(b.capacity).toBe(4 + deserializeSlackBytes(4));
  });

  it('falls back to an exact-size buffer when the heap cannot spare the slack', () => {
    const { module, buffers } = fakeModule(64);
    const db = bridge.deserializeDatabase(module, new Uint8Array([1, 2, 3, 4]));
    expect(buffers.get(db as unknown as object)!.capacity).toBe(4);
  });

  it('exports by copying the database straight out of the heap, without the in-heap export copy', () => {
    const { module } = fakeModule(64 * 1024 * 1024);
    const data = new Uint8Array([5, 6, 7, 8, 9]);
    const db = bridge.deserializeDatabase(module, data);
    const out = new Uint8Array(bridge.exportDatabase(module, db));
    expect(Array.from(out)).toEqual([5, 6, 7, 8, 9]);
    expect(module.capi.sqlite3_js_db_export).not.toHaveBeenCalled();
  });

  it('falls back to sqlite3_js_db_export for a database that was never deserialized', () => {
    const { module } = fakeModule();
    const fresh = bridge.createMemoryDatabase(module);
    const out = new Uint8Array(bridge.exportDatabase(module, fresh));
    expect(Array.from(out)).toEqual([9, 9, 9]);
  });

  it('reports whether a connection is inside a transaction', () => {
    const { module } = fakeModule();
    const db = bridge.createMemoryDatabase(module) as SQLiteDatabaseHandle;
    expect(bridge.isAutocommit(module, db)).toBe(true);
    module.capi.sqlite3_get_autocommit.mockReturnValue(0);
    expect(bridge.isAutocommit(module, db)).toBe(false);
  });

});
});
