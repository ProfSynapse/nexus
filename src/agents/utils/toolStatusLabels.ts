import type { ToolStatusTense } from '../interfaces/ITool';

/**
 * Shared helpers for tool-colocated `getStatusLabel` implementations.
 *
 * Goal: keep overrides 2-5 lines each. Each override picks the helper
 * that matches its grammar and passes verb strings + parameter keys.
 * No more duplicating the present/past/failed ternary in every file.
 */

export type ToolStatusVerbs = {
  present: string;
  past: string;
  failed: string;
};

export function verbs(present: string, past: string, failed: string): ToolStatusVerbs {
  return { present, past, failed };
}

function getStringParam(
  params: Record<string, unknown> | undefined,
  keys: readonly string[]
): string | undefined {
  if (!params) return undefined;
  for (const key of keys) {
    const value = params[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function basename(value: string): string {
  const parts = value.split(/[\\/]/);
  const last = parts[parts.length - 1]?.trim();
  return last && last.length > 0 ? last : value.trim();
}

/**
 * `<verb> <basename>` — e.g. "Reading foo.md", "Moved bar.md".
 * Used by single-target file operations.
 */
export function labelFileOp(
  v: ToolStatusVerbs,
  params: Record<string, unknown> | undefined,
  tense: ToolStatusTense,
  opts: { keys: readonly string[]; fallback?: string } = { keys: ['path', 'filePath', 'file', 'filename'] }
): string {
  const raw = getStringParam(params, opts.keys);
  const target = raw ? basename(raw) : opts.fallback ?? 'file';
  return `${v[tense]} ${target}`;
}

/**
 * `<verb> <source> to <destination>` — used by move/copy.
 */
export function labelFileMove(
  v: ToolStatusVerbs,
  params: Record<string, unknown> | undefined,
  tense: ToolStatusTense,
  opts: {
    sourceKeys: readonly string[];
    destKeys: readonly string[];
    sourceFallback?: string;
    destFallback?: string;
  }
): string {
  const sourceRaw = getStringParam(params, opts.sourceKeys);
  const destRaw = getStringParam(params, opts.destKeys);
  const source = sourceRaw ? basename(sourceRaw) : opts.sourceFallback ?? 'item';
  const dest = destRaw ? basename(destRaw) : opts.destFallback ?? 'destination';
  return `${v[tense]} ${source} to ${dest}`;
}

/**
 * `<verb> [for "<query>"]` — used by searches. The "for <query>" suffix
 * is omitted when the query is absent so the label degrades gracefully.
 */
export function labelQuery(
  v: ToolStatusVerbs,
  params: Record<string, unknown> | undefined,
  tense: ToolStatusTense,
  queryKeys: readonly string[] = ['query', 'text', 'term']
): string {
  const query = getStringParam(params, queryKeys);
  return query ? `${v[tense]} for "${query}"` : v[tense];
}

/**
 * `<verb> "<name>"` — used by create-ish actions where the user-visible
 * payload is a title (task name, prompt name, workspace name).
 */
export function labelNamed(
  v: ToolStatusVerbs,
  params: Record<string, unknown> | undefined,
  tense: ToolStatusTense,
  nameKeys: readonly string[]
): string {
  const name = getStringParam(params, nameKeys);
  return name ? `${v[tense]} "${name}"` : v[tense];
}

/**
 * `<verb> <id>` — used by mutate-by-id actions (update/archive/delete).
 * The id is rendered raw (no quoting, no basename stripping) because ids
 * are opaque tokens.
 */
export function labelWithId(
  v: ToolStatusVerbs,
  params: Record<string, unknown> | undefined,
  tense: ToolStatusTense,
  opts: { keys: readonly string[]; fallback: string }
): string {
  const id = getStringParam(params, opts.keys) ?? opts.fallback;
  return `${v[tense]} ${id}`;
}

/**
 * `<verb> <url>` — used by web tools. URL is rendered raw.
 */
export function labelWithUrl(
  v: ToolStatusVerbs,
  params: Record<string, unknown> | undefined,
  tense: ToolStatusTense,
  fallback = 'page'
): string {
  const url = getStringParam(params, ['url', 'link', 'address']);
  return url ? `${v[tense]} ${url}` : `${v[tense]} ${fallback}`;
}
