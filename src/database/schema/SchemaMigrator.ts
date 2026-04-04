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
 *
 * Note: The raw WASM database only has prepare(), but this interface expects
 * exec() and run() to be provided by a wrapper/adapter class.
 */
export interface MigratableDatabase {
  /** Execute SQL and return results */
  exec(sql: string): { values: unknown[][] }[];
  /** Run a statement (INSERT/UPDATE/DELETE) with optional parameters */
  run(sql: string, params?: unknown[]): void;
}

// Alias for backward compatibility
type Database = MigratableDatabase;

export const CURRENT_SCHEMA_VERSION = 12;

export interface Migration {
  version: number;
  description: string;
  /** SQL statements to run. Each is executed separately. */
  sql: string[];
  /** Optional JavaScript migration function for logic that cannot be expressed in SQL alone (e.g., JSON parsing). */
  migrationFn?: (db: MigratableDatabase) => void;
}

interface LegacyConversationMetadata {
  chatSettings?: {
    workspaceId?: string;
    sessionId?: string;
  };
  workspaceId?: string;
  sessionId?: string;
  workflowId?: string;
  runTrigger?: string;
  scheduledFor?: number;
  runKey?: string;
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

  // Version 3 -> 4: Added branches tables (intermediate version, now superseded by v5)
  // NOTE: This was only in schema.ts for fresh installs, never migrated.
  // Skipped in migration since v5 removes these tables anyway.

  // Version 4 -> 5: Remove branches tables (unified model: branches ARE conversations)
  // In the unified model, branches are stored as regular conversations with:
  //   - metadata.parentConversationId: parent conversation
  //   - metadata.parentMessageId: message branch is attached to
  //   - metadata.branchType: 'alternative' | 'subagent'
  {
    version: 5,
    description: 'Remove branches and branch_messages tables - unified model stores branches as conversations with parent metadata',
    sql: [
      // Drop tables if they exist (v4 fresh installs have them, v3 upgrades don't)
      'DROP TABLE IF EXISTS branch_messages',
      'DROP TABLE IF EXISTS branches',
    ]
  },

  // Version 5 -> 6: Add dedicatedAgentId to workspaces table + custom_prompts table
  {
    version: 6,
    description: 'Add dedicatedAgentId column to workspaces table and custom_prompts table for SQLite-based prompt storage',
    sql: [
      // Add dedicatedAgentId column (stores either agent name or ID)
      `ALTER TABLE workspaces ADD COLUMN dedicatedAgentId TEXT`,

      // Create custom_prompts table for SQLite-based prompt storage
      `CREATE TABLE IF NOT EXISTS custom_prompts (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        description TEXT,
        prompt TEXT NOT NULL,
        isEnabled INTEGER NOT NULL DEFAULT 1,
        created INTEGER NOT NULL,
        modified INTEGER NOT NULL
      )`,

      // Create indexes for custom_prompts
      `CREATE INDEX IF NOT EXISTS idx_custom_prompts_name ON custom_prompts(name)`,
      `CREATE INDEX IF NOT EXISTS idx_custom_prompts_enabled ON custom_prompts(isEnabled)`
    ]
  },

  // ========================================================================
  // ADD NEW MIGRATIONS BELOW THIS LINE
  // ========================================================================

  // Version 6 -> 7: Add conversation embeddings, backfill state, and denormalized workspace/session columns
  {
    version: 7,
    description: 'Add conversation embedding tables, embedding backfill state, and denormalized workspaceId/sessionId on conversations',
    sql: [
      // Denormalized columns on conversations table
      `ALTER TABLE conversations ADD COLUMN workspaceId TEXT`,
      `ALTER TABLE conversations ADD COLUMN sessionId TEXT`,
      `CREATE INDEX IF NOT EXISTS idx_conversations_workspaceId ON conversations(workspaceId)`,
      `CREATE INDEX IF NOT EXISTS idx_conversations_sessionId ON conversations(sessionId)`,

      // Conversation embeddings vec0 virtual table
      `CREATE VIRTUAL TABLE IF NOT EXISTS conversation_embeddings USING vec0(
        embedding float[384]
      )`,

      // Conversation embedding metadata
      `CREATE TABLE IF NOT EXISTS conversation_embedding_metadata (
        rowid INTEGER PRIMARY KEY,
        pairId TEXT NOT NULL,
        side TEXT NOT NULL,
        chunkIndex INTEGER NOT NULL,
        conversationId TEXT NOT NULL,
        startSequenceNumber INTEGER NOT NULL,
        endSequenceNumber INTEGER NOT NULL,
        pairType TEXT NOT NULL,
        sourceId TEXT,
        sessionId TEXT,
        workspaceId TEXT,
        model TEXT NOT NULL,
        contentHash TEXT NOT NULL,
        contentPreview TEXT,
        created INTEGER NOT NULL
      )`,

      // Indexes for conversation embedding metadata
      `CREATE INDEX IF NOT EXISTS idx_conv_embed_meta_pairId ON conversation_embedding_metadata(pairId)`,
      `CREATE INDEX IF NOT EXISTS idx_conv_embed_meta_conversationId ON conversation_embedding_metadata(conversationId)`,
      `CREATE INDEX IF NOT EXISTS idx_conv_embed_meta_workspaceId ON conversation_embedding_metadata(workspaceId)`,
      `CREATE INDEX IF NOT EXISTS idx_conv_embed_meta_sessionId ON conversation_embedding_metadata(sessionId)`,

      // Embedding backfill state table
      `CREATE TABLE IF NOT EXISTS embedding_backfill_state (
        id TEXT PRIMARY KEY DEFAULT 'conversation_backfill',
        lastProcessedConversationId TEXT,
        totalConversations INTEGER DEFAULT 0,
        processedConversations INTEGER DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending',
        startedAt INTEGER,
        completedAt INTEGER,
        errorMessage TEXT
      )`,
    ],
    migrationFn: (db: MigratableDatabase): void => {
      // Backfill denormalized workspaceId/sessionId from metadataJson
      // Cannot use json_extract() — may not be available in WASM SQLite
      const rows = db.exec('SELECT id, metadataJson FROM conversations WHERE metadataJson IS NOT NULL');
      if (rows.length === 0) return;

      for (const row of rows[0].values) {
        const id = row[0] as string;
        const metadataJson = row[1] as string;

        let workspaceId: string | null = null;
        let sessionId: string | null = null;

        try {
          const metadata = JSON.parse(metadataJson) as LegacyConversationMetadata;

          // Try chatSettings path first (ConversationManager-created conversations)
          if (metadata?.chatSettings?.workspaceId) {
            workspaceId = metadata.chatSettings.workspaceId;
          }
          if (metadata?.chatSettings?.sessionId) {
            sessionId = metadata.chatSettings.sessionId;
          }

          // Fall back to top-level path (directly-created conversations)
          if (!workspaceId && metadata?.workspaceId) {
            workspaceId = metadata.workspaceId;
          }
          if (!sessionId && metadata?.sessionId) {
            sessionId = metadata.sessionId;
          }
        } catch {
          // Skip conversations with unparseable metadataJson
          continue;
        }

        if (workspaceId || sessionId) {
          db.run(
            'UPDATE conversations SET workspaceId = ?, sessionId = ? WHERE id = ?',
            [workspaceId, sessionId, id]
          );
        }
      }
    },
  },

  // Version 7 -> 8: Add referencedNotes column to conversation_embedding_metadata
  {
    version: 8,
    description: 'Add referencedNotes column to conversation_embedding_metadata for pre-extracted wiki-link references',
    sql: [
      `ALTER TABLE conversation_embedding_metadata ADD COLUMN referencedNotes TEXT`,
    ]
  },

  // Version 8 -> 9: Add task management tables (projects, tasks, task_dependencies, task_note_links)
  {
    version: 9,
    description: 'Add task management tables (projects, tasks, task_dependencies, task_note_links)',
    sql: [
      // Projects table
      `CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        workspaceId TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        created INTEGER NOT NULL,
        updated INTEGER NOT NULL,
        metadataJson TEXT,
        FOREIGN KEY(workspaceId) REFERENCES workspaces(id) ON DELETE CASCADE,
        UNIQUE(workspaceId, name)
      )`,
      // Tasks table
      `CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        projectId TEXT NOT NULL,
        workspaceId TEXT NOT NULL,
        parentTaskId TEXT,
        title TEXT NOT NULL,
        description TEXT,
        status TEXT NOT NULL DEFAULT 'todo',
        priority TEXT DEFAULT 'medium',
        created INTEGER NOT NULL,
        updated INTEGER NOT NULL,
        completedAt INTEGER,
        dueDate INTEGER,
        assignee TEXT,
        tagsJson TEXT,
        metadataJson TEXT,
        FOREIGN KEY(projectId) REFERENCES projects(id) ON DELETE CASCADE,
        FOREIGN KEY(workspaceId) REFERENCES workspaces(id) ON DELETE CASCADE,
        FOREIGN KEY(parentTaskId) REFERENCES tasks(id) ON DELETE SET NULL
      )`,
      // Task dependencies (DAG edges)
      `CREATE TABLE IF NOT EXISTS task_dependencies (
        taskId TEXT NOT NULL,
        dependsOnTaskId TEXT NOT NULL,
        created INTEGER NOT NULL,
        PRIMARY KEY(taskId, dependsOnTaskId),
        FOREIGN KEY(taskId) REFERENCES tasks(id) ON DELETE CASCADE,
        FOREIGN KEY(dependsOnTaskId) REFERENCES tasks(id) ON DELETE CASCADE
      )`,
      // Task-note links (bidirectional)
      `CREATE TABLE IF NOT EXISTS task_note_links (
        taskId TEXT NOT NULL,
        notePath TEXT NOT NULL,
        linkType TEXT NOT NULL DEFAULT 'reference',
        created INTEGER NOT NULL,
        PRIMARY KEY(taskId, notePath),
        FOREIGN KEY(taskId) REFERENCES tasks(id) ON DELETE CASCADE
      )`,
      // Indexes
      'CREATE INDEX IF NOT EXISTS idx_projects_workspace ON projects(workspaceId)',
      'CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status)',
      'CREATE INDEX IF NOT EXISTS idx_projects_updated ON projects(updated)',
      'CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(projectId)',
      'CREATE INDEX IF NOT EXISTS idx_tasks_workspace ON tasks(workspaceId)',
      'CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parentTaskId)',
      'CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)',
      'CREATE INDEX IF NOT EXISTS idx_tasks_priority ON tasks(priority)',
      'CREATE INDEX IF NOT EXISTS idx_tasks_updated ON tasks(updated)',
      'CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(dueDate)',
      'CREATE INDEX IF NOT EXISTS idx_tasks_project_status ON tasks(projectId, status)',
      'CREATE INDEX IF NOT EXISTS idx_task_deps_task ON task_dependencies(taskId)',
      'CREATE INDEX IF NOT EXISTS idx_task_deps_depends ON task_dependencies(dependsOnTaskId)',
      'CREATE INDEX IF NOT EXISTS idx_task_links_note ON task_note_links(notePath)',
    ]
  },

  // Version 9 -> 10: Add workflow run metadata columns to conversations
  {
    version: 10,
    description: 'Add workflow run metadata columns to conversations for scheduled workflow dedupe',
    sql: [
      'ALTER TABLE conversations ADD COLUMN workflowId TEXT',
      'ALTER TABLE conversations ADD COLUMN runTrigger TEXT',
      'ALTER TABLE conversations ADD COLUMN scheduledFor INTEGER',
      'ALTER TABLE conversations ADD COLUMN runKey TEXT',
      'CREATE INDEX IF NOT EXISTS idx_conversations_workflowId ON conversations(workflowId)',
      'CREATE INDEX IF NOT EXISTS idx_conversations_scheduledFor ON conversations(scheduledFor)',
      'CREATE INDEX IF NOT EXISTS idx_conversations_runKey ON conversations(runKey)'
    ],
    migrationFn: (db: MigratableDatabase): void => {
      const rows = db.exec('SELECT id, metadataJson FROM conversations WHERE metadataJson IS NOT NULL');
      if (rows.length === 0) return;

      for (const row of rows[0].values) {
        const id = row[0] as string;
        const metadataJson = row[1] as string;

        try {
          const metadata = JSON.parse(metadataJson) as LegacyConversationMetadata;
          const workflowId = metadata?.workflowId;
          const runTrigger = metadata?.runTrigger;
          const scheduledFor = metadata?.scheduledFor;
          const runKey = metadata?.runKey;

          if (workflowId || runTrigger || scheduledFor || runKey) {
            db.run(
              'UPDATE conversations SET workflowId = ?, runTrigger = ?, scheduledFor = ?, runKey = ? WHERE id = ?',
              [workflowId ?? null, runTrigger ?? null, scheduledFor ?? null, runKey ?? null, id]
            );
          }
        } catch {
          // Ignore unparseable metadata rows.
        }
      }
    }
  },

  // Version 10 -> 11: Add workspace archive flag
  {
    version: 11,
    description: 'Add isArchived column to workspaces table for soft-delete persistence',
    sql: [
      'ALTER TABLE workspaces ADD COLUMN isArchived INTEGER DEFAULT 0',
      'CREATE INDEX IF NOT EXISTS idx_workspaces_archived ON workspaces(isArchived)'
    ]
  },

  // Version 11 -> 12: Rebuild note and block embedding tables for 384-dim model
  // The note_embeddings and block_embeddings vec0 tables were created with float[768]
  // when an older embedding model was in use. The current model (TaylorAI/bge-micro-v2)
  // produces 384-dim vectors. vec0 virtual tables cannot be ALTERed — they must be
  // dropped and recreated. Dropping a vec0 table also drops its shadow tables
  // (_chunks, _info, _rowids, _vector_chunks00), so no manual shadow cleanup is needed.
  // Associated metadata rows are also cleared since their rowids are now invalid.
  {
    version: 12,
    description: 'Rebuild note_embeddings and block_embeddings vec0 tables from float[768] to float[384] to match current embedding model output',
    sql: [
      'DROP TABLE IF EXISTS note_embeddings',
      'CREATE VIRTUAL TABLE IF NOT EXISTS note_embeddings USING vec0(embedding float[384])',
      'DROP TABLE IF EXISTS block_embeddings',
      'CREATE VIRTUAL TABLE IF NOT EXISTS block_embeddings USING vec0(embedding float[384])',
      'DELETE FROM embedding_metadata',
      'DELETE FROM block_embedding_metadata',
    ]
  },
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

    if (currentVersion >= targetVersion) {
      return { applied: 0, fromVersion: currentVersion, toVersion: currentVersion, needsRebuild: false };
    }

    // Ensure schema_version table exists
    this.ensureSchemaVersionTable();

    // Get migrations to apply (versions > currentVersion)
    const pendingMigrations = MIGRATIONS.filter(m => m.version > currentVersion);

    if (pendingMigrations.length === 0) {
      this.setVersion(targetVersion);
      return { applied: 0, fromVersion: currentVersion, toVersion: targetVersion, needsRebuild: false };
    }

    let appliedCount = 0;

    for (const migration of pendingMigrations) {
      try {
        for (const sql of migration.sql) {
          const alterMatch = sql.match(/ALTER TABLE (\w+) ADD COLUMN (\w+)/i);

          if (alterMatch) {
            const [, tableName, columnName] = alterMatch;

            if (this.columnExists(tableName, columnName)) {
              continue;
            }
          }

          this.db.run(sql);
        }

        // Run optional JavaScript migration function (e.g., JSON-based backfills)
        if (migration.migrationFn) {
          migration.migrationFn(this.db);
        }

        this.setVersion(migration.version);
        appliedCount++;
      } catch (error) {
        console.error(`[SchemaMigrator] Migration v${migration.version} failed:`, error);
        throw error;
      }
    }

    return {
      applied: appliedCount,
      fromVersion: currentVersion,
      toVersion: targetVersion,
      needsRebuild: false
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
