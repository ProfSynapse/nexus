/**
 * QueryNotesTool — read-only SQL over the notes query index.
 *
 * Located at: src/agents/searchManager/tools/queryNotes.ts
 * The agent writes a SELECT against the `notes` + `note_properties` tables (and
 * may JOIN other cache tables); SQLite does the filtering + computation. There
 * is deliberately NO query DSL or formula evaluator — see
 * docs/plans/notes-query-index-plan.md §2 / §7 / §7.1.
 *
 * Safety: a read-only guard (single SELECT/WITH statement, no write/DDL/PRAGMA)
 * lives here in the tool, NOT in the schema — schema `required`/`enum` is not
 * runtime-validated in this codebase, so all guards must be code.
 */

import { BaseTool } from '../../baseTool';
import { CommonParameters, CommonResult } from '../../../types';
import { JSONSchema } from '../../../types/schema/JSONSchemaTypes';
import type { SQLiteCacheManager } from '../../../database/storage/SQLiteCacheManager';

/** Resolver for the shared SQLite cache (same instance the index lives in). */
export type SqliteResolver = () => SQLiteCacheManager | undefined;

export interface QueryNotesParams extends CommonParameters {
  /** A single read-only SELECT / WITH statement. */
  sql?: string;
  /** Positional bind parameters for `?` placeholders. */
  params?: Array<string | number | boolean | null>;
  /** Cap on returned rows (default 500, max 5000). Excess sets `truncated`. */
  maxRows?: number;
  /** When true, return the index schema + distinct property keys instead of running `sql`. */
  describe?: boolean;
}

const DEFAULT_MAX_ROWS = 500;
const HARD_MAX_ROWS = 5000;

/** Statements other than a leading SELECT/WITH, or these keywords anywhere, are rejected. */
const FORBIDDEN = /\b(insert|update|delete|drop|alter|create|attach|detach|pragma|reindex|vacuum|replace|truncate|grant|revoke|begin|commit|rollback)\b/i;

export class QueryNotesTool extends BaseTool<QueryNotesParams, CommonResult> {
  constructor(private readonly sqliteResolver: SqliteResolver) {
    super(
      'queryNotes',
      'Query Notes',
      'Run a read-only SQL SELECT over the notes index (frontmatter as a database).',
      '1.0.0'
    );
  }

  async execute(params: QueryNotesParams): Promise<CommonResult> {
    const sqlite = this.sqliteResolver();
    if (!sqlite) {
      return this.prepareResult(false, undefined, 'Notes index is unavailable (storage still initializing). Try again in a moment.');
    }

    try {
      if (params.describe) {
        return this.prepareResult(true, await this.describe(sqlite));
      }

      const sql = typeof params.sql === 'string' ? params.sql.trim() : '';
      if (!sql) {
        return this.prepareResult(false, undefined, 'sql is required. Example: search query-notes --sql "SELECT path FROM notes LIMIT 10". Use --describe to see the schema.');
      }

      const guard = assertReadOnlySelect(sql);
      if (!guard.ok) {
        return this.prepareResult(false, undefined, guard.error);
      }

      const maxRows = clampRows(params.maxRows);
      const bind = Array.isArray(params.params) ? params.params : [];
      const all = await sqlite.query<Record<string, unknown>>(sql, bind);
      const rows = all.slice(0, maxRows);
      const columns = rows.length > 0 ? Object.keys(rows[0]) : [];

      return this.prepareResult(true, {
        columns,
        rows,
        rowCount: rows.length,
        truncated: all.length > rows.length,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const hint = /no such table/i.test(message)
        ? ' (the notes index may not be built yet — try again shortly)'
        : '';
      return this.prepareResult(false, undefined, `Query failed: ${message}${hint}`);
    }
  }

  /** Schema + distinct property keys, so the agent can author queries without guessing. */
  private async describe(sqlite: SQLiteCacheManager): Promise<Record<string, unknown>> {
    let noteCount = 0;
    let keys: string[] = [];
    try {
      noteCount = (await sqlite.queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM notes', []))?.n ?? 0;
      const rows = await sqlite.query<{ key: string }>('SELECT DISTINCT key FROM note_properties ORDER BY key LIMIT 500', []);
      keys = rows.map((r) => r.key);
    } catch {
      // tables not built yet — return the static shape with an empty key set
    }

    return {
      tables: {
        notes: ['id', 'path', 'basename', 'folder', 'ext', 'title', 'ctime', 'mtime', 'size', 'tags_json', 'links_json', 'frontmatter_json', 'content_hash'],
        note_properties: ['note_id', 'key', 'key_raw', 'value_text', 'value_num', 'value_type', 'position'],
      },
      usage: [
        'Filter on arbitrary frontmatter via note_properties (indexed): EXISTS (SELECT 1 FROM note_properties p WHERE p.note_id = n.id AND p.key = ? AND p.value_text = ?).',
        'Dates/numbers compare on value_num (dates are epoch ms). List elements are one row each (position).',
        "Project frontmatter via json_extract(n.frontmatter_json, '$.key'). ctime/mtime are epoch ms.",
      ],
      noteCount,
      distinctKeys: keys,
    };
  }

  getParameterSchema(): JSONSchema {
    const schema: JSONSchema = {
      type: 'object',
      title: 'Query Notes',
      description:
        'Run a read-only SQL SELECT over the notes index. Tables: notes(n) with columns ' +
        '(id, path, basename, folder, ext, title, ctime, mtime, size, tags_json, links_json, frontmatter_json) ' +
        'and note_properties(note_id, key, key_raw, value_text, value_num, value_type, position). ' +
        'Filter arbitrary frontmatter via note_properties (indexed); dates/numbers use value_num (dates = epoch ms); ' +
        "project values via json_extract(frontmatter_json, '$.key'). Only a single SELECT/WITH is allowed. " +
        'Pass describe=true to see live columns + the distinct property keys present.',
      properties: {
        sql: {
          type: 'string',
          description: 'A single read-only SELECT/WITH statement. Example: "SELECT path, json_extract(frontmatter_json,\'$.status\') AS status FROM notes LIMIT 20".',
        },
        params: {
          type: 'array',
          items: {},
          description: 'Optional positional bind values for ? placeholders.',
        },
        maxRows: {
          type: 'number',
          description: `Max rows to return (default ${DEFAULT_MAX_ROWS}, hard cap ${HARD_MAX_ROWS}).`,
          minimum: 1,
          maximum: HARD_MAX_ROWS,
        },
        describe: {
          type: 'boolean',
          description: 'Return the index schema + distinct frontmatter keys instead of running sql.',
        },
      },
      // `sql` is intentionally NOT required: required→positional in the CLI, and a
      // SQL blob reads better as a flag. Presence is enforced in execute().
      required: [],
    };
    return this.getMergedSchema(schema);
  }
}

function clampRows(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) {
    return DEFAULT_MAX_ROWS;
  }
  return Math.min(Math.floor(value), HARD_MAX_ROWS);
}

/** Allow exactly one leading SELECT/WITH statement with no write/DDL/PRAGMA keywords. */
export function assertReadOnlySelect(sql: string): { ok: true } | { ok: false; error: string } {
  // Strip string literals, quoted identifiers, and comments BEFORE the structural
  // checks so a value or alias (e.g. `status = 'delete'`, `-- delete old`) is not
  // mistaken for a write keyword — while `WITH x AS (...) DELETE ...` (keyword
  // outside any literal) is still caught.
  const stripped = sql
    .replace(/'(?:''|[^'])*'/g, "''")
    .replace(/"(?:""|[^"])*"/g, '""')
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ');
  // Strip a single trailing semicolon, then reject any further statement separator.
  const normalized = stripped.replace(/;\s*$/, '').trim();
  if (normalized.includes(';')) {
    return { ok: false, error: 'Only a single SQL statement is allowed.' };
  }
  if (!/^(select|with)\b/i.test(normalized)) {
    return { ok: false, error: 'Only read-only SELECT/WITH queries are allowed.' };
  }
  if (FORBIDDEN.test(normalized)) {
    return { ok: false, error: 'Query contains a disallowed keyword; only read-only SELECT/WITH is permitted.' };
  }
  return { ok: true };
}
