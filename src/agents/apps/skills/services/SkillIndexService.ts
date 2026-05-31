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
   * Upsert each parsed skill folder into the index, then PRUNE index rows for
   * skills that no longer exist on disk. Loop-calls {@link upsertOne} so the
   * UPSERT SQL lives in exactly one place.
   *
   * Prune safety (deliberately conservative — the index is a rebuildable cache,
   * but `is_archived`/`last_loaded_at` are owned state we must not wipe on a
   * transient read failure):
   *   - An EMPTY scan prunes nothing. A transient unreadable mirror root makes
   *     `scan()` return `[]`; treating that as "delete everything" would wipe all
   *     owned state. Empty ⇒ untrusted ⇒ no reconciliation.
   *   - Pruning is SCOPED to providers actually present in this scan. A provider
   *     folder that failed to read mid-scan is simply absent from `parsed`; its
   *     rows are left intact rather than wrongly pruned.
   * Trade-off: deleting the LAST skill of a provider leaves one stale row until
   * that provider is scanned again with ≥1 skill. Acceptable — sync-back is
   * independently guarded against resurrecting a row whose mirror folder is gone.
   */
  async syncFromScan(parsed: ParsedSkillFolder[]): Promise<void> {
    for (const skill of parsed) {
      await this.upsertOne(skill);
    }

    if (parsed.length === 0) {
      return;
    }

    const scannedProviders = new Set(parsed.map((p) => p.provider));
    const present = new Set(parsed.map((p) => SkillIndexService.compositeKey(p.provider, p.name)));

    const rows = await this.sqlite.query<{ provider: string; name: string }>(
      'SELECT provider, name FROM skills',
      []
    );
    for (const row of rows) {
      if (!scannedProviders.has(row.provider)) {
        continue;
      }
      if (!present.has(SkillIndexService.compositeKey(row.provider, row.name))) {
        await this.hardDelete(row.provider, row.name);
      }
    }
  }

  /** Composite (provider, name) key for in-memory set membership. */
  private static compositeKey(provider: string, name: string): string {
    return JSON.stringify([provider, name]);
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
   * Find skills by name, optionally scoped to a provider. Recency-ordered
   * (most-recently-loaded first) with a `provider ASC` tiebreak so the result is
   * DETERMINISTIC when multiple providers share a name and have equal/NULL
   * last_loaded_at (used by loadSkill to pick a default on a bare ambiguous name).
   *
   * Excludes archived skills by default (the soft-delete contract — an archived
   * skill must not be loadable via a bare name). Pass `includeArchived: true`
   * for the update/archive resolution path, which legitimately targets archived
   * skills (e.g. restore).
   */
  async findByName(
    name: string,
    provider?: string,
    opts?: { includeArchived?: boolean }
  ): Promise<SkillRecord[]> {
    const where = ['name = ?'];
    const params: Array<string | number> = [name];
    if (provider) {
      where.push('provider = ?');
      params.push(provider);
    }
    if (!opts?.includeArchived) {
      where.push('is_archived = 0');
    }
    const sql =
      `SELECT * FROM skills WHERE ${where.join(' AND ')} ` +
      `ORDER BY last_loaded_at DESC, provider ASC`;
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
