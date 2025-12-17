/**
 * Storage Backend Interface
 *
 * Location: src/database/interfaces/IStorageBackend.ts
 * Purpose: Pluggable storage backend interface for different database implementations
 * Used by: HybridStorageAdapter to interact with SQLite, in-memory, or other backends
 *
 * This interface abstracts away the specific database implementation, allowing
 * for different backends:
 * - SQLite (better-sqlite3) for production
 * - sql.js (WASM SQLite) for browser/mobile
 * - In-memory for testing
 *
 * Relationships:
 * - Implemented by: SQLiteBackend, SqlJsBackend, InMemoryBackend
 * - Used by: HybridStorageAdapter
 */

/**
 * Result of a database write operation
 */
export interface RunResult {
  /** Number of rows affected by the operation */
  changes: number;

  /** Row ID of the last inserted row (for INSERT operations) */
  lastInsertRowid: number;
}

/**
 * Pluggable storage backend interface
 *
 * Provides a common interface for different database implementations.
 */
export interface IStorageBackend {
  // ============================================================================
  // Lifecycle Management
  // ============================================================================

  /**
   * Initialize the database connection and schema
   *
   * This should:
   * 1. Open/create the database file (or memory database)
   * 2. Run schema migrations if needed
   * 3. Set up any necessary indexes
   * 4. Configure database settings (WAL mode, foreign keys, etc.)
   *
   * @throws {Error} If initialization fails
   */
  initialize(): Promise<void>;

  /**
   * Close the database connection
   *
   * This should:
   * 1. Flush any pending writes
   * 2. Close the database connection
   * 3. Release any resources
   *
   * @throws {Error} If closing fails
   */
  close(): Promise<void>;

  /**
   * Check if the database is currently open and ready
   */
  isOpen(): boolean;

  // ============================================================================
  // Query Operations
  // ============================================================================

  /**
   * Execute a SELECT query and return all matching rows
   *
   * @template T - The expected shape of the result rows
   * @param sql - SQL query string with optional placeholders (?)
   * @param params - Optional parameters to bind to placeholders
   * @returns Array of result rows (empty array if no matches)
   *
   * @example
   * const users = await backend.query<User>(
   *   'SELECT * FROM users WHERE age > ?',
   *   [18]
   * );
   */
  query<T = any>(sql: string, params?: any[]): Promise<T[]>;

  /**
   * Execute a SELECT query and return the first matching row
   *
   * @template T - The expected shape of the result row
   * @param sql - SQL query string with optional placeholders (?)
   * @param params - Optional parameters to bind to placeholders
   * @returns First matching row, or null if no matches
   *
   * @example
   * const user = await backend.queryOne<User>(
   *   'SELECT * FROM users WHERE id = ?',
   *   [userId]
   * );
   */
  queryOne<T = any>(sql: string, params?: any[]): Promise<T | null>;

  /**
   * Execute an INSERT, UPDATE, or DELETE query
   *
   * @param sql - SQL query string with optional placeholders (?)
   * @param params - Optional parameters to bind to placeholders
   * @returns Result with number of changes and last insert rowid
   *
   * @example
   * const result = await backend.run(
   *   'INSERT INTO users (name, age) VALUES (?, ?)',
   *   ['Alice', 30]
   * );
   * console.log('Inserted user with ID:', result.lastInsertRowid);
   */
  run(sql: string, params?: any[]): Promise<RunResult>;

  // ============================================================================
  // Transaction Support
  // ============================================================================

  /**
   * Begin a new transaction
   *
   * All subsequent operations will be part of this transaction until
   * commit() or rollback() is called.
   *
   * @throws {Error} If a transaction is already active
   */
  beginTransaction(): Promise<void>;

  /**
   * Commit the current transaction
   *
   * Makes all changes since beginTransaction() permanent.
   *
   * @throws {Error} If no transaction is active
   */
  commit(): Promise<void>;

  /**
   * Rollback the current transaction
   *
   * Discards all changes since beginTransaction().
   *
   * @throws {Error} If no transaction is active
   */
  rollback(): Promise<void>;

  /**
   * Execute a function within a transaction
   *
   * Automatically handles begin, commit, and rollback.
   * If the function throws an error, the transaction is rolled back.
   *
   * @template T - Return type of the function
   * @param fn - Function to execute within transaction
   * @returns Result of the function
   *
   * @example
   * await backend.transaction(async () => {
   *   await backend.run('INSERT INTO users ...');
   *   await backend.run('INSERT INTO profiles ...');
   * });
   */
  transaction<T>(fn: () => Promise<T>): Promise<T>;

  // ============================================================================
  // Schema Management
  // ============================================================================

  /**
   * Execute raw SQL statements (for schema creation, migrations, etc.)
   *
   * This can execute multiple statements separated by semicolons.
   * Use this for CREATE TABLE, ALTER TABLE, CREATE INDEX, etc.
   *
   * WARNING: This does not use parameterized queries. Never use user input here.
   *
   * @param sql - SQL statements to execute
   *
   * @example
   * await backend.exec(`
   *   CREATE TABLE IF NOT EXISTS users (
   *     id INTEGER PRIMARY KEY,
   *     name TEXT NOT NULL
   *   );
   *   CREATE INDEX IF NOT EXISTS idx_users_name ON users(name);
   * `);
   */
  exec(sql: string): Promise<void>;

  // ============================================================================
  // Persistence (for in-memory and sql.js backends)
  // ============================================================================

  /**
   * Save database to disk
   *
   * For file-based backends (better-sqlite3), this is a no-op.
   * For in-memory backends (sql.js), this exports the database to a file.
   *
   * @throws {Error} If save fails
   */
  save(): Promise<void>;

  /**
   * Load database from disk
   *
   * For file-based backends (better-sqlite3), this is handled in initialize().
   * For in-memory backends (sql.js), this imports the database from a file.
   *
   * @throws {Error} If load fails
   */
  load?(): Promise<void>;

  // ============================================================================
  // Utilities
  // ============================================================================

  /**
   * Get the path to the database file (if applicable)
   *
   * @returns Database file path, or null for in-memory databases
   */
  getDatabasePath(): string | null;

  /**
   * Vacuum the database to reclaim space
   *
   * This rebuilds the database file, removing deleted data and
   * defragmenting the file.
   */
  vacuum(): Promise<void>;

  /**
   * Get database statistics
   *
   * @returns Object with database statistics (size, table counts, etc.)
   */
  getStats(): Promise<DatabaseStats>;
}

/**
 * Database statistics
 */
export interface DatabaseStats {
  /** Database file size in bytes (0 for in-memory) */
  fileSize: number;

  /** Number of tables */
  tableCount: number;

  /** Total number of rows across all tables */
  totalRows: number;

  /** Map of table name to row count */
  tableCounts: Record<string, number>;

  /** Whether the database is using WAL mode */
  walMode: boolean;
}
