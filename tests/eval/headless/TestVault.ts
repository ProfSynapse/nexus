/**
 * tests/eval/headless/TestVault.ts — Filesystem-backed Obsidian Vault mock.
 *
 * Provides both vault.* (high-level TFile/TFolder) and vault.adapter.*
 * (low-level DataAdapter) interfaces backed by a real directory on disk.
 * An in-memory registry of TFile/TFolder objects stays synchronized with
 * the filesystem so both access patterns see consistent state.
 *
 * Used by HeadlessAgentStack to provide real agents with a working vault.
 */

import * as fs from 'node:fs';
import * as nodePath from 'node:path';

// Import the mock classes that jest resolves from tests/mocks/obsidian/.
// At test runtime, 'obsidian' maps to the mock — so instanceof checks
// in agent code will match these instances.
import { TFile, TFolder } from 'obsidian';

import type {
  DataAdapter,
  FileStats,
  ListedFiles,
  Stat,
  TAbstractFile,
  Vault,
  DataWriteOptions,
} from 'obsidian';

// ---------------------------------------------------------------------------
// TFile / TFolder factories
// ---------------------------------------------------------------------------

/**
 * Create a TFile instance using the mock class from the obsidian mock.
 * After construction we augment it with stat, parent, and vault properties
 * that the mock class doesn't provide but agent code expects.
 */
function makeTFile(
  vault: TestVault,
  filePath: string,
  size: number,
  mtimeMs: number,
  ctimeMs: number,
): TFile {
  const name = nodePath.basename(filePath);
  // Mock TFile constructor accepts (name, path) — cast to bypass strict type checking
  const file = new (TFile as unknown as new (n: string, p: string) => TFile)(name, filePath);
  // Augment with properties the mock doesn't define
  const f = file as TFile & { vault: unknown; stat: FileStats; parent: TFolder | null };
  f.vault = vault as unknown as Vault;
  f.stat = { ctime: ctimeMs, mtime: mtimeMs, size };
  f.parent = null; // wired up by rebuildTree()
  return f;
}

function makeTFolder(vault: TestVault, folderPath: string): TFolder {
  const normalizedPath = folderPath === '/' ? '/' : folderPath;
  // Mock TFolder constructor accepts (path) — cast to bypass strict type checking
  const folder = new (TFolder as unknown as new (p: string) => TFolder)(normalizedPath);
  // Augment with properties the mock doesn't define
  const fld = folder as TFolder & { vault: unknown; parent: TFolder | null; isRoot: () => boolean };
  fld.vault = vault as unknown as Vault;
  fld.parent = null;
  fld.isRoot = () => normalizedPath === '/';
  return fld;
}

// ---------------------------------------------------------------------------
// TestVault
// ---------------------------------------------------------------------------

export class TestVault {
  /** Absolute path on the host filesystem. */
  private basePath: string;
  private vaultName: string;

  /** In-memory registries keyed by vault-relative path. */
  private files: Map<string, TFile> = new Map();
  private folders: Map<string, TFolder> = new Map();

  /** Root TFolder — always exists. */
  private root: TFolder;

  /** DataAdapter implementation (vault.adapter). */
  public adapter: DataAdapter;

  /** Config directory — Obsidian default. */
  public configDir = '.obsidian';

  constructor(basePath: string, vaultName = 'test-vault') {
    this.basePath = basePath;
    this.vaultName = vaultName;

    // Ensure base directory exists
    fs.mkdirSync(basePath, { recursive: true });

    // Create root folder
    this.root = makeTFolder(this, '/');
    this.folders.set('/', this.root);

    // Build adapter
    this.adapter = this.createAdapter();

    // Initial scan
    this.scanFilesystem();
  }

  // -------------------------------------------------------------------------
  // Vault.* high-level API
  // -------------------------------------------------------------------------

  getName(): string {
    return this.vaultName;
  }

  getRoot(): TFolder {
    return this.root;
  }

  getFileByPath(path: string): TFile | null {
    return this.files.get(path) ?? null;
  }

  getFolderByPath(path: string): TFolder | null {
    if (path === '' || path === '/') return this.root;
    return this.folders.get(path) ?? null;
  }

  getAbstractFileByPath(path: string): TAbstractFile | null {
    return (this.files.get(path) as TAbstractFile) ??
      (this.folders.get(path) as TAbstractFile) ??
      null;
  }

  getMarkdownFiles(): TFile[] {
    return Array.from(this.files.values()).filter(
      (f) => f.extension === 'md',
    );
  }

  getFiles(): TFile[] {
    return Array.from(this.files.values());
  }

  getAllLoadedFiles(): TAbstractFile[] {
    return [
      ...(Array.from(this.folders.values()) as unknown as TAbstractFile[]),
      ...(Array.from(this.files.values()) as unknown as TAbstractFile[]),
    ];
  }

  getAllFolders(includeRoot = true): TFolder[] {
    const result = Array.from(this.folders.values());
    if (!includeRoot) {
      return result.filter((f) => !f.isRoot());
    }
    return result;
  }

  async read(file: TFile): Promise<string> {
    const absPath = nodePath.join(this.basePath, file.path);
    return fs.readFileSync(absPath, 'utf-8');
  }

  async cachedRead(file: TFile): Promise<string> {
    return this.read(file);
  }

  async readBinary(file: TFile): Promise<ArrayBuffer> {
    const absPath = nodePath.join(this.basePath, file.path);
    const buf = fs.readFileSync(absPath);
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  }

  async create(path: string, data: string, _options?: DataWriteOptions): Promise<TFile> {
    const absPath = nodePath.join(this.basePath, path);
    const dir = nodePath.dirname(absPath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(absPath, data, 'utf-8');
    this.ensureParentFolders(path);
    const tFile = this.registerFile(path);
    return tFile;
  }

  async createBinary(path: string, data: ArrayBuffer, _options?: DataWriteOptions): Promise<TFile> {
    const absPath = nodePath.join(this.basePath, path);
    const dir = nodePath.dirname(absPath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(absPath, Buffer.from(data));
    this.ensureParentFolders(path);
    return this.registerFile(path);
  }

  async createFolder(path: string): Promise<TFolder> {
    const absPath = nodePath.join(this.basePath, path);
    fs.mkdirSync(absPath, { recursive: true });
    this.ensureParentFolders(path);
    return this.registerFolder(path);
  }

  async modify(file: TFile, data: string, _options?: DataWriteOptions): Promise<void> {
    const absPath = nodePath.join(this.basePath, file.path);
    fs.writeFileSync(absPath, data, 'utf-8');
    // Update stat
    const stat = fs.statSync(absPath);
    file.stat = { ctime: stat.ctimeMs, mtime: stat.mtimeMs, size: stat.size };
  }

  async modifyBinary(file: TFile, data: ArrayBuffer, _options?: DataWriteOptions): Promise<void> {
    const absPath = nodePath.join(this.basePath, file.path);
    fs.writeFileSync(absPath, Buffer.from(data));
    const stat = fs.statSync(absPath);
    file.stat = { ctime: stat.ctimeMs, mtime: stat.mtimeMs, size: stat.size };
  }

  async append(file: TFile, data: string, _options?: DataWriteOptions): Promise<void> {
    const absPath = nodePath.join(this.basePath, file.path);
    fs.appendFileSync(absPath, data, 'utf-8');
    const stat = fs.statSync(absPath);
    file.stat = { ctime: stat.ctimeMs, mtime: stat.mtimeMs, size: stat.size };
  }

  async process(file: TFile, fn: (data: string) => string, _options?: DataWriteOptions): Promise<string> {
    const content = await this.read(file);
    const newContent = fn(content);
    await this.modify(file, newContent);
    return newContent;
  }

  async delete(file: TAbstractFile, _force?: boolean): Promise<void> {
    const absPath = nodePath.join(this.basePath, file.path);
    if (this.files.has(file.path)) {
      fs.unlinkSync(absPath);
      this.unregisterFile(file.path);
    } else if (this.folders.has(file.path)) {
      fs.rmSync(absPath, { recursive: true, force: true });
      this.unregisterFolder(file.path);
    }
  }

  async trash(file: TAbstractFile, _system: boolean): Promise<void> {
    await this.delete(file);
  }

  async rename(file: TAbstractFile, newPath: string): Promise<void> {
    const oldAbs = nodePath.join(this.basePath, file.path);
    const newAbs = nodePath.join(this.basePath, newPath);
    const newDir = nodePath.dirname(newAbs);
    fs.mkdirSync(newDir, { recursive: true });
    fs.renameSync(oldAbs, newAbs);

    if (this.files.has(file.path)) {
      this.unregisterFile(file.path);
      this.ensureParentFolders(newPath);
      this.registerFile(newPath);
    } else if (this.folders.has(file.path)) {
      this.unregisterFolder(file.path);
      this.ensureParentFolders(newPath);
      this.registerFolder(newPath);
    }
  }

  async copy<T extends TAbstractFile>(file: T, newPath: string): Promise<T> {
    const oldAbs = nodePath.join(this.basePath, file.path);
    const newAbs = nodePath.join(this.basePath, newPath);
    const newDir = nodePath.dirname(newAbs);
    fs.mkdirSync(newDir, { recursive: true });
    fs.copyFileSync(oldAbs, newAbs);
    this.ensureParentFolders(newPath);
    const newFile = this.registerFile(newPath);
    return newFile as unknown as T;
  }

  getResourcePath(_file: TFile): string {
    return '';
  }

  // -------------------------------------------------------------------------
  // Event stubs (Vault extends Events)
  // -------------------------------------------------------------------------

  on(_name: string, _callback: (...args: unknown[]) => unknown): { id: string } {
    return { id: '' };
  }
  off(_name: string, _ref: { id: string }): void { /* noop */ }
  trigger(_name: string, ..._data: unknown[]): void { /* noop */ }
  tryTrigger(_name: string, ..._data: unknown[]): void { /* noop */ }
  offref(_ref: { id: string }): void { /* noop */ }

  // -------------------------------------------------------------------------
  // DataAdapter (vault.adapter)
  // -------------------------------------------------------------------------

  private createAdapter(): DataAdapter {
    const self = this;

    return {
      getName(): string {
        return self.vaultName;
      },

      async exists(normalizedPath: string): Promise<boolean> {
        const absPath = nodePath.join(self.basePath, normalizedPath);
        return fs.existsSync(absPath);
      },

      async stat(normalizedPath: string): Promise<Stat | null> {
        const absPath = nodePath.join(self.basePath, normalizedPath);
        if (!fs.existsSync(absPath)) return null;
        const fsStat = fs.statSync(absPath);
        return {
          type: fsStat.isDirectory() ? 'folder' : 'file',
          ctime: fsStat.ctimeMs,
          mtime: fsStat.mtimeMs,
          size: fsStat.size,
        };
      },

      async list(normalizedPath: string): Promise<ListedFiles> {
        const absPath = nodePath.join(self.basePath, normalizedPath);
        if (!fs.existsSync(absPath)) return { files: [], folders: [] };

        const entries = fs.readdirSync(absPath, { withFileTypes: true });
        const files: string[] = [];
        const folders: string[] = [];

        for (const entry of entries) {
          const entryPath = normalizedPath
            ? `${normalizedPath}/${entry.name}`
            : entry.name;
          if (entry.isDirectory()) {
            folders.push(entryPath);
          } else {
            files.push(entryPath);
          }
        }

        return { files, folders };
      },

      async read(normalizedPath: string): Promise<string> {
        const absPath = nodePath.join(self.basePath, normalizedPath);
        return fs.readFileSync(absPath, 'utf-8');
      },

      async readBinary(normalizedPath: string): Promise<ArrayBuffer> {
        const absPath = nodePath.join(self.basePath, normalizedPath);
        const buf = fs.readFileSync(absPath);
        return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
      },

      async write(normalizedPath: string, data: string, _options?: DataWriteOptions): Promise<void> {
        const absPath = nodePath.join(self.basePath, normalizedPath);
        const dir = nodePath.dirname(absPath);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(absPath, data, 'utf-8');
        // Sync registry
        self.ensureParentFolders(normalizedPath);
        self.registerFile(normalizedPath);
      },

      async writeBinary(normalizedPath: string, data: ArrayBuffer, _options?: DataWriteOptions): Promise<void> {
        const absPath = nodePath.join(self.basePath, normalizedPath);
        const dir = nodePath.dirname(absPath);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(absPath, Buffer.from(data));
        self.ensureParentFolders(normalizedPath);
        self.registerFile(normalizedPath);
      },

      async append(normalizedPath: string, data: string, _options?: DataWriteOptions): Promise<void> {
        const absPath = nodePath.join(self.basePath, normalizedPath);
        fs.appendFileSync(absPath, data, 'utf-8');
      },

      async process(normalizedPath: string, fn: (data: string) => string, _options?: DataWriteOptions): Promise<string> {
        const absPath = nodePath.join(self.basePath, normalizedPath);
        const content = fs.readFileSync(absPath, 'utf-8');
        const newContent = fn(content);
        fs.writeFileSync(absPath, newContent, 'utf-8');
        return newContent;
      },

      async mkdir(normalizedPath: string): Promise<void> {
        const absPath = nodePath.join(self.basePath, normalizedPath);
        fs.mkdirSync(absPath, { recursive: true });
        self.ensureParentFolders(normalizedPath);
        self.registerFolder(normalizedPath);
      },

      async trashSystem(_normalizedPath: string): Promise<boolean> {
        return false;
      },

      async trashLocal(_normalizedPath: string): Promise<void> {
        // noop
      },

      async remove(normalizedPath: string): Promise<void> {
        const absPath = nodePath.join(self.basePath, normalizedPath);
        if (fs.existsSync(absPath)) {
          const stat = fs.statSync(absPath);
          if (stat.isDirectory()) {
            fs.rmSync(absPath, { recursive: true, force: true });
            self.unregisterFolder(normalizedPath);
          } else {
            fs.unlinkSync(absPath);
            self.unregisterFile(normalizedPath);
          }
        }
      },

      async rename(normalizedPath: string, normalizedNewPath: string): Promise<void> {
        const oldAbs = nodePath.join(self.basePath, normalizedPath);
        const newAbs = nodePath.join(self.basePath, normalizedNewPath);
        const newDir = nodePath.dirname(newAbs);
        fs.mkdirSync(newDir, { recursive: true });
        fs.renameSync(oldAbs, newAbs);
      },

      async copy(normalizedPath: string, normalizedNewPath: string): Promise<void> {
        const oldAbs = nodePath.join(self.basePath, normalizedPath);
        const newAbs = nodePath.join(self.basePath, normalizedNewPath);
        const newDir = nodePath.dirname(newAbs);
        fs.mkdirSync(newDir, { recursive: true });
        fs.copyFileSync(oldAbs, newAbs);
      },
    } as unknown as DataAdapter;
  }

  // -------------------------------------------------------------------------
  // Internal registry management
  // -------------------------------------------------------------------------

  /**
   * Scan the basePath filesystem and populate the in-memory registry.
   */
  private scanFilesystem(): void {
    this.files.clear();
    this.folders.clear();
    this.folders.set('/', this.root);
    this.root.children = [];

    if (!fs.existsSync(this.basePath)) return;

    const walk = (dirRelative: string): void => {
      const dirAbs = nodePath.join(this.basePath, dirRelative);
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dirAbs, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        const entryRelative = dirRelative ? `${dirRelative}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          this.registerFolder(entryRelative);
          walk(entryRelative);
        } else {
          this.registerFile(entryRelative);
        }
      }
    };

    walk('');
    this.rebuildTree();
  }

  /** Register a file in the in-memory registry and return the TFile. */
  private registerFile(relativePath: string): TFile {
    const existing = this.files.get(relativePath);
    if (existing) {
      // Update stat
      const absPath = nodePath.join(this.basePath, relativePath);
      const stat = fs.statSync(absPath);
      existing.stat = { ctime: stat.ctimeMs, mtime: stat.mtimeMs, size: stat.size };
      this.rebuildTree();
      return existing;
    }

    const absPath = nodePath.join(this.basePath, relativePath);
    const stat = fs.statSync(absPath);
    const tFile = makeTFile(this, relativePath, stat.size, stat.mtimeMs, stat.ctimeMs);
    this.files.set(relativePath, tFile);
    this.rebuildTree();
    return tFile;
  }

  /** Register a folder in the in-memory registry and return the TFolder. */
  private registerFolder(relativePath: string): TFolder {
    if (this.folders.has(relativePath)) {
      this.rebuildTree();
      return this.folders.get(relativePath)!;
    }
    const tFolder = makeTFolder(this, relativePath);
    this.folders.set(relativePath, tFolder);
    this.rebuildTree();
    return tFolder;
  }

  /** Remove a file from the registry. */
  private unregisterFile(relativePath: string): void {
    this.files.delete(relativePath);
    this.rebuildTree();
  }

  /** Remove a folder and its descendants from the registry. */
  private unregisterFolder(relativePath: string): void {
    // Remove folder and all children
    const prefix = relativePath + '/';
    for (const key of Array.from(this.files.keys())) {
      if (key.startsWith(prefix)) this.files.delete(key);
    }
    for (const key of Array.from(this.folders.keys())) {
      if (key === relativePath || key.startsWith(prefix)) this.folders.delete(key);
    }
    this.rebuildTree();
  }

  /** Ensure all ancestor folders exist in the registry for a given path. */
  private ensureParentFolders(relativePath: string): void {
    const parts = relativePath.split('/');
    parts.pop(); // remove the filename/last segment
    let current = '';
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!this.folders.has(current)) {
        const tFolder = makeTFolder(this, current);
        this.folders.set(current, tFolder);
      }
    }
  }

  /** Rebuild parent-child relationships across all files and folders. */
  private rebuildTree(): void {
    // Reset children
    Array.from(this.folders.values()).forEach(folder => {
      (folder as { children: TAbstractFile[] }).children = [];
    });

    // Wire folders to parents
    Array.from(this.folders.entries()).forEach(([path, folder]) => {
      if (path === '/') return;
      const parentPath = this.getParentPath(path);
      const parent = this.folders.get(parentPath) ?? this.root;
      (folder as { parent: TFolder | null }).parent = parent;
      (parent as { children: TAbstractFile[] }).children.push(folder as unknown as TAbstractFile);
    });

    // Wire files to parents
    Array.from(this.files.entries()).forEach(([path, file]) => {
      const parentPath = this.getParentPath(path);
      const parent = this.folders.get(parentPath) ?? this.root;
      (file as { parent: TFolder | null }).parent = parent;
      (parent as { children: TAbstractFile[] }).children.push(file as unknown as TAbstractFile);
    });
  }

  /** Get the parent path for a given relative path. */
  private getParentPath(relativePath: string): string {
    const lastSlash = relativePath.lastIndexOf('/');
    if (lastSlash === -1) return '/';
    return relativePath.slice(0, lastSlash);
  }
}
