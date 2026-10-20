/**
 * Bounding very large chat tool results.
 *
 * A chat that reads a 3 MB note stores a 3 MB tool result, and replays it to
 * the model on every later turn. Results up to `MAX_STORED_TOOL_RESULT_BYTES`
 * are kept exactly. Above that, the oversized strings keep their first and
 * last `TRIMMED_KEEP_BYTES`, with a marker saying how much was dropped, so a
 * result still reads naturally to the model and to the tool bubble. The turn
 * that requested the result still receives it in full; this applies to what
 * is stored and replayed afterwards.
 *
 * Pure and deterministic (devices must agree on the stored value). Mobile-safe.
 */

export const MAX_STORED_TOOL_RESULT_BYTES = 256 * 1024;
export const TRIMMED_KEEP_BYTES = 64 * 1024;

const TEXT_ENCODER = new TextEncoder();

function sizeOf(value: string): number {
  // UTF-8 is 1–3 bytes per UTF-16 code unit; only encode when it matters.
  if (value.length > MAX_STORED_TOOL_RESULT_BYTES || value.length * 3 <= MAX_STORED_TOOL_RESULT_BYTES) {
    return value.length;
  }
  return TEXT_ENCODER.encode(value).byteLength;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/** Slice at `end`, stepping back if that would split a surrogate pair. */
function safeHead(value: string, end: number): string {
  const code = value.charCodeAt(end - 1);
  return value.slice(0, code >= 0xd800 && code <= 0xdbff ? end - 1 : end);
}

function safeTail(value: string, start: number): string {
  const code = value.charCodeAt(start);
  return value.slice(code >= 0xdc00 && code <= 0xdfff ? start + 1 : start);
}

/** A string trimmed to its head and tail, with a marker. Unchanged if already small. */
export function trimLongString(value: string, keep: number = TRIMMED_KEEP_BYTES): string {
  if (value.length <= keep * 2 + 512) {
    return value;
  }
  const total = TEXT_ENCODER.encode(value).byteLength;
  const head = safeHead(value, keep);
  const tail = safeTail(value, value.length - keep);
  const dropped = total - TEXT_ENCODER.encode(head).byteLength - TEXT_ENCODER.encode(tail).byteLength;
  return `${head}\n\n[Nexus trimmed this tool result: ${formatBytes(total)} in total; the middle ${formatBytes(dropped)} was dropped, the first and last ${formatBytes(keep)} are kept.]\n\n${tail}`;
}

interface StringLeaf {
  path: Array<string | number>;
  length: number;
}

function collectLongStrings(value: unknown, path: Array<string | number>, out: StringLeaf[]): void {
  if (typeof value === 'string') {
    if (value.length > TRIMMED_KEEP_BYTES * 2 + 512) out.push({ path, length: value.length });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((child, index) => collectLongStrings(child, [...path, index], out));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      collectLongStrings(child, [...path, key], out);
    }
  }
}

function replaceLeaf(root: unknown, path: Array<string | number>, transform: (leaf: string) => string): unknown {
  if (path.length === 0) return transform(root as string);
  const [head, ...rest] = path;
  if (Array.isArray(root)) {
    const copy = [...(root as unknown[])];
    copy[head as number] = replaceLeaf(copy[head as number], rest, transform);
    return copy;
  }
  const record = root as Record<string, unknown>;
  return { ...record, [head]: replaceLeaf(record[head as string], rest, transform) };
}

/**
 * The value to store for a tool result. Returns the same reference when the
 * result is within bounds, so ordinary results cost one serialization.
 */
export function trimToolResultForStorage<T>(result: T): T | string {
  if (result === undefined || result === null) return result;

  if (typeof result === 'string') {
    return sizeOf(result) > MAX_STORED_TOOL_RESULT_BYTES ? trimLongString(result) : result;
  }

  const serialized = JSON.stringify(result);
  if (serialized === undefined || sizeOf(serialized) <= MAX_STORED_TOOL_RESULT_BYTES) {
    return result;
  }

  // Keep the structure (success flags, paths, ids) and trim the long strings,
  // largest first, until the whole result fits.
  const leaves: StringLeaf[] = [];
  collectLongStrings(result, [], leaves);
  leaves.sort((a, b) => b.length - a.length || JSON.stringify(a.path).localeCompare(JSON.stringify(b.path)));

  let current: unknown = result;
  for (const leaf of leaves) {
    current = replaceLeaf(current, leaf.path, trimLongString);
    if (sizeOf(JSON.stringify(current)) <= MAX_STORED_TOOL_RESULT_BYTES) {
      return current as T;
    }
  }

  // Too many medium values to fit any other way: keep the head and tail of
  // the serialized result.
  return trimLongString(JSON.stringify(current));
}
