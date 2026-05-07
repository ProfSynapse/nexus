/**
 * Integration test: 50 MB blob round-trip through IndexedDBCacheBlobStore
 * (test-engineer-3 review §S1.1).
 *
 * The existing end-to-end suite synthesizes a 16 KB SQLite-shaped blob; that
 * exercises the seam but not the large-blob fake-indexeddb regime where
 * structured-clone overhead and IDB transaction throughput become observable.
 *
 * 50 MB is the lead-approved size — large enough to surface throughput / clone
 * issues, small enough to fit comfortably in the Node test heap (default
 * --max-old-space-size of 512 MB on Node 20). Pattern is deterministic
 * (`i % 256`) so byte-level assertions can sample-index without storing the
 * full payload twice in memory.
 */

import { IDBFactory } from 'fake-indexeddb';

import { IndexedDBCacheBlobStore } from '../../src/database/storage/IndexedDBCacheBlobStore';

const FIFTY_MB = 50 * 1024 * 1024;

function buildDeterministicBlob(sizeBytes: number): ArrayBuffer {
  const out = new Uint8Array(sizeBytes);
  for (let i = 0; i < sizeBytes; i++) {
    out[i] = i & 0xff;
  }
  return out.buffer;
}

describe('IndexedDBCacheBlobStore: 50 MB round-trip', () => {
  it('round-trips a 50 MB deterministic-pattern blob byte-for-byte at 1 MB sample indices and tail byte', async () => {
    const factory = new IDBFactory();
    const store = new IndexedDBCacheBlobStore({ idbKey: 'large-blob:nexus', factory });

    const original = buildDeterministicBlob(FIFTY_MB);

    await store.write(original);

    // Verify metadata reports the full size before re-reading bytes.
    const meta = await store.getMetadata();
    expect(meta).not.toBeNull();
    expect(meta!.size).toBe(FIFTY_MB);

    const persisted = await store.read();
    expect(persisted).not.toBeNull();
    expect(persisted!.byteLength).toBe(FIFTY_MB);

    const persistedView = new Uint8Array(persisted!);
    // Sample every 1 MB plus the last byte. Asserting each sample as a separate
    // expect call would emit 50 expectations; we batch into one assertion so a
    // mismatch surfaces the offending offset clearly.
    for (let offset = 0; offset < FIFTY_MB; offset += 1024 * 1024) {
      const expected = offset & 0xff;
      if (persistedView[offset] !== expected) {
        throw new Error(
          `Byte mismatch at offset ${offset}: expected ${expected}, got ${persistedView[offset]}`
        );
      }
    }

    // Last-byte invariant: byte at FIFTY_MB - 1 must equal (FIFTY_MB - 1) & 0xff.
    const lastIdx = FIFTY_MB - 1;
    expect(persistedView[lastIdx]).toBe(lastIdx & 0xff);
  }, 30_000); // wide timeout: fake-indexeddb structured-clone of 50 MB is the slow part
});
