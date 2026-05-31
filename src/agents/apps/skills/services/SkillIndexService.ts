/**
 * SkillIndexService — SQLite cache over the `skills` table.
 *
 * Located at: src/agents/apps/skills/services/SkillIndexService.ts
 * A pure SQLite index (no JSONL). The on-disk skill folder is the source of
 * truth; this table is a rebuildable derived cache that ALSO holds two pieces
 * of owned state — `is_archived` (CRUA soft-delete) and `last_loaded_at`
 * (recency ordering) — which a re-scan must PRESERVE, never overwrite.
 * See docs/plans/skills-protocol-integration-plan.md §4 / §12.
 */

import { v4 as uuidv4 } from '../../../../utils/uuid';
import type { SQLiteCacheManager } from '../../../../database/storage/SQLiteCacheManager';
import type { ParsedSkillFolder, SkillRecord } from '../types';

/** A row in the `skills` SQLite table (snake_case columns). */
interface SkillRow {
  id: string;
  provider: string;
  name: string;
  description: string | null;
  vault_path: string;
  origin_path: string | null;
  content_hash: string;
  is_archived: number;
  last_loaded_at: number | null;
  created: number;
  updated: number;
}

export class SkillIndexService {
  constructor(private sqlite: SQLiteCacheManager) {}

  /** The owned-state-preserving UPSERT statement shared by upsertOne/syncFromScan. */
  private static readonly UPSERT_SQL =
    `INSERT INTO skills (id, provider, name, description, vault_path, origin_path, content_hash, is_archived, last_loaded_at, created, updated) ` +
    `VALUES (?,?,?,?,?,?,?,0,NULL,?,?) ` +
    `ON CONFLICT(provider, name) DO UPDATE SET ` +
    `description=excluded.description, vault_path=excluded.vault_path, ` +
    `origin_path=excluded.origin_path, content_hash=excluded.content_hash, ` +
    `updated=excluded.updated`;

  /**
   * Upsert a single parsed skill folder into the index. On conflict
   * (provider,name) the derived columns are refreshed but the owned state
   * (`is_archived`, `last_loaded_at`) is deliberately left out of the SET clause
   * so neither a re-scan NOR a CRUA write clobbers it.
   */
  async upsertOne(parsed: ParsedSkillFolder): Promise<void> {
    const now = Date.now();
    await this.sqlite.run(SkillIndexService.UPSERT_SQL, [
      uuidv4(),
      parsed.provider,
      parsed.name,
      parsed.description,
      parsed.vaultPath,
      parsed.originPath ?? null,
      parsed.contentHash,
      now,
      now,
    ]);
  }

  /**
   * Upsert each parsed skill folder into the index. Loop-calls {@link upsertOne}
   * so the UPSERT SQL lives in exactly one place.
   */
  async syncFromScan(parsed: ParsedSkillFolder[]): Promise<void> {
    for (const skill of parsed) {
      await this.upsertOne(skill);
    }

    // TODO(phase): prune stale rows — skills present in the index but no longer
    // on disk are left in place for now (no destructive prune in the discovery
    // phase). A later sync phase reconciles deletions.
  }

  /** Fetch a single skill by its composite key, or null when not present. */
  async getOne(provider: string, name: string): Promise<SkillRecord | null> {
    const row = await this.sqlite.queryOne<SkillRow>(
      'SELECT * FROM skills WHERE provider = ? AND name = ?',
      [provider, name]
    );
    return row ? this.rowToRecord(row) : null;
  }

  /**
   * Set (or, with `archived: false`, clear) the soft-delete flag for a skill,
   * then return the refreshed record. Returns null when no such skill exists.
   */
  async setArchived(provider: string, name: string, archived: boolean): Promise<SkillRecord | null> {
    const now = Date.now();
    await this.sqlite.run(
      'UPDATE skills SET is_archived = ?, updated = ? WHERE provider = ? AND name = ?',
      [archived ? 1 : 0, now, provider, name]
    );
    return this.getOne(provider, name);
  }

  /**
   * Rename a skill row in place (used by updateSkill --rename). Updates the
   * name + vault_path on the existing (provider, oldName) row. The follow-up
   * {@link upsertOne} refreshes hash/description on the renamed row.
   */
  async renameRow(
    provider: string,
    oldName: string,
    newName: string,
    newVaultPath: string
  ): Promise<void> {
    const now = Date.now();
    await this.sqlite.run(
      'UPDATE skills SET name = ?, vault_path = ?, updated = ? WHERE provider = ? AND name = ?',
      [newName, newVaultPath, now, provider, oldName]
    );
  }

  /**
   * List skills, recency-ordered (most-recently-loaded first). Never-loaded
   * skills (NULL last_loaded_at) sink to the bottom because SQLite sorts NULL
   * last in DESC. Excludes archived skills unless `includeArchived` is true.
   */
  async list(opts?: { search?: string; includeArchived?: boolean }): Promise<SkillRecord[]> {
    const where: string[] = [];
    const params: Array<string | number> = [];

    if (!opts?.includeArchived) {
      where.push('is_archived = 0');
    }
    if (opts?.search) {
      where.push('(name LIKE ? OR description LIKE ?)');
      const term = `%${opts.search}%`;
      params.push(term, term);
    }

    const whereClause = where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '';
    const sql = `SELECT * FROM skills${whereClause} ORDER BY last_loaded_at DESC, name ASC`;
    const rows = await this.sqlite.query<SkillRow>(sql, params);
    return rows.map((row) => this.rowToRecord(row));
  }

  /**
   * Find skills by name, optionally scoped to a provider. Recency-ordered so
   * the most-recently-loaded match is first (used by loadSkill to pick a
   * default when a bare name is ambiguous across providers).
   */
  async findByName(name: string, provider?: string): Promise<SkillRecord[]> {
    const where = ['name = ?'];
    const params: Array<string | number> = [name];
    if (provider) {
      where.push('provider = ?');
      params.push(provider);
    }
    const sql = `SELECT * FROM skills WHERE ${where.join(' AND ')} ORDER BY last_loaded_at DESC`;
    const rows = await this.sqlite.query<SkillRow>(sql, params);
    return rows.map((row) => this.rowToRecord(row));
  }

  /**
   * Permanently remove a skill row from the index by its composite key. Used
   * by the settings-UI hard-delete (humans can destroy; the model only gets the
   * reversible `is_archived` soft-delete). The on-disk folder is removed
   * separately by the caller via SkillWriteService.removeTree.
   */
  async hardDelete(provider: string, name: string): Promise<void> {
    await this.sqlite.run('DELETE FROM skills WHERE provider = ? AND name = ?', [provider, name]);
  }

  /**
   * Stamp a skill as just-loaded — drives recency ordering in list().
   */
  async touchLoaded(id: string): Promise<void> {
    const now = Date.now();
    await this.sqlite.run('UPDATE skills SET last_loaded_at = ?, updated = ? WHERE id = ?', [now, now, id]);
  }

  /** Map a snake_case row to the camelCase SkillRecord shape. */
  private rowToRecord(row: SkillRow): SkillRecord {
    return {
      id: row.id,
      provider: row.provider,
      name: row.name,
      description: row.description ?? '',
      vaultPath: row.vault_path,
      originPath: row.origin_path ?? undefined,
      contentHash: row.content_hash,
      isArchived: row.is_archived === 1,
      lastLoadedAt: row.last_loaded_at ?? undefined,
      created: row.created,
      updated: row.updated,
    };
  }
}
