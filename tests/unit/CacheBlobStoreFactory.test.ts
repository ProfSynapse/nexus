import type { App } from 'obsidian';
import { IDBFactory } from 'fake-indexeddb';

import {
  computeIdbKey,
  createCacheBlobStore
} from '../../src/database/storage/CacheBlobStoreFactory';
import { IndexedDBCacheBlobStore } from '../../src/database/storage/IndexedDBCacheBlobStore';
import { VaultAdapterCacheBlobStore } from '../../src/database/storage/VaultAdapterCacheBlobStore';

function fakeApp(overrides: { appId?: string; basePath?: string; configDir?: string } = {}): App {
  return {
    vault: {
      adapter: {
        getBasePath: overrides.basePath !== undefined ? () => overrides.basePath! : undefined,
        exists: jest.fn(),
        readBinary: jest.fn(),
        writeBinary: jest.fn(),
        remove: jest.fn(),
        mkdir: jest.fn(),
        stat: jest.fn()
      },
      configDir: overrides.configDir ?? '.obsidian'
    },
    appId: overrides.appId
  } as unknown as App;
}

describe('createCacheBlobStore', () => {
  beforeAll(() => {
    (globalThis as { indexedDB?: IDBFactory }).indexedDB = new IDBFactory();
  });

  it('returns IndexedDBCacheBlobStore when forceDesktop=true', () => {
    const store = createCacheBlobStore({
      app: fakeApp(),
      vaultRelativePath: '.obsidian/plugins/nexus/data/cache.db',
      idbKey: 'vault-A:nexus',
      forceDesktop: true
    });
    expect(store).toBeInstanceOf(IndexedDBCacheBlobStore);
  });

  it('returns VaultAdapterCacheBlobStore when forceDesktop=false', () => {
    const store = createCacheBlobStore({
      app: fakeApp(),
      vaultRelativePath: '.obsidian/plugins/nexus/data/cache.db',
      idbKey: 'vault-A:nexus',
      forceDesktop: false
    });
    expect(store).toBeInstanceOf(VaultAdapterCacheBlobStore);
  });
});

describe('computeIdbKey', () => {
  it('uses app.appId when present', () => {
    const key = computeIdbKey(fakeApp({ appId: 'abc123' }), 'nexus');
    expect(key).toBe('abc123:nexus');
  });

  it('falls back to FNV-1a hash of base path when appId missing', () => {
    const key = computeIdbKey(fakeApp({ basePath: '/Users/me/vault' }), 'nexus');
    expect(key).toMatch(/^path:[a-f0-9]{8}:nexus$/);
  });

  it('produces stable hash across calls with same path', () => {
    const a = computeIdbKey(fakeApp({ basePath: '/Users/me/vault' }), 'nexus');
    const b = computeIdbKey(fakeApp({ basePath: '/Users/me/vault' }), 'nexus');
    expect(a).toBe(b);
  });

  it('produces different keys for different paths', () => {
    const a = computeIdbKey(fakeApp({ basePath: '/Users/me/vault-A' }), 'nexus');
    const b = computeIdbKey(fakeApp({ basePath: '/Users/me/vault-B' }), 'nexus');
    expect(a).not.toBe(b);
  });

  it('falls back to configDir when basePath unavailable', () => {
    const key = computeIdbKey(fakeApp({ configDir: '.obsidian' }), 'nexus');
    expect(key).toMatch(/^path:[a-f0-9]{8}:nexus$/);
  });

  it('partitions by plugin manifest dir', () => {
    const a = computeIdbKey(fakeApp({ appId: 'abc' }), 'nexus');
    const b = computeIdbKey(fakeApp({ appId: 'abc' }), 'claudesidian-mcp');
    expect(a).not.toBe(b);
  });
});
