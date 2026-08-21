import { SCHEMA_SQL } from '../../src/database/schema/schema';
import { CURRENT_SCHEMA_VERSION, MIGRATIONS } from '../../src/database/schema/SchemaMigrator';

/**
 * The fresh-install half of the v15 schema change (issue #219).
 *
 * `SCHEMA_SQL` is the ONLY DDL a new user ever executes: it ends by stamping
 * `schema_version`, after which `migrate()` early-returns and never applies a
 * single migration. A column that exists only in MIGRATIONS therefore exists
 * only for upgraders — and every developer machine, which has an old cache and
 * upgrades through MIGRATIONS, looks perfectly healthy.
 *
 * These assertions fail against a tree where the migration landed and
 * SCHEMA_SQL did not.
 */
describe('states.isArchived in the fresh-install schema (v15)', () => {
  function statesTableBody(): string {
    const match = SCHEMA_SQL.match(/CREATE TABLE IF NOT EXISTS states\s*\(([\s\S]*?)\n\);/);
    expect(match).not.toBeNull();
    return match![1];
  }

  it('declares isArchived on the states table', () => {
    expect(statesTableBody()).toMatch(/^\s*isArchived INTEGER\s*,?\s*$/m);
  });

  it('declares it nullable with no default, matching the migration', () => {
    // Fresh installs and upgraded installs must agree on what an unwritten row
    // means. `DEFAULT 0` here would make a fresh cache claim "not archived" for
    // rows whose content was never consulted.
    const isArchivedLine = statesTableBody()
      .split('\n')
      .find(line => /\bisArchived\b/.test(line))!;
    expect(isArchivedLine.toUpperCase()).not.toContain('DEFAULT');
    expect(isArchivedLine.toUpperCase()).not.toContain('NOT NULL');
  });

  it('creates the archive index', () => {
    expect(SCHEMA_SQL).toContain('CREATE INDEX IF NOT EXISTS idx_states_archived ON states(isArchived)');
  });

  it('stamps schema_version with CURRENT_SCHEMA_VERSION', () => {
    const stamp = SCHEMA_SQL.match(/INSERT OR IGNORE INTO schema_version VALUES \((\d+)/);
    expect(stamp).not.toBeNull();
    expect(Number(stamp![1])).toBe(CURRENT_SCHEMA_VERSION);
  });

  it('keeps the highest migration version equal to CURRENT_SCHEMA_VERSION', () => {
    const highest = Math.max(...MIGRATIONS.map(m => m.version));
    expect(highest).toBe(CURRENT_SCHEMA_VERSION);
  });
});
