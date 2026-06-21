/**
 * NotesIndexService — SQLite CRUD over the `notes` + `note_properties` tables.
 *
 * Located at: src/database/services/notesIndex/NotesIndexService.ts
 * The vault is the source of truth; these two tables are a rebuildable, derived,
 * IN-MEMORY index (created via `ensureSchema()` at startup, NOT a persisted
 * v-schema migration — see docs/plans/notes-query-index-plan.md §5 / §6). EAV
 * (`note_properties`) gives indexed lookup for arbitrary frontmatter keys;
 * `notes.frontmatter_json` is kept for cheap projection via `json_extract`.
 *
 * This service is storage-only (mirrors SkillIndexService): it issues SQL and
 * knows nothing about Obsidian. The vault walk + freshness live in
 * NotesIndexBuilder.
 */

import type { SQLiteCacheManager } from '../../storage/SQLiteCacheManager';
import { coerceFrontmatterValue } from './notesIndexMapping';

/** Everything the builder extracts from one note for indexing. */
export interface NoteIndexInput {
  path: string;
  basename: string;
  folder: string;
  ext: string;
  title: string | null;
  ctime: number;
  mtime: number;
  size: number;
  tags: string[];
  links: string[];
  frontmatter: Record<string, unknown>;
  contentHash: string;
}

/** DDL for the in-memory index. Idempotent; run on every startup. */
export const NOTES_INDEX_DDL = `
CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  basename TEXT NOT NULL,
  folder TEXT NOT NULL,
  ext TEXT NOT NULL,
  title TEXT,
  ctime INTEGER NOT NULL,
  mtime INTEGER NOT NULL,
  size INTEGER NOT NULL,
  tags_json TEXT,
  links_json TEXT,
  frontmatter_json TEXT,
  content_hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notes_folder ON notes(folder);
CREATE INDEX IF NOT EXISTS idx_notes_mtime ON notes(mtime);
CREATE TABLE IF NOT EXISTS note_properties (
  note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  key_raw TEXT NOT NULL,
  value_text TEXT,
  value_num REAL,
  value_type TEXT NOT NULL,
  position INTEGER
);
CREATE INDEX IF NOT EXISTS idx_np_key_text ON note_properties(key, value_text);
CREATE INDEX IF NOT EXISTS idx_np_key_num ON note_properties(key, value_num);
CREATE INDEX IF NOT EXISTS idx_np_note ON note_properties(note_id);
`;

const UPSERT_NOTE_SQL =
  `INSERT INTO notes (path, basename, folder, ext, title, ctime, mtime, size, tags_json, links_json, frontmatter_json, content_hash) ` +
  `VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ` +
  `ON CONFLICT(path) DO UPDATE SET ` +
  `basename=excluded.basename, folder=excluded.folder, ext=excluded.ext, title=excluded.title, ` +
  `ctime=excluded.ctime, mtime=excluded.mtime, size=excluded.size, tags_json=excluded.tags_json, ` +
  `links_json=excluded.links_json, frontmatter_json=excluded.frontmatter_json, content_hash=excluded.content_hash`;

export class NotesIndexService {
  constructor(private readonly sqlite: SQLiteCacheManager) {}

  /** Create the index tables + indexes if absent. Idempotent. */
  async ensureSchema(): Promise<void> {
    await this.sqlite.exec(NOTES_INDEX_DDL);
  }

  /** path → content_hash for every indexed note (drives skip-unchanged on re-scan). */
  async getExistingHashes(): Promise<Map<string, string>> {
    const rows = await this.sqlite.query<{ path: string; content_hash: string }>(
      'SELECT path, content_hash FROM notes',
      []
    );
    return new Map(rows.map((r) => [r.path, r.content_hash]));
  }

  /** Number of indexed notes. */
  async count(): Promise<number> {
    const row = await this.sqlite.queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM notes', []);
    return row?.n ?? 0;
  }

  /**
   * Upsert one note and fully replace its property rows. The frontmatter EAV is
   * delete-then-insert (simplest correct reconciliation — a property removed
   * from the note must vanish from the index).
   */
  async upsertNote(input: NoteIndexInput): Promise<void> {
    await this.sqlite.run(UPSERT_NOTE_SQL, [
      input.path,
      input.basename,
      input.folder,
      input.ext,
      input.title,
      input.ctime,
      input.mtime,
      input.size,
      JSON.stringify(input.tags ?? []),
      JSON.stringify(input.links ?? []),
      JSON.stringify(input.frontmatter ?? {}),
      input.contentHash,
    ]);

    const noteId = await this.noteId(input.path);
    if (noteId === null) {
      return;
    }

    await this.sqlite.run('DELETE FROM note_properties WHERE note_id = ?', [noteId]);

    for (const [keyRaw, value] of Object.entries(input.frontmatter ?? {})) {
      for (const r of coerceFrontmatterValue(keyRaw, value)) {
        await this.sqlite.run(
          `INSERT INTO note_properties (note_id, key, key_raw, value_text, value_num, value_type, position) VALUES (?,?,?,?,?,?,?)`,
          [noteId, r.key, r.keyRaw, r.valueText, r.valueNum, r.valueType, r.position]
        );
      }
    }
  }

  /** Remove a note and its property rows by path. No-op if absent. */
  async deleteNote(path: string): Promise<void> {
    const noteId = await this.noteId(path);
    if (noteId === null) {
      return;
    }
    await this.sqlite.run('DELETE FROM note_properties WHERE note_id = ?', [noteId]);
    await this.sqlite.run('DELETE FROM notes WHERE id = ?', [noteId]);
  }

  /** Rename = delete the old path then upsert the new one (paths are the identity). */
  async renameNote(oldPath: string, input: NoteIndexInput): Promise<void> {
    await this.deleteNote(oldPath);
    await this.upsertNote(input);
  }

  /**
   * Drop index rows for notes whose path is no longer present in the vault.
   * Conservative, mirroring SkillIndexService: an EMPTY `presentPaths` prunes
   * NOTHING (a failed/empty walk must not wipe the whole index).
   */
  async pruneMissing(presentPaths: Set<string>): Promise<void> {
    if (presentPaths.size === 0) {
      return;
    }
    const rows = await this.sqlite.query<{ path: string }>('SELECT path FROM notes', []);
    for (const { path } of rows) {
      if (!presentPaths.has(path)) {
        await this.deleteNote(path);
      }
    }
  }

  /** Resolve a note's surrogate id by path, or null when not indexed. */
  private async noteId(path: string): Promise<number | null> {
    const row = await this.sqlite.queryOne<{ id: number }>('SELECT id FROM notes WHERE path = ?', [path]);
    return row?.id ?? null;
  }
}
