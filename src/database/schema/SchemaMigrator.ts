/**
 * Schema Migrator for SQLite Database
 * Location: src/database/schema/SchemaMigrator.ts
 *
 * Purpose: Handle incremental schema migrations without data loss.
 * Each migration is idempotent and can be safely re-run.
 *
 * ============================================================================
 * HOW TO ADD A NEW SCHEMA MIGRATION
 * ============================================================================
 *
 * When you need to modify the database schema (add columns, tables, indexes):
 *
 * STEP 1: Update CURRENT_SCHEMA_VERSION
 *   - Increment the version number (e.g., 3 -> 4)
 *
 * STEP 2: Add a new migration to the MIGRATIONS array
 *   - Add an entry with the new version number
 *   - Include a description of what the migration does
 *   - Add the SQL statements needed
 *
 *   Example:
 *   ```
 *   {
 *     version: 4,
 *     description: 'Add tags column to conversations table',
 *     sql: [
 *       'ALTER TABLE conversations ADD COLUMN tagsJson TEXT',
 *     ]
 *   }
 *   ```
 *
 * STEP 3: Update SCHEMA_SQL in schema.ts
 *   - Add the same columns/tables to the main schema
 *   - This ensures new installs get the complete schema
 *
 * IMPORTANT RULES:
 *   - NEVER modify existing migrations - only add new ones
 *   - Migrations must be idempotent (the migrator checks if columns exist)
 *   - Use ALTER TABLE ADD COLUMN for new columns (preserves existing data)
 *   - Use CREATE TABLE IF NOT EXISTS for new tables
 *   - Use CREATE INDEX IF NOT EXISTS for new indexes
 *   - Test on a vault with existing data before releasing
 *
 * SUPPORTED OPERATIONS:
 *   - Adding columns: ALTER TABLE x ADD COLUMN y TYPE
 *   - Adding tables: CREATE TABLE IF NOT EXISTS x (...)
 *   - Adding indexes: CREATE INDEX IF NOT EXISTS x ON y(z)
 *   - Adding triggers: CREATE TRIGGER IF NOT EXISTS x ...
 *
 * NOT SUPPORTED (requires manual data migration):
 *   - Removing columns (SQLite doesn't support DROP COLUMN easily)
 *   - Renaming columns
 *   - Changing column types
 *
 * ============================================================================
 */

/**
 * Minimal interface for SQLite database operations needed by SchemaMigrator.
 * Works with both sql.js and @dao-xyz/sqlite3-vec WASM databases.
 */
export interface MigratableDatabase {
  /** Execute SQL and return results */
  exec(sql: string): { values: any[][] }[];
  /** Run a statement (INSERT/UPDATE/DELETE) */
  run(sql: string, params?: any[]): void;
}

// Alias for backward compatibility
type Database = MigratableDatabase;

export const CURRENT_SCHEMA_VERSION = 3;

export interface Migration {
  version: number;
  description: string;
  /** SQL statements to run. Each is executed separately. */
  sql: string[];
}

/**
 * Migration definitions - add new migrations here when schema changes.
 *
 * IMPORTANT:
 * - Never modify existing migrations
 * - Always add new migrations with incrementing version numbers
 * - Migrations must be idempotent (safe to run multiple times)
 * - Use "IF NOT EXISTS" for new tables/indexes
 * - For columns, check if column exists before adding
 */
export const MIGRATIONS: Migration[] = [
  // Version 1 -> 2: Initial schema (handled by fresh install)
  // No migration needed - v1 and v2 had same structure

  // Version 2 -> 3: Add message alternatives/branching support
  {
    version: 3,
    description: 'Add alternativesJson and activeAlternativeIndex to messages table for branching support',
    sql: [
      // SQLite doesn't have IF NOT EXISTS for columns, so we use a workaround
      // The migrator will check column existence before running these
      `ALTER TABLE messages ADD COLUMN alternativesJson TEXT`,
      `ALTER TABLE messages ADD COLUMN activeAlternativeIndex INTEGER DEFAULT 0`,
    ]
  },

  // ========================================================================
  // ADD NEW MIGRATIONS BELOW THIS LINE
  // ========================================================================
  // Template for new migration:
  //
  // {
  //   version: 4,  // <-- Increment CURRENT_SCHEMA_VERSION to match
  //   description: 'Brief description of what this migration does',
  //   sql: [
  //     // For new columns:
  //     'ALTER TABLE tableName ADD COLUMN columnName TEXT',
  //     'ALTER TABLE tableName ADD COLUMN columnName INTEGER DEFAULT 0',
  //
  //     // For new tables:
  //     'CREATE TABLE IF NOT EXISTS newTable (id TEXT PRIMARY KEY, ...)',
  //
  //     // For new indexes:
  //     'CREATE INDEX IF NOT EXISTS idx_table_column ON tableName(column)',
  //   ]
  // },
  //
  // Remember: Also update SCHEMA_SQL in schema.ts with the same changes!
  // ========================================================================
];

/**
 * SchemaMigrator handles database schema upgrades
 */
export class SchemaMigrator {
  private db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  /**
   * Get the current schema version from the database
   * Returns 0 if schema_version table doesn't exist (very old DB)
   * Returns 1 if table exists but is empty (pre-versioning DB)
   */
  getCurrentVersion(): number {
    try {
      // Check if schema_version table exists
      const tableCheck = this.db.exec(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'"
      );

      if (tableCheck.length === 0 || tableCheck[0].values.length === 0) {
        // No schema_version table - this is a very old database or fresh
        // Check if messages table exists to differentiate
        const messagesCheck = this.db.exec(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='messages'"
        );

        if (messagesCheck.length === 0 || messagesCheck[0].values.length === 0) {
          // No messages table = fresh database, return 0
          return 0;
        }

        // Has messages but no schema_version = v1 database
        return 1;
      }

      // Get max version from schema_version table
      const result = this.db.exec('SELECT MAX(version) as version FROM schema_version');

      if (result.length === 0 || result[0].values.length === 0 || result[0].values[0][0] === null) {
        // Table exists but empty - treat as v1
        return 1;
      }

      return result[0].values[0][0] as number;
    } catch (error) {
      console.error('[SchemaMigrator] Error getting current version:', error);
      return 0;
    }
  }

  /**
   * Check if a column exists in a table
   */
  private columnExists(tableName: string, columnName: string): boolean {
    try {
      const result = this.db.exec(`PRAGMA table_info(${tableName})`);

      if (result.length === 0) return false;

      // PRAGMA table_info returns: cid, name, type, notnull, dflt_value, pk
      // Column name is at index 1
      const columns = result[0].values.map(row => row[1] as string);
      return columns.includes(columnName);
    } catch (error) {
      console.error(`[SchemaMigrator] Error checking column ${tableName}.${columnName}:`, error);
      return false;
    }
  }

  /**
   * Run all pending migrations
   * Returns migration result including whether a rebuild is needed
   *
   * NOTE: When migrations are applied, the SQLite cache should be rebuilt from JSONL
   * because the existing data doesn't have the new columns populated correctly.
   */
  async migrate(): Promise<{
    applied: number;
    fromVersion: number;
    toVersion: number;
    needsRebuild: boolean;  // True if migrations were applied and data should be rebuilt from JSONL
  }> {
    const currentVersion = this.getCurrentVersion();
    const targetVersion = CURRENT_SCHEMA_VERSION;

    console.log(`[SchemaMigrator] Current version: ${currentVersion}, Target version: ${targetVersion}`);

    if (currentVersion >= targetVersion) {
      console.log('[SchemaMigrator] Database is up to date');
      return { applied: 0, fromVersion: currentVersion, toVersion: currentVersion, needsRebuild: false };
    }

    // Ensure schema_version table exists
    this.ensureSchemaVersionTable();

    // Get migrations to apply (versions > currentVersion)
    const pendingMigrations = MIGRATIONS.filter(m => m.version > currentVersion);

    if (pendingMigrations.length === 0) {
      // No migrations but version is behind - just update version
      this.setVersion(targetVersion);
      return { applied: 0, fromVersion: currentVersion, toVersion: targetVersion, needsRebuild: false };
    }

    console.log(`[SchemaMigrator] Applying ${pendingMigrations.length} migration(s)`);

    let appliedCount = 0;

    for (const migration of pendingMigrations) {
      console.log(`[SchemaMigrator] Applying migration v${migration.version}: ${migration.description}`);

      try {
        for (const sql of migration.sql) {
          // Handle ALTER TABLE ADD COLUMN specially - check if column exists first
          const alterMatch = sql.match(/ALTER TABLE (\w+) ADD COLUMN (\w+)/i);

          if (alterMatch) {
            const [, tableName, columnName] = alterMatch;

            if (this.columnExists(tableName, columnName)) {
              console.log(`[SchemaMigrator] Column ${tableName}.${columnName} already exists, skipping`);
              continue;
            }
          }

          this.db.run(sql);
        }

        // Record this migration
        this.setVersion(migration.version);
        appliedCount++;

        console.log(`[SchemaMigrator] Migration v${migration.version} applied successfully`);
      } catch (error) {
        console.error(`[SchemaMigrator] Migration v${migration.version} failed:`, error);
        throw error;
      }
    }

    // NOTE: We do NOT force a full rebuild because it can cause OOM with large vaults.
    // The new columns will have NULL/default values for existing rows, which is fine.
    // New data will populate the columns correctly.
    // If a full rebuild is needed, users can delete .nexus/cache.db manually.
    return {
      applied: appliedCount,
      fromVersion: currentVersion,
      toVersion: targetVersion,
      needsRebuild: false  // Don't force rebuild - can cause OOM
    };
  }

  /**
   * Ensure schema_version table exists
   */
  private ensureSchemaVersionTable(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER PRIMARY KEY,
        appliedAt INTEGER NOT NULL
      )
    `);
  }

  /**
   * Set the current schema version
   */
  private setVersion(version: number): void {
    this.db.run(
      'INSERT OR REPLACE INTO schema_version (version, appliedAt) VALUES (?, ?)',
      [version, Date.now()]
    );
  }
}
