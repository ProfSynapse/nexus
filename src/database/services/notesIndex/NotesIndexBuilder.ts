/**
 * NotesIndexBuilder — walks the vault into the notes index and keeps it fresh.
 *
 * Located at: src/database/services/notesIndex/NotesIndexBuilder.ts
 * The Obsidian-coupled half of the notes query index (the SQL half is
 * NotesIndexService). On start it ensures the schema, builds the index in the
 * background (hash-gated, batched), then subscribes to `metadataCache`/vault
 * events to stay current — the same freshness model the live VaultFileIndex
 * already uses. See docs/plans/notes-query-index-plan.md §6.
 *
 * Graceful degrade: above `maxNotes` the build is SKIPPED (tables stay empty,
 * queries simply return nothing) rather than risk the in-memory ceiling.
 */

import { TFile } from 'obsidian';
import type { App, EventRef, TAbstractFile } from 'obsidian';
import { NotesIndexService, type NoteIndexInput } from './NotesIndexService';
import { computeContentHash } from './notesIndexMapping';

export interface NotesIndexBuilderOptions {
  /** Skip indexing entirely above this note count (graceful degrade). */
  maxNotes?: number;
  /** Debounce window (ms) for coalescing metadata-change bursts. */
  debounceMs?: number;
  /** Notes processed between cooperative yields during the full build. */
  batchSize?: number;
}

const DEFAULT_MAX_NOTES = 250_000;
const DEFAULT_DEBOUNCE_MS = 500;
const DEFAULT_BATCH_SIZE = 200;

export class NotesIndexBuilder {
  private readonly maxNotes: number;
  private readonly debounceMs: number;
  private readonly batchSize: number;

  private eventRefs: EventRef[] = [];
  private dirtyPaths = new Set<string>();
  private flushTimer: number | null = null;

  private ready = false;
  private degraded = false;

  constructor(
    private readonly app: App,
    private readonly service: NotesIndexService,
    options: NotesIndexBuilderOptions = {}
  ) {
    this.maxNotes = options.maxNotes ?? DEFAULT_MAX_NOTES;
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  }

  isReady(): boolean {
    return this.ready;
  }

  isDegraded(): boolean {
    return this.degraded;
  }

  /** Ensure schema, build in the background, then wire freshness. */
  async start(): Promise<void> {
    await this.service.ensureSchema();
    await this.buildAll();
    this.subscribe();
  }

  /** Full (re)build: hash-gated upsert of every markdown note, then prune. */
  async buildAll(): Promise<void> {
    const files = this.app.vault.getMarkdownFiles();

    if (files.length > this.maxNotes) {
      this.degraded = true;
      this.ready = false;
      console.warn(
        `[NotesIndex] ${files.length} notes exceeds maxNotes=${this.maxNotes}; skipping index build (queries will return no notes).`
      );
      return;
    }
    this.degraded = false;

    const existing = await this.service.getExistingHashes();
    const present = new Set<string>();

    let processed = 0;
    for (const file of files) {
      const input = this.noteFromFile(file);
      present.add(input.path);
      if (existing.get(input.path) !== input.contentHash) {
        await this.service.upsertNote(input);
      }
      if (++processed % this.batchSize === 0) {
        await yieldToEventLoop();
      }
    }

    await this.service.pruneMissing(present);
    this.ready = true;
  }

  /** Tear down timers + event listeners. */
  stop(): void {
    if (this.flushTimer !== null) {
      window.clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    for (const ref of this.eventRefs) {
      if (ref) {
        this.app.metadataCache.offref(ref);
        this.app.vault.offref(ref);
      }
    }
    this.eventRefs = [];
    this.dirtyPaths.clear();
  }

  // -- freshness -------------------------------------------------------------

  private subscribe(): void {
    this.eventRefs.push(
      this.app.metadataCache.on('changed', (file: TFile) => {
        this.markDirty(file.path);
      })
    );
    this.eventRefs.push(
      this.app.vault.on('delete', (file: TAbstractFile) => {
        if (isMarkdown(file)) {
          this.dirtyPaths.delete(file.path);
          void this.service.deleteNote(file.path);
        }
      })
    );
    this.eventRefs.push(
      this.app.vault.on('rename', (file: TAbstractFile, oldPath: string) => {
        if (isMarkdown(file)) {
          void this.service.deleteNote(oldPath);
          this.markDirty(file.path);
        }
      })
    );
  }

  private markDirty(path: string): void {
    if (this.degraded) {
      return;
    }
    this.dirtyPaths.add(path);
    if (this.flushTimer === null) {
      this.flushTimer = window.setTimeout(() => void this.flush(), this.debounceMs);
    }
  }

  /** Reconcile the dirty set: re-upsert existing notes, delete vanished ones. */
  private async flush(): Promise<void> {
    this.flushTimer = null;
    const paths = Array.from(this.dirtyPaths);
    this.dirtyPaths.clear();

    for (const path of paths) {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (file && isMarkdown(file)) {
        await this.service.upsertNote(this.noteFromFile(file));
      } else {
        await this.service.deleteNote(path);
      }
    }
  }

  // -- mapping ---------------------------------------------------------------

  /** Extract the indexable surface of a note from the metadata cache. */
  private noteFromFile(file: TFile): NoteIndexInput {
    const cache = this.app.metadataCache.getFileCache(file);
    const rawFm = (cache?.frontmatter ?? {}) as Record<string, unknown>;
    const frontmatter: Record<string, unknown> = { ...rawFm };
    // `position` is the metadata cache's internal source-range marker, not data.
    delete frontmatter.position;

    const tags = mergeTags(cache?.tags, frontmatter.tags);
    const links = Array.isArray(cache?.links)
      ? (cache?.links as Array<{ link?: string }>).map((l) => l.link).filter((l): l is string => typeof l === 'string')
      : [];
    const title = typeof frontmatter.title === 'string' ? frontmatter.title : file.basename;

    return {
      path: file.path,
      basename: file.basename,
      folder: file.parent?.path || '/',
      ext: file.extension,
      title,
      ctime: file.stat.ctime,
      mtime: file.stat.mtime,
      size: file.stat.size,
      tags,
      links,
      frontmatter,
      contentHash: computeContentHash(frontmatter, file.stat.mtime, file.stat.size),
    };
  }
}

/** True for markdown TFiles (guards delete/rename events that also fire for folders). */
function isMarkdown(file: TAbstractFile): file is TFile {
  return file instanceof TFile && file.extension === 'md';
}

/** Merge inline (`cache.tags`) + frontmatter tags, strip leading `#`, dedupe. */
function mergeTags(cacheTags: Array<{ tag: string }> | undefined, fmTags: unknown): string[] {
  const out = new Set<string>();
  for (const t of cacheTags ?? []) {
    if (typeof t?.tag === 'string') {
      out.add(t.tag.replace(/^#/, ''));
    }
  }
  const fm = Array.isArray(fmTags) ? fmTags : typeof fmTags === 'string' ? [fmTags] : [];
  for (const t of fm) {
    if (typeof t === 'string') {
      out.add(t.replace(/^#/, ''));
    }
  }
  return Array.from(out);
}

/** Cooperative yield so a large build doesn't monopolize the main thread. */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, 0));
}
