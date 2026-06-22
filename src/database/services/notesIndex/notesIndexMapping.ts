/**
 * notesIndexMapping — pure coercion + hashing for the notes query index.
 *
 * Located at: src/database/services/notesIndex/notesIndexMapping.ts
 * No Obsidian / SQLite imports — just the typed transform from raw frontmatter
 * values into `note_properties` rows, plus a stable change-detection hash. Kept
 * pure so it is exhaustively unit-testable in isolation (this is the main
 * correctness surface now that there is no query-time formula evaluator — see
 * docs/plans/notes-query-index-plan.md §5 / §11).
 *
 * Mobile-safe: no Node `crypto`, no top-level npm deps.
 */

/** A single `note_properties` row, sans the `note_id` FK (filled in by the service). */
export interface NotePropertyRow {
  /** Lowercased key for matching. */
  key: string;
  /** Original-case key. */
  keyRaw: string;
  /** Normalized string form — drives `=`, `contains`, sort. */
  valueText: string | null;
  /** Numeric or date-coerced (epoch ms) value, else null — drives `<`/`>`/range. */
  valueNum: number | null;
  /** 'string' | 'number' | 'boolean' | 'date' | 'list' | 'object' | 'null'. */
  valueType: NotePropertyType;
  /** List-element index when the source value was an array, else null. */
  position: number | null;
}

export type NotePropertyType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'date'
  | 'list'
  | 'object'
  | 'null';

/** ISO-8601 date / datetime, e.g. `2026-06-21` or `2026-06-21T09:30:00`. */
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

/** FNV-1a (32-bit) hex hash. Mobile-safe (no Node crypto). Mirrors skillHash. */
export function fnv1aHex(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * Stable change-detection hash over the indexed surface of a note: its
 * frontmatter (key-sorted so ordering noise doesn't churn the hash) plus the
 * stat fields we store. Used to skip re-indexing unchanged notes on a re-scan.
 */
export function computeContentHash(
  frontmatter: Record<string, unknown>,
  mtime: number,
  size: number
): string {
  return fnv1aHex(`${stableStringify(frontmatter)}|${mtime}|${size}`);
}

/**
 * Coerce one frontmatter value into the `note_properties` rows it produces.
 * Arrays expand to one row per element (so `list.contains` is an indexed lookup
 * on `value_text`); empty arrays yield a single `list` marker row so existence /
 * `isEmpty` still work; objects are stored as JSON in `value_text`.
 */
export function coerceFrontmatterValue(keyRaw: string, value: unknown): NotePropertyRow[] {
  const key = keyRaw.toLowerCase();

  if (Array.isArray(value)) {
    if (value.length === 0) {
      return [row(key, keyRaw, null, null, 'list', null)];
    }
    return value.map((element, position) => {
      const scalar = coerceScalar(element);
      return row(key, keyRaw, scalar.valueText, scalar.valueNum, scalar.valueType, position);
    });
  }

  const scalar = coerceScalar(value);
  return [row(key, keyRaw, scalar.valueText, scalar.valueNum, scalar.valueType, null)];
}

/** Coerce a single (non-array) value to its text/num/type triple. */
function coerceScalar(value: unknown): Pick<NotePropertyRow, 'valueText' | 'valueNum' | 'valueType'> {
  if (value === null || value === undefined) {
    return { valueText: null, valueNum: null, valueType: 'null' };
  }
  if (typeof value === 'boolean') {
    return { valueText: value ? 'true' : 'false', valueNum: value ? 1 : 0, valueType: 'boolean' };
  }
  if (typeof value === 'number') {
    return { valueText: Number.isFinite(value) ? String(value) : null, valueNum: Number.isFinite(value) ? value : null, valueType: 'number' };
  }
  if (value instanceof Date) {
    const ms = value.getTime();
    return { valueText: Number.isNaN(ms) ? null : value.toISOString(), valueNum: Number.isNaN(ms) ? null : ms, valueType: 'date' };
  }
  if (typeof value === 'string') {
    if (ISO_DATE_RE.test(value)) {
      const ms = Date.parse(value);
      if (!Number.isNaN(ms)) {
        return { valueText: value, valueNum: ms, valueType: 'date' };
      }
    }
    return { valueText: value, valueNum: null, valueType: 'string' };
  }
  // Nested object (or any other type) → JSON blob, queryable via json_extract.
  return { valueText: safeJson(value), valueNum: null, valueType: 'object' };
}

function row(
  key: string,
  keyRaw: string,
  valueText: string | null,
  valueNum: number | null,
  valueType: NotePropertyType,
  position: number | null
): NotePropertyRow {
  return { key, keyRaw, valueText, valueNum, valueType, position };
}

/** JSON.stringify with sorted object keys, so equal content hashes equally. */
function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

function safeJson(value: unknown): string | null {
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}
