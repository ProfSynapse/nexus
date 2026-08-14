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
  /**
   * The owning plugin, so every subscription is also handed to
   * `registerEvent` and Obsidian removes it at unload no matter what happens
   * to this object. Belt and braces with `stop()`: `stop()` is only reached if
   * the service was registered and the cleanup path ran, and neither is
   * guaranteed when a reload lands mid-initialization.
   */
  plugin?: { registerEvent(ref: EventRef): void };
}

const DEFAULT_MAX_NOTES = 250_000;
const DEFAULT_DEBOUNCE_MS = 500;
const DEFAULT_BATCH_SIZE = 200;

export class NotesIndexBuilder {
  private readonly maxNotes: number;
  private readonly debounceMs: number;
  private readonly batchSize: number;

  /**
   * Subscriptions, tagged with the emitter that owns them. `offref` only
   * removes a ref from the emitter it was registered on, so the tag is not
   * bookkeeping — handing a metadataCache ref to `vault.offref` is a silent
   * no-op and the listener survives.
   */
  private eventRefs: Array<{ target: 'metadataCache' | 'vault'; ref: EventRef }> = [];
  private dirtyPaths = new Set<string>();
  private flushTimer: number | null = null;

  private ready = false;
  private degraded = false;
  /**
   * Set by `stop()`/`cleanup()`. Every write path checks it, because this
   * builder outlives nothing: at plugin unload the SQLite connection it writes
   * through is closed, and anything still walking or flushing afterwards hits
   * "Database not initialized".
   */
  private stopped = false;
  private readonly plugin?: { registerEvent(ref: EventRef): void };

  constructor(
    private readonly app: App,
    private readonly service: NotesIndexService,
    options: NotesIndexBuilderOptions = {}
  ) {
    this.plugin = options.plugin;
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

  /**
   * Boot variant for startup wiring: ensure the schema and subscribe to
   * freshness synchronously, but run the (potentially large) initial walk in
   * the background so it never blocks service initialization. Change events
   * that arrive mid-build are safe — upserts are idempotent.
   */
  async startInBackground(): Promise<void> {
    await this.service.ensureSchema();
    this.subscribe();
    // The walk runs unawaited, so its failure has to be reported here or it
    // becomes an unhandled rejection and the index is silently empty.
    void this.buildAll().catch((error) => {
      this.ready = false;
      console.error('[NotesIndex] background build failed; note queries will return nothing:', error);
    });
  }

  /**
   * Repopulate after "Nexus: Rebuild cache" threw the database away.
   *
   * That path closes the connection, deletes the cache blob and reopens from
   * SCHEMA_SQL, so the notes rows are gone — and nothing in the JSONL replay
   * restores them, because this index is derived from the vault, not from the
   * event store. `ensureSchema()` is re-issued (idempotent) so an older cache
   * that predates the v14 migration still lands somewhere writable, then the
   * vault walk repopulates. Failures are logged, not thrown: the caller is an
   * event handler.
   */
  async rebuildAfterCacheReset(): Promise<void> {
    if (this.stopped) {
      return;
    }
    try {
      await this.service.ensureSchema();
      await this.buildAll();
    } catch (error) {
      this.ready = false;
      console.error('[NotesIndex] rebuild after cache reset failed; note queries will return nothing:', error);
    }
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
      // The walk yields between batches, so a plugin unload can land in the
      // middle of it. Continuing would write through a closed connection.
      if (this.stopped) {
        return;
      }
      const input = this.noteFromFile(file);
      present.add(input.path);
      if (existing.get(input.path) !== input.contentHash) {
        await this.service.upsertNote(input);
      }
      if (++processed % this.batchSize === 0) {
        await yieldToEventLoop();
      }
    }

    if (this.stopped) {
      return;
    }
    await this.service.pruneMissing(present);
    this.ready = true;
  }

  /**
   * Tear down timers + event listeners, and refuse any further writes.
   *
   * MUST run at plugin unload. These subscriptions are raw `app.metadataCache.on`
   * / `app.vault.on` registrations, not `plugin.registerEvent`, so nothing
   * removes them on their own: a builder that is not stopped keeps receiving
   * every vault event for the rest of the Obsidian session and keeps writing
   * through a `SQLiteCacheManager` whose handle `close()` already nulled. Each
   * reload adds another one, so the "Database not initialized" burst grows with
   * the reload count and with how many files are being re-scanned.
   */
  stop(): void {
    this.stopped = true;
    if (this.flushTimer !== null) {
      window.clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    for (const { target, ref } of this.eventRefs) {
      if (!ref) continue;
      if (target === 'metadataCache') {
        this.app.metadataCache.offref(ref);
      } else {
        this.app.vault.offref(ref);
      }
    }
    this.eventRefs = [];
    this.dirtyPaths.clear();
    this.ready = false;
  }

  /**
   * `ServiceContainer.clear()` calls `cleanup()` on any service that has one —
   * that is the only teardown hook services get. `stop()` alone was never
   * reached because the container does not know the name.
   */
  cleanup(): void {
    this.stop();
  }

  // -- freshness -------------------------------------------------------------

  private subscribe(): void {
    this.track('metadataCache', this.app.metadataCache.on('changed', (file: TFile) => {
      this.markDirty(file.path);
    }));
    this.track('vault', this.app.vault.on('delete', (file: TAbstractFile) => {
      if (this.stopped || !isMarkdown(file)) return;
      this.dirtyPaths.delete(file.path);
      this.detached(this.service.deleteNote(file.path), `delete ${file.path}`);
    }));
    this.track('vault', this.app.vault.on('rename', (file: TAbstractFile, oldPath: string) => {
      if (this.stopped || !isMarkdown(file)) return;
      this.detached(this.service.deleteNote(oldPath), `rename ${oldPath}`);
      this.markDirty(file.path);
    }));
  }

  /** Record a subscription for `stop()`, and hand it to the plugin's own teardown. */
  private track(target: 'metadataCache' | 'vault', ref: EventRef): void {
    this.eventRefs.push({ target, ref });
    this.plugin?.registerEvent(ref);
  }

  /**
   * Absorb the rejection of a write nobody awaits. Obsidian event handlers are
   * sync, so an unhandled rejection here surfaces as a top-level error with a
   * storage stack and no hint of which subsystem raised it.
   */
  private detached(work: Promise<unknown>, what: string): void {
    void work.catch((error) => {
      console.warn(`[NotesIndex] ${what} did not reach the index:`, error);
    });
  }

  private markDirty(path: string): void {
    if (this.degraded || this.stopped) {
      return;
    }
    this.dirtyPaths.add(path);
    if (this.flushTimer === null) {
      this.flushTimer = window.setTimeout(() => void this.flush(), this.debounceMs);
    }
  }

  /**
   * Reconcile the dirty set: re-upsert existing notes, delete vanished ones.
   *
   * Never rejects. It is invoked from a `setTimeout`, so a rejection is an
   * unhandled one — and the realistic failure is the database closing under a
   * flush that was already scheduled, which is a shutdown detail and not
   * something to report as a plugin error.
   */
  private async flush(): Promise<void> {
    this.flushTimer = null;
    if (this.stopped) {
      this.dirtyPaths.clear();
      return;
    }
    const paths = Array.from(this.dirtyPaths);
    this.dirtyPaths.clear();

    try {
      for (const path of paths) {
        if (this.stopped) return;
        const file = this.app.vault.getAbstractFileByPath(path);
        if (file && isMarkdown(file)) {
          await this.service.upsertNote(this.noteFromFile(file));
        } else {
          await this.service.deleteNote(path);
        }
      }
    } catch (error) {
      console.warn('[NotesIndex] freshness flush aborted; those notes stay stale until the next change or rebuild:', error);
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
