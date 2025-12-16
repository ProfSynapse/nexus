/**
 * Location: src/database/storage/SQLiteSearchService.ts
 *
 * Full-text search service using SQLite FTS5.
 * Extracted from SQLiteCacheManager for single responsibility.
 */

export interface IQueryExecutor {
  query<T>(sql: string, params?: any[]): Promise<T[]>;
}

export class SQLiteSearchService {
  private queryExecutor: IQueryExecutor;

  constructor(queryExecutor: IQueryExecutor) {
    this.queryExecutor = queryExecutor;
  }

  /**
   * Search workspaces using FTS5
   */
  async searchWorkspaces(query: string, limit: number = 50): Promise<any[]> {
    // FTS5 uses double quotes for phrase search, escape special chars
    const ftsQuery = this.escapeFTS5Query(query);
    return this.queryExecutor.query(
      `SELECT w.* FROM workspaces w
       JOIN workspace_fts fts ON w.rowid = fts.rowid
       WHERE workspace_fts MATCH ?
       ORDER BY rank, w.lastAccessed DESC
       LIMIT ?`,
      [ftsQuery, limit]
    );
  }

  /**
   * Search conversations using FTS5
   */
  async searchConversations(query: string, limit: number = 50): Promise<any[]> {
    const ftsQuery = this.escapeFTS5Query(query);
    return this.queryExecutor.query(
      `SELECT c.* FROM conversations c
       JOIN conversation_fts fts ON c.rowid = fts.rowid
       WHERE conversation_fts MATCH ?
       ORDER BY rank, c.updated DESC
       LIMIT ?`,
      [ftsQuery, limit]
    );
  }

  /**
   * Search messages using FTS5
   */
  async searchMessages(query: string, limit: number = 50): Promise<any[]> {
    const ftsQuery = this.escapeFTS5Query(query);
    return this.queryExecutor.query(
      `SELECT m.* FROM messages m
       JOIN message_fts fts ON m.rowid = fts.rowid
       WHERE message_fts MATCH ?
       ORDER BY rank, m.timestamp DESC
       LIMIT ?`,
      [ftsQuery, limit]
    );
  }

  /**
   * Search messages within a specific conversation using FTS5
   */
  async searchMessagesInConversation(conversationId: string, query: string, limit: number = 50): Promise<any[]> {
    // Use FTS5 column filter syntax
    const ftsQuery = this.escapeFTS5Query(query);
    return this.queryExecutor.query(
      `SELECT m.* FROM messages m
       JOIN message_fts fts ON m.rowid = fts.rowid
       WHERE message_fts MATCH ? AND fts.conversationId = ?
       ORDER BY rank, m.timestamp DESC
       LIMIT ?`,
      [ftsQuery, conversationId, limit]
    );
  }

  /**
   * Escape special characters for FTS5 query
   * FTS5 special chars: " ( ) * : ^
   */
  private escapeFTS5Query(query: string): string {
    // For simple queries, wrap in double quotes for phrase matching
    // This escapes most special characters
    if (query.includes('"')) {
      // If query already has quotes, escape them
      return '"' + query.replace(/"/g, '""') + '"';
    }
    return '"' + query + '"';
  }
}
