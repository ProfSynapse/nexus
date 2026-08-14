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

  /** Every `.base` file in the vault, optionally scoped to a folder. */
  static getBaseFiles(app: App, folder?: string, recursive = true): TFile[] {
    const baseFiles = app.vault.getFiles().filter(file => file.extension === BASE_EXTENSION);
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
