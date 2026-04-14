/**
 * Shared in-memory vault adapter mock for tests that exercise
 * vault.adapter (ShardedJsonlStreamStore, VaultEventStore, migration
 * services, JSONLWriter, PluginScopedStorageCoordinator).
 *
 * The adapter maintains a Map-backed file system and Set-backed
 * directory tree, supporting exists / read / write / append / stat /
 * list / mkdir — the same surface area as Obsidian's DataAdapter.
 */

import type { App } from 'obsidian';

type AdapterFileEntry = {
  content: string;
  mtime: number;
  size: number;
};

export type MockAdapter = {
  exists: jest.Mock<Promise<boolean>, [string]>;
  read: jest.Mock<Promise<string>, [string]>;
  write: jest.Mock<Promise<void>, [string, string]>;
  append: jest.Mock<Promise<void>, [string, string]>;
  stat: jest.Mock<Promise<{ mtime: number; size: number } | null>, [string]>;
  list: jest.Mock<Promise<{ files: string[]; folders: string[] }>, [string]>;
  mkdir: jest.Mock<Promise<void>, [string]>;
};

export interface CreateMockAppOptions {
  /** Seed files: path → content. */
  initialFiles?: Record<string, string>;
  /** Set `app.vault.configDir` (used by VaultRootRelocationService). */
  configDir?: string;
  /** Add `app.loadLocalStorage` / `app.saveLocalStorage` stubs (used by JSONLWriter). */
  withLocalStorage?: boolean;
}

export function createMockApp(options: CreateMockAppOptions = {}): {
  app: App;
  adapter: MockAdapter;
} {
  const { initialFiles = {}, configDir, withLocalStorage } = options;
  const files = new Map<string, AdapterFileEntry>();
  const directories = new Set<string>();
  let tick = 1;

  const addDirectoryTree = (path: string): void => {
    const parts = path.split('/').filter(Boolean);
    let current = '';
    for (const part of parts) {
      current = current.length > 0 ? `${current}/${part}` : part;
      directories.add(current);
    }
  };

  const setFile = (path: string, content: string): void => {
    const normalizedPath = path.replace(/\\/g, '/');
    const parent = normalizedPath.includes('/')
      ? normalizedPath.slice(0, normalizedPath.lastIndexOf('/'))
      : '';
    if (parent) {
      addDirectoryTree(parent);
    }
    files.set(normalizedPath, {
      content,
      mtime: tick++,
      size: new TextEncoder().encode(content).byteLength
    });
  };

  for (const [path, content] of Object.entries(initialFiles)) {
    setFile(path, content);
  }

  const adapter: MockAdapter = {
    exists: jest.fn(async (path: string) => {
      const normalizedPath = path.replace(/\\/g, '/');
      return files.has(normalizedPath) || directories.has(normalizedPath);
    }),
    read: jest.fn(async (path: string) => {
      const normalizedPath = path.replace(/\\/g, '/');
      const entry = files.get(normalizedPath);
      if (!entry) {
        throw new Error(`Missing file: ${normalizedPath}`);
      }
      return entry.content;
    }),
    write: jest.fn(async (path: string, content: string) => {
      setFile(path, content);
    }),
    append: jest.fn(async (path: string, content: string) => {
      const normalizedPath = path.replace(/\\/g, '/');
      const existing = files.get(normalizedPath);
      if (!existing) {
        setFile(normalizedPath, content);
        return;
      }
      setFile(normalizedPath, `${existing.content}${content}`);
    }),
    stat: jest.fn(async (path: string) => {
      const normalizedPath = path.replace(/\\/g, '/');
      const entry = files.get(normalizedPath);
      if (!entry) {
        return null;
      }
      return { mtime: entry.mtime, size: entry.size };
    }),
    list: jest.fn(async (path: string) => {
      const normalizedPath = path.replace(/\\/g, '/').replace(/\/+$/g, '');
      const filePaths = Array.from(files.keys()).filter(filePath => {
        const parent = filePath.includes('/') ? filePath.slice(0, filePath.lastIndexOf('/')) : '';
        return parent === normalizedPath;
      });

      const folderPaths = Array.from(directories.values()).filter(dirPath => {
        const parent = dirPath.includes('/') ? dirPath.slice(0, dirPath.lastIndexOf('/')) : '';
        return parent === normalizedPath;
      });

      return { files: filePaths, folders: folderPaths };
    }),
    mkdir: jest.fn(async (path: string) => {
      addDirectoryTree(path.replace(/\\/g, '/'));
    })
  };

  const vault: Record<string, unknown> = { adapter };
  if (configDir !== undefined) {
    vault.configDir = configDir;
  }

  const appShape: Record<string, unknown> = { vault };
  if (withLocalStorage) {
    appShape.loadLocalStorage = jest.fn().mockReturnValue('device-a');
    appShape.saveLocalStorage = jest.fn();
  }

  const app = appShape as unknown as App;

  return { app, adapter };
}
