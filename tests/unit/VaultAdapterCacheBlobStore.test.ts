import type { DataAdapter } from 'obsidian';

import { VaultAdapterCacheBlobStore } from '../../src/database/storage/VaultAdapterCacheBlobStore';

interface FakeFile {
  bytes: ArrayBuffer;
  mtime: number;
}

function createFakeAdapter(): DataAdapter & { _files: Map<string, FakeFile>; _dirs: Set<string> } {
  const files = new Map<string, FakeFile>();
  const dirs = new Set<string>();
  const adapter = {
    exists: jest.fn(async (path: string) => files.has(path) || dirs.has(path)),
    readBinary: jest.fn(async (path: string) => {
      const file = files.get(path);
      if (!file) throw new Error(`not found: ${path}`);
      return file.bytes;
    }),
    writeBinary: jest.fn(async (path: string, bytes: ArrayBuffer) => {
      files.set(path, { bytes, mtime: Date.now() });
    }),
    remove: jest.fn(async (path: string) => {
      if (!files.delete(path)) throw new Error(`not found: ${path}`);
    }),
    mkdir: jest.fn(async (path: string) => {
      dirs.add(path);
    }),
    stat: jest.fn(async (path: string) => {
      const f = files.get(path);
      if (!f) return null;
      return { type: 'file', ctime: f.mtime, mtime: f.mtime, size: f.bytes.byteLength };
    })
  } as unknown as DataAdapter;
  return Object.assign(adapter, { _files: files, _dirs: dirs }) as DataAdapter & {
    _files: Map<string, FakeFile>;
    _dirs: Set<string>;
  };
}

describe('VaultAdapterCacheBlobStore', () => {
  it('returns null when the file does not exist', async () => {
    const adapter = createFakeAdapter();
    const store = new VaultAdapterCacheBlobStore({ adapter, path: 'cache/cache.db' });
    expect(await store.read()).toBeNull();
    expect(await store.getMetadata()).toBeNull();
  });

  it('round-trips a written buffer', async () => {
    const adapter = createFakeAdapter();
    const store = new VaultAdapterCacheBlobStore({ adapter, path: 'cache/cache.db' });
    const payload = new Uint8Array([7, 7, 7]).buffer;

    await store.write(payload);

    const read = await store.read();
    expect(read).not.toBeNull();
    expect(new Uint8Array(read!)).toEqual(new Uint8Array(payload));

    const meta = await store.getMetadata();
    expect(meta?.size).toBe(3);
    expect(typeof meta?.mtime).toBe('number');
  });

  it('creates the parent directory before writing', async () => {
    const adapter = createFakeAdapter();
    const store = new VaultAdapterCacheBlobStore({ adapter, path: 'a/b/cache.db' });

    await store.write(new ArrayBuffer(4));

    expect(adapter.mkdir).toHaveBeenCalledWith('a/b');
  });

  it('treats remove as idempotent when file is absent', async () => {
    const adapter = createFakeAdapter();
    const store = new VaultAdapterCacheBlobStore({ adapter, path: 'cache/cache.db' });
    await expect(store.remove()).resolves.toBeUndefined();
  });

  it('treats a 0-byte file as absent', async () => {
    const adapter = createFakeAdapter();
    const store = new VaultAdapterCacheBlobStore({ adapter, path: 'cache/cache.db' });
    await store.write(new ArrayBuffer(0));
    expect(await store.read()).toBeNull();
  });

  it('returns null metadata when adapter.stat returns null even though exists() was true', async () => {
    const adapter = createFakeAdapter();
    const store = new VaultAdapterCacheBlobStore({ adapter, path: 'cache/cache.db' });
    await store.write(new Uint8Array([1, 2, 3]).buffer);
    // Force stat() to return null while exists() still reports true. Models
    // rare adapter races where the file disappears between the two calls.
    (adapter.stat as jest.Mock).mockResolvedValueOnce(null);
    expect(await store.getMetadata()).toBeNull();
  });

  it('skips mkdir when the parent directory already exists', async () => {
    const adapter = createFakeAdapter();
    adapter._dirs.add('a/b');
    const store = new VaultAdapterCacheBlobStore({ adapter, path: 'a/b/cache.db' });
    await store.write(new ArrayBuffer(4));
    expect(adapter.mkdir).not.toHaveBeenCalled();
  });

  it('does not attempt mkdir for a top-level path with no parent', async () => {
    const adapter = createFakeAdapter();
    const store = new VaultAdapterCacheBlobStore({ adapter, path: 'cache.db' });
    await store.write(new ArrayBuffer(4));
    expect(adapter.mkdir).not.toHaveBeenCalled();
  });
});
