/**
 * Regression tests for the notes query index losing its tables.
 *
 * The defect: `notes` and `note_properties` were created ONLY by
 * `NotesIndexService.ensureSchema()`, at notesIndex service start. They were
 * absent from `SCHEMA_SQL`, which is the entire schema a freshly created
 * database executes. "Nexus: Rebuild cache" closes the connection, deletes the
 * cache blob and reopens from `SCHEMA_SQL`, so both tables vanished — while the
 * still-subscribed NotesIndexBuilder kept writing on every metadataCache/vault
 * event. Result, live in Obsidian 1.13.7:
 *
 *   SQLite3Error: SQLITE_ERROR: sqlite3 result code 1: no such table: notes
 *       at NotesIndexService.upsertNote / NotesIndexService.deleteNote
 *
 * repeated for the rest of the session, with no way back short of a reload.
 *
 * These assertions fail against the pre-fix tree: `SCHEMA_SQL` contained
 * neither table, and no migration declared them.
 */

import { SCHEMA_SQL } from '../../src/database/schema/schema';
import { CURRENT_SCHEMA_VERSION, MIGRATIONS } from '../../src/database/schema/SchemaMigrator';
import { NOTES_INDEX_DDL } from '../../src/database/services/notesIndex/NotesIndexService';

/** Column names declared inside `CREATE TABLE <name> ( ... )` in a DDL blob. */
function columnsOf(ddl: string, table: string): string[] {
  const start = new RegExp(`CREATE\\s+TABLE\\s+IF\\s+NOT\\s+EXISTS\\s+${table}\\s*\\(`, 'i').exec(ddl);
  if (!start) {
    return [];
  }
  let depth = 0;
  let end = start.index + start[0].length - 1;
  for (let i = end; i < ddl.length; i++) {
    if (ddl[i] === '(') depth++;
    if (ddl[i] === ')') {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  const body = ddl
    .slice(start.index + start[0].length, end)
    // strip SQL line comments so documentation prose is not read as columns
    .replace(/--[^\n]*/g, '');

  return body
    .split(/,(?![^(]*\))/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => line.split(/\s+/)[0])
    .filter((name) => !/^(PRIMARY|UNIQUE|FOREIGN|CHECK|CONSTRAINT)$/i.test(name));
}

describe('notes query index schema ownership', () => {
  const NOTES_TABLES = ['notes', 'note_properties'] as const;

  it.each(NOTES_TABLES)(
    'SCHEMA_SQL creates %s, so a database built from scratch has it',
    (table) => {
      expect(SCHEMA_SQL).toMatch(
        new RegExp(`CREATE\\s+TABLE\\s+IF\\s+NOT\\s+EXISTS\\s+${table}\\s*\\(`, 'i')
      );
    }
  );

  it('SCHEMA_SQL creates every index the notes DDL declares', () => {
    for (const idx of ['idx_notes_folder', 'idx_notes_mtime', 'idx_np_key_text', 'idx_np_key_num', 'idx_np_note']) {
      expect(SCHEMA_SQL).toContain(`CREATE INDEX IF NOT EXISTS ${idx}`);
    }
  });

  it('a migration declares the tables too, so an existing cache is upgraded', () => {
    const declaring = MIGRATIONS.filter((m) => /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+notes\s*\(/i.test(m.sql.join('\n')));
    expect(declaring).toHaveLength(1);
    expect(declaring[0].version).toBeLessThanOrEqual(CURRENT_SCHEMA_VERSION);
  });

  it('SCHEMA_SQL stamps the version the migrator considers current', () => {
    // A fresh install is stamped by SCHEMA_SQL and then migrate() early-returns,
    // so a lagging literal here means new users silently replay migrations.
    const stamp = /INSERT\s+OR\s+IGNORE\s+INTO\s+schema_version\s+VALUES\s*\(\s*(\d+)/i.exec(SCHEMA_SQL);
    expect(stamp).not.toBeNull();
    expect(Number(stamp![1])).toBe(CURRENT_SCHEMA_VERSION);
  });

  describe('the three DDL copies agree (NotesIndexSchemaParity)', () => {
    /** Every migration's SQL, so parity does not depend on which version added it. */
    const migrationDdl = MIGRATIONS.map((m) => m.sql.join(';\n')).join(';\n');

    it.each(NOTES_TABLES)('%s has the same columns in all three definitions', (table) => {
      const fromRuntime = columnsOf(NOTES_INDEX_DDL, table);
      const fromSchema = columnsOf(SCHEMA_SQL, table);
      const fromMigration = columnsOf(migrationDdl, table);

      expect(fromRuntime.length).toBeGreaterThan(0);
      expect(fromSchema).toEqual(fromRuntime);
      expect(fromMigration).toEqual(fromRuntime);
    });
  });
});
