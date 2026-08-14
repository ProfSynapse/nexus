/**
 * BaseFileOperations — reading, writing and listing `.base` files.
 *
 * A `.base` is a plain vault file holding YAML, so this is ordinary file work:
 * no persistence layer, no storage root, nothing to migrate. The only two
 * non-obvious constraints:
 *
 *   1. YAML goes through Obsidian's `parseYaml`/`stringifyYaml`. The `yaml` npm
 *      package is desktop-only (CLAUDE.md), and serialising by string template
 *      is how bases get broken — quoting is the single largest source of
 *      invalid `.base` files and the serialiser handles it for free.
 *   2. Every caller-supplied WRITE path goes through `tryResolveVaultPath`.
 *      `normalizePath` does not strip `..`; this does. Same boundary
 *      `CanvasOperations` uses.
 */

import { App, TFile, TFolder, parseYaml, stringifyYaml } from 'obsidian';
import { tryResolveVaultPath } from '../../../core/vaultPath';
import type { BaseFileSummary, BasesConfigFile } from '../types';

export const BASE_EXTENSION = 'base';

/**
 * Prefix on every scratch `.base` written by `analyze`. Two jobs: a leaked one
 * is identifiable and sweepable, and `base list` can hide them so a caller
 * never sees a file that exists for ~90 ms.
 */
export const SCRATCH_PREFIX = '__nexus-analyze-';

export class BaseFileOperations {
  /** Ensure the `.base` extension. */
  static normalizePath(path: string): string {
    return path.endsWith(`.${BASE_EXTENSION}`) ? path : `${path}.${BASE_EXTENSION}`;
  }

  /**
   * Confine a caller-supplied path to the vault and append `.base`. Throws on
   * a traversal/absolute/home-expansion path so a `..` can never reach
   * `vault.create`/`vault.modify`.
   */
  private static resolveWritePath(path: string): string {
    const result = tryResolveVaultPath(path);
    if (!result.ok) {
      throw new Error(result.error);
    }
    return this.normalizePath(result.path);
  }

  /** Locate an existing `.base` file, or throw with the tool that lists them. */
  static getFile(app: App, path: string): TFile {
    const normalizedPath = this.normalizePath(path);
    const file = app.vault.getAbstractFileByPath(normalizedPath);
    if (!file || !(file instanceof TFile)) {
      throw new Error(`Base not found: ${normalizedPath}. Use baseManager.list to find bases.`);
    }
    return file;
  }

  /** Raw file contents. */
  static async readSource(app: App, path: string): Promise<string> {
    return app.vault.read(this.getFile(app, path));
  }

  /**
   * Parse a config supplied as a YAML/JSON string or as an already-structured
   * object. JSON is a subset of YAML so one parser covers both; `JSON.parse` is
   * a fallback for the tab-indented JSON that YAML rejects.
   */
  static parseConfigInput(input: unknown, label: string): unknown {
    if (input === undefined || input === null) return undefined;
    if (typeof input !== 'string') return input;

    const trimmed = input.trim();
    if (trimmed === '') return undefined;

    try {
      return parseYaml(trimmed);
    } catch (yamlError) {
      try {
        return JSON.parse(trimmed);
      } catch {
        const message = yamlError instanceof Error ? yamlError.message : String(yamlError);
        throw new Error(`${label} is not valid YAML or JSON: ${message}`);
      }
    }
  }

  /** Serialise a config back to `.base` file contents. */
  static serialize(config: BasesConfigFile): string {
    return stringifyYaml(config);
  }

  /** Create a NEW base file (fails if it exists). */
  static async writeBase(app: App, path: string, config: BasesConfigFile): Promise<string> {
    const normalizedPath = this.resolveWritePath(path);
    const existing = app.vault.getAbstractFileByPath(normalizedPath);
    if (existing instanceof TFile) {
      throw new Error(`Base already exists: ${normalizedPath}. Use baseManager.update to modify it.`);
    }

    const folderPath = normalizedPath.substring(0, normalizedPath.lastIndexOf('/'));
    if (folderPath) {
      await this.ensureFolder(app, folderPath);
    }

    await app.vault.create(normalizedPath, this.serialize(config));
    return normalizedPath;
  }

  /** Overwrite an EXISTING base file (fails if absent). */
  static async updateBase(app: App, path: string, config: BasesConfigFile): Promise<string> {
    const normalizedPath = this.resolveWritePath(path);
    const file = app.vault.getAbstractFileByPath(normalizedPath);
    if (!file || !(file instanceof TFile)) {
      throw new Error(`Base not found: ${normalizedPath}. Use baseManager.write to create it.`);
    }

    await app.vault.modify(file, this.serialize(config));
    return normalizedPath;
  }

  static async ensureFolder(app: App, path: string): Promise<void> {
    const existing = app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFolder) return;

    const parts = path.split('/');
    let currentPath = '';
    for (const part of parts) {
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      if (!app.vault.getAbstractFileByPath(currentPath)) {
        await app.vault.createFolder(currentPath);
      }
    }
  }

  /**
   * Create the transient `.base` that `analyze` renders.
   *
   * Separate from {@link writeBase} on purpose: this path is code-controlled
   * (the caller builds the name), must overwrite nothing, and must not carry
   * `writeBase`'s "use update instead" advice into an internal failure.
   */
  static async createScratchFile(app: App, path: string, contents: string): Promise<TFile> {
    if (!this.isScratchPath(path)) {
      throw new Error(`Refusing to create a scratch base at ${path}: name must start with ${SCRATCH_PREFIX}`);
    }
    return app.vault.create(path, contents);
  }

  /**
   * Delete a scratch file permanently.
   *
   * Deliberately NOT `fileManager.trashFile()`, which is right for user data and
   * wrong here: a scratch file lived for ~90 ms and was never the user's, so
   * trashing it would drop a fresh file into their trash on every single
   * `analyze` call. The adapter is used rather than `vault.delete` because the
   * plugin guidelines forbid the latter outright, and this is the one deletion
   * in the plugin with no user-visible file behind it. Best-effort by design:
   * cleanup must never be the reason a query fails.
   */
  static async removeScratchFile(app: App, path: string): Promise<boolean> {
    if (!this.isScratchPath(path)) {
      throw new Error(`Refusing to remove ${path}: not a scratch base`);
    }

    try {
      if (await app.vault.adapter.exists(path)) {
        await app.vault.adapter.remove(path);
        return true;
      }
    } catch {
      // A scratch file we cannot remove is swept by the next call.
      return false;
    }

    return false;
  }

  /** True for a path whose file name marks it as an `analyze` scratch file. */
  static isScratchPath(path: string): boolean {
    const name = path.slice(path.lastIndexOf('/') + 1);
    return name.startsWith(SCRATCH_PREFIX) && name.endsWith(`.${BASE_EXTENSION}`);
  }

  /**
   * Every `.base` file in the vault, optionally scoped to a folder.
   *
   * Scratch files are excluded unless asked for: they are an implementation
   * detail of `analyze`, and a `base list` that raced one would otherwise
   * report a file that no longer exists by the time anyone reads the result.
   */
  static getBaseFiles(app: App, folder?: string, recursive = true, includeScratch = false): TFile[] {
    const baseFiles = app.vault
      .getFiles()
      .filter(file => file.extension === BASE_EXTENSION && (includeScratch || !this.isScratchPath(file.path)));
    if (!folder) return baseFiles;

    const normalizedFolder = folder.replace(/^\/+|\/+$/g, '');
    return baseFiles.filter(file =>
      recursive
        ? file.path.startsWith(`${normalizedFolder}/`) || file.parent?.path === normalizedFolder
        : file.parent?.path === normalizedFolder
    );
  }

  /** View/formula counts for `base list`; an unparseable file reports its error. */
  static async summarize(app: App, file: TFile): Promise<BaseFileSummary> {
    const summary: BaseFileSummary = {
      path: file.path,
      name: file.basename,
      modified: file.stat.mtime,
      views: 0,
      formulas: 0,
      hasGlobalFilters: false
    };

    try {
      const parsed: unknown = parseYaml(await app.vault.read(file));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const config = parsed as Record<string, unknown>;
        summary.views = Array.isArray(config.views) ? config.views.length : 0;
        summary.formulas =
          config.formulas && typeof config.formulas === 'object' && !Array.isArray(config.formulas)
            ? Object.keys(config.formulas).length
            : 0;
        summary.hasGlobalFilters = config.filters !== undefined && config.filters !== null;
      }
    } catch (error) {
      summary.error = error instanceof Error ? error.message : String(error);
    }

    return summary;
  }

  /**
   * Frontmatter property names in use anywhere in the vault, for the
   * `unused-property` warning. Read straight off the in-memory metadata cache —
   * no file IO — and best-effort: a metadata cache that is still warming
   * simply yields fewer names, which can only suppress warnings, never
   * manufacture one.
   */
  static collectFrontmatterProperties(app: App): Set<string> {
    const properties = new Set<string>();
    for (const file of app.vault.getMarkdownFiles()) {
      const frontmatter = app.metadataCache.getFileCache(file)?.frontmatter;
      if (!frontmatter) continue;
      for (const key of Object.keys(frontmatter)) {
        properties.add(key);
      }
    }
    return properties;
  }
}
