import {
  CURRENT_SCHEMA_VERSION,
  MIGRATIONS,
  SchemaMigrator,
  type MigratableDatabase
} from '../../src/database/schema/SchemaMigrator';

interface ExecCall {
  sql: string;
  values: unknown[][];
}

interface RunCall {
  sql: string;
  params: unknown[] | undefined;
}

class FakeDatabase implements MigratableDatabase {
  readonly execCalls: ExecCall[] = [];
  readonly runCalls: RunCall[] = [];

  /** Map of normalized SQL prefix -> rows to return from exec(). */
  readonly execResponders: Array<{ match: RegExp; rows: unknown[][] }> = [];

  exec(sql: string): { values: unknown[][] }[] {
    const responder = this.execResponders.find(r => r.match.test(sql));
    const values = responder ? responder.rows : [];
    this.execCalls.push({ sql, values });
    return values.length > 0 ? [{ values }] : [{ values: [] }];
  }

  run(sql: string, params?: unknown[]): void {
    this.runCalls.push({ sql, params });
  }
}

describe('SchemaMigrator v11 -> v12 shard_cursors migration', () => {
  it('declares CURRENT_SCHEMA_VERSION as 13', () => {
    expect(CURRENT_SCHEMA_VERSION).toBe(13);
  });

  it('includes a v12 migration with the shard_cursors DDL', () => {
    const v12 = MIGRATIONS.find(m => m.version === 12);
    expect(v12).toBeDefined();
    expect(v12!.description.toLowerCase()).toContain('shard_cursors');

    const joined = v12!.sql.join('\n');
    expect(joined).toContain('CREATE TABLE IF NOT EXISTS shard_cursors');
    expect(joined).toContain('PRIMARY KEY (deviceId, shardPath)');
    expect(joined).toContain('CREATE INDEX IF NOT EXISTS idx_shard_cursors_path');
    expect(joined).toContain('CREATE INDEX IF NOT EXISTS idx_shard_cursors_kind');
  });

  it('uses additive-only DDL for v12 (no DROP / no RENAME / IF NOT EXISTS)', () => {
    const v12 = MIGRATIONS.find(m => m.version === 12)!;
    for (const sql of v12.sql) {
      const upper = sql.toUpperCase();
      expect(upper).not.toContain('DROP TABLE');
      expect(upper).not.toContain('DROP INDEX');
      expect(upper).not.toContain('ALTER TABLE');
      expect(upper).not.toContain('RENAME');
      expect(upper).toContain('IF NOT EXISTS');
    }
  });

  it('runs the v12 + v13 migrations when starting at v11', async () => {
    const db = new FakeDatabase();

    // Pretend schema_version table exists and currently reports v11.
    db.execResponders.push(
      { match: /sqlite_master.*schema_version/i, rows: [['schema_version']] },
      { match: /MAX\(version\)/i, rows: [[11]] }
    );

    const migrator = new SchemaMigrator(db);
    const result = await migrator.migrate();

    expect(result.fromVersion).toBe(11);
    expect(result.toVersion).toBe(13);
    expect(result.applied).toBe(2);

    const ddlRun = db.runCalls.map(c => c.sql).filter(s => /shard_cursors/.test(s));
    expect(ddlRun.some(s => /CREATE TABLE IF NOT EXISTS shard_cursors/.test(s))).toBe(true);
    expect(ddlRun.some(s => /CREATE INDEX IF NOT EXISTS idx_shard_cursors_path/.test(s))).toBe(true);
    expect(ddlRun.some(s => /CREATE INDEX IF NOT EXISTS idx_shard_cursors_kind/.test(s))).toBe(true);

    // Each applied version is stamped (setVersion runs per migration).
    for (const v of [12, 13]) {
      const versionStamp = db.runCalls.find(
        c => /INSERT OR REPLACE INTO schema_version/.test(c.sql) &&
             Array.isArray(c.params) && c.params[0] === v
      );
      expect(versionStamp).toBeDefined();
    }
  });

  it('is a no-op when current version already equals CURRENT_SCHEMA_VERSION', async () => {
    const db = new FakeDatabase();
    db.execResponders.push(
      { match: /sqlite_master.*schema_version/i, rows: [['schema_version']] },
      { match: /MAX\(version\)/i, rows: [[13]] }
    );

    const migrator = new SchemaMigrator(db);
    const result = await migrator.migrate();

    expect(result.applied).toBe(0);
    expect(result.fromVersion).toBe(13);
    expect(result.toVersion).toBe(13);
    expect(db.runCalls.find(c => /shard_cursors/.test(c.sql))).toBeUndefined();
  });
});

describe('SchemaMigrator v12 -> v13 skills migration', () => {
  it('includes a v13 migration with the skills DDL', () => {
    const v13 = MIGRATIONS.find(m => m.version === 13);
    expect(v13).toBeDefined();
    expect(v13!.description.toLowerCase()).toContain('skills');

    const joined = v13!.sql.join('\n');
    expect(joined).toContain('CREATE TABLE IF NOT EXISTS skills');
    expect(joined).toContain('UNIQUE(provider, name)');
    expect(joined).toContain('CREATE INDEX IF NOT EXISTS idx_skills_name');
  });

  it('uses additive-only DDL for v13 (no DROP / no RENAME / IF NOT EXISTS)', () => {
    const v13 = MIGRATIONS.find(m => m.version === 13)!;
    for (const sql of v13.sql) {
      const upper = sql.toUpperCase();
      expect(upper).not.toContain('DROP TABLE');
      expect(upper).not.toContain('DROP INDEX');
      expect(upper).not.toContain('ALTER TABLE');
      expect(upper).not.toContain('RENAME');
      expect(upper).toContain('IF NOT EXISTS');
    }
  });

  it('runs only the v13 migration when starting at v12', async () => {
    const db = new FakeDatabase();
    db.execResponders.push(
      { match: /sqlite_master.*schema_version/i, rows: [['schema_version']] },
      { match: /MAX\(version\)/i, rows: [[12]] }
    );

    const migrator = new SchemaMigrator(db);
    const result = await migrator.migrate();

    expect(result.fromVersion).toBe(12);
    expect(result.toVersion).toBe(13);
    expect(result.applied).toBe(1);

    const ddlRun = db.runCalls.map(c => c.sql).filter(s => /skills/.test(s));
    expect(ddlRun.some(s => /CREATE TABLE IF NOT EXISTS skills/.test(s))).toBe(true);
    expect(ddlRun.some(s => /CREATE INDEX IF NOT EXISTS idx_skills_name/.test(s))).toBe(true);
    // The earlier shard_cursors migration must NOT run when starting at v12.
    expect(db.runCalls.find(c => /shard_cursors/.test(c.sql))).toBeUndefined();

    const versionStamp = db.runCalls.find(
      c => /INSERT OR REPLACE INTO schema_version/.test(c.sql) &&
           Array.isArray(c.params) && c.params[0] === 13
    );
    expect(versionStamp).toBeDefined();
  });
});
