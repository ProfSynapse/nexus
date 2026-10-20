/**
 * TraceMetadataCompactor — keeps activity-trace metadata small by construction.
 *
 * A trace is an activity log: which tool ran, why, on what, and whether it
 * worked. It is not a second copy of the vault. Under the CLI-first contract a
 * `content write --content-file big.json` arrives as ONE command string with
 * the whole file spliced in, and that string used to be stored verbatim — one
 * 3.6 MB note became a 3.6 MB trace, and a record bigger than the shard cap
 * became an oversized shard. Pre-5.x traces also kept whole tool results.
 *
 * This module replaces every oversized value with a short marker string and
 * records what was removed (size, hash, preview) under `metadata.compaction`.
 * Markers are strings, so every reader that expects a string still gets one,
 * and a compacted `tool` command still tokenizes to the same verb and flags.
 *
 * The output is a pure function of the input — no clock, no device id — so
 * two devices compacting the same event produce identical bytes. The
 * migration that rewrites old shards depends on that.
 *
 * Mobile-safe: no Node built-ins; hashing uses Web Crypto with an FNV-1a
 * fallback.
 */

import { fnv1aHex } from '../skills/skillHash';

/** Any single string value larger than this is replaced by a marker. */
export const MAX_TRACE_VALUE_BYTES = 2 * 1024;

/** The serialized metadata is brought under this budget, whatever its shape. */
export const MAX_TRACE_METADATA_BYTES = 16 * 1024;

/** Keys whose values are tool results; never meant to be kept in a trace. */
const RESULT_KEYS = new Set(['result']);

const PREVIEW_CODE_POINTS = 200;
const MARKER_HASH_CHARS = 12;
const MAX_BUDGET_PASSES = 64;
/** Room a marker string takes once serialized, with margin. */
const MARKER_ALLOWANCE = 96;

const TEXT_ENCODER = new TextEncoder();

export interface OmittedTraceValue {
  /** Where the value lived, e.g. `input.arguments.tool#0:--content`, `legacy.result`. */
  path: string;
  /** UTF-8 length of the original value (its JSON form for non-strings). */
  bytes: number;
  /** `sha256:<hex>` of the original UTF-8 bytes, or `fnv1a:<hex>` without Web Crypto. */
  hash: string;
  /** First code points of the original, whitespace collapsed. */
  preview: string;
}

export interface TraceCompactionRecord {
  version: 1;
  originalBytes: number;
  omitted: OmittedTraceValue[];
}

export interface TraceCompactionOptions {
  maxValueBytes?: number;
  maxMetadataBytes?: number;
}

export interface TraceCompactionResult {
  /** The metadata to store; the input object itself when nothing changed. */
  metadata: unknown;
  /** `JSON.stringify(metadata)`, computed once so callers never serialize twice. */
  json: string;
  changed: boolean;
}

export function utf8ByteLength(value: string): number {
  return TEXT_ENCODER.encode(value).byteLength;
}

function exceeds(value: string, limit: number): boolean {
  // Cheap bounds first: UTF-8 is between 1 and 3 bytes per UTF-16 code unit.
  if (value.length > limit) return true;
  if (value.length * 3 <= limit) return false;
  return utf8ByteLength(value) > limit;
}

async function hashValue(value: string, encoded: Uint8Array<ArrayBuffer> = TEXT_ENCODER.encode(value)): Promise<string> {
  const subtle = typeof crypto !== 'undefined' ? crypto.subtle : undefined;
  if (subtle) {
    try {
      const digest = await subtle.digest('SHA-256', encoded);
      return `sha256:${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')}`;
    } catch {
      // Fall through to the deterministic fallback.
    }
  }
  return `fnv1a:${fnv1aHex(value)}`;
}

function buildPreview(value: string): string {
  return Array.from(value.slice(0, PREVIEW_CODE_POINTS * 2))
    .slice(0, PREVIEW_CODE_POINTS)
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function markerFor(omitted: OmittedTraceValue): string {
  const shortHash = omitted.hash.slice(0, omitted.hash.indexOf(':') + 1 + MARKER_HASH_CHARS);
  return `<omitted ${formatBytes(omitted.bytes)} ${shortHash}>`;
}

const BACKSLASH = 0x5c;
const DOUBLE_QUOTE = 0x22;
const SINGLE_QUOTE = 0x27;
const COMMA = 0x2c;
const UNICODE_WHITESPACE = /\s/;

function isWhitespace(value: string, index: number): boolean {
  const code = value.charCodeAt(index);
  if (code === 0x20 || (code >= 0x09 && code <= 0x0d)) return true;
  return code > 0x7f && UNICODE_WHITESPACE.test(value[index]);
}

/**
 * Index of the quote that closes a run opened just before `from`, or -1.
 * A quote preceded by an odd number of backslashes is escaped, which is what
 * the tokenizer's sequential escape flag amounts to.
 */
function findClosingQuote(value: string, from: number, quote: string): number {
  let searchFrom = from;
  for (;;) {
    const candidate = value.indexOf(quote, searchFrom);
    if (candidate < 0) return -1;
    let backslashes = 0;
    for (let probe = candidate - 1; probe >= from && value.charCodeAt(probe) === BACKSLASH; probe -= 1) {
      backslashes += 1;
    }
    if (backslashes % 2 === 0) return candidate;
    searchFrom = candidate + 1;
  }
}

/**
 * An escape introducer (an odd-length backslash run) followed by a character
 * JSON reads differently. No lookbehind: older iOS WebKit rejects it at parse
 * time, which would stop the plugin loading on those phones.
 */
const JSON_INCOMPATIBLE_ESCAPE = /(?:^|[^\\])(?:\\\\)*\\[^\\"nrtu]/;
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL_CHARACTERS = /[\u0000-\u001f]/g;

function escapeControlCharacter(character: string): string {
  return `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`;
}

/**
 * Same result as the tokenizer's `unescapeQuotedContent`, but jumping between
 * backslashes with `indexOf` and joining chunks, so a multi-MB payload does
 * not pay a callback per escape.
 */
function unescapeCliValue(raw: string): string {
  let backslash = raw.indexOf('\\');
  if (backslash < 0) return raw;

  // Fast path: when every escape is one JSON reads the same way (the only
  // ones the CLI emits), the native parser does the whole string at once.
  // `\b`, `\f`, `\/` and `\'` mean something else to JSON, so they take the
  // exact loop below, as does anything JSON rejects.
  if (!JSON_INCOMPATIBLE_ESCAPE.test(raw)) {
    try {
      return JSON.parse(`"${raw.replace(CONTROL_CHARACTERS, escapeControlCharacter)}"`) as string;
    } catch {
      // Fall through to the exact loop.
    }
  }

  const chunks: string[] = [];
  let cursor = 0;
  while (backslash >= 0 && backslash + 1 < raw.length) {
    chunks.push(raw.slice(cursor, backslash));
    const next = raw[backslash + 1];
    let consumed = 2;
    if (next === 'u' && /^[0-9a-fA-F]{4}$/.test(raw.slice(backslash + 2, backslash + 6))) {
      chunks.push(String.fromCodePoint(Number.parseInt(raw.slice(backslash + 2, backslash + 6), 16)));
      consumed = 6;
    } else if (next === 'n') {
      chunks.push('\n');
    } else if (next === 'r') {
      chunks.push('\r');
    } else if (next === 't') {
      chunks.push('\t');
    } else {
      chunks.push(next);
    }
    cursor = backslash + consumed;
    backslash = raw.indexOf('\\', cursor);
  }
  chunks.push(raw.slice(cursor));
  return chunks.join('');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

class CompactionRun {
  readonly omitted: OmittedTraceValue[] = [];

  constructor(
    private readonly maxValueBytes: number,
    private readonly maxMetadataBytes: number
  ) {}

  private async omit(path: string, original: string): Promise<string> {
    const encoded = TEXT_ENCODER.encode(original);
    const entry: OmittedTraceValue = {
      path,
      bytes: encoded.byteLength,
      hash: await hashValue(original, encoded),
      preview: buildPreview(original)
    };
    this.omitted.push(entry);
    return markerFor(entry);
  }

  /** Walk the value, replacing oversized strings and oversized result subtrees. */
  async compactValue(value: unknown, path: string, key: string | null): Promise<unknown> {
    if (typeof value === 'string') {
      if (!exceeds(value, this.maxValueBytes)) return value;
      return key === 'tool' ? this.compactCommand(value, path) : this.omit(path, value);
    }

    if (Array.isArray(value)) {
      const out: unknown[] = [];
      for (let index = 0; index < value.length; index += 1) {
        out.push(await this.compactValue(value[index], `${path}[${index}]`, null));
      }
      return out;
    }

    if (isPlainObject(value)) {
      const out: Record<string, unknown> = {};
      for (const [childKey, child] of Object.entries(value)) {
        const childPath = path ? `${path}.${childKey}` : childKey;
        if (RESULT_KEYS.has(childKey) && child !== undefined && child !== null && typeof child !== 'string') {
          const serialized = JSON.stringify(child) ?? '';
          out[childKey] = exceeds(serialized, this.maxValueBytes)
            ? await this.omit(childPath, serialized)
            : await this.compactValue(child, childPath, childKey);
          continue;
        }
        out[childKey] = await this.compactValue(child, childPath, childKey);
      }
      return out;
    }

    return value;
  }

  /**
   * Compact a `useTools` command string while keeping it parseable.
   *
   * One pass over the string, with the same quoting and escaping rules as
   * `tokenizeWithMeta` and the same separator rule as `splitTopLevelSegments`.
   * Only an oversized quoted run (`"..."`) or bare run is replaced; every
   * other character is kept exactly. Quoted runs are skipped with `indexOf`,
   * so a multi-MB payload costs milliseconds; the character-at-a-time
   * tokenizer would take over a second on it.
   */
  private async compactCommand(command: string, path: string): Promise<string> {
    const replacements: Array<{ start: number; end: number; text: string }> = [];
    const length = command.length;
    let segment = 0;
    let tokenStart = -1;
    let tokenHasQuote = false;
    let bareStart = -1;
    let previousToken: string | null = null;

    const labelFor = (): string =>
      previousToken !== null && previousToken.startsWith('--') ? previousToken : 'arg';

    const replaceRun = async (start: number, end: number, rawValue: string): Promise<void> => {
      const value = unescapeCliValue(rawValue);
      const marker = await this.omit(`${path}#${segment}:${labelFor()}`, value);
      replacements.push({ start, end, text: `"${marker}"` });
    };

    const closeBare = async (at: number): Promise<void> => {
      if (bareStart >= 0 && exceeds(command.slice(bareStart, at), this.maxValueBytes)) {
        await replaceRun(bareStart, at, command.slice(bareStart, at));
      }
      bareStart = -1;
    };

    const endToken = (at: number): void => {
      if (tokenStart >= 0) {
        const text = command.slice(tokenStart, at);
        previousToken = !tokenHasQuote && text.length <= 64 ? text : null;
      }
      tokenStart = -1;
      tokenHasQuote = false;
    };

    let index = 0;
    while (index < length) {
      const code = command.charCodeAt(index);

      if (code === BACKSLASH) {
        if (tokenStart < 0) tokenStart = index;
        if (bareStart < 0) bareStart = index;
        index += 2;
        continue;
      }

      if (code === DOUBLE_QUOTE || code === SINGLE_QUOTE) {
        if (tokenStart < 0) tokenStart = index;
        await closeBare(index);
        tokenHasQuote = true;
        const close = findClosingQuote(command, index + 1, code === DOUBLE_QUOTE ? '"' : '\'');
        const innerEnd = close < 0 ? length : close;
        const inner = command.slice(index + 1, innerEnd);
        if (close < 0 || exceeds(inner, this.maxValueBytes)) {
          // An unclosed quote is replaced too, which leaves the command parseable.
          await replaceRun(index, close < 0 ? length : close + 1, inner);
        }
        index = close < 0 ? length : close + 1;
        continue;
      }

      if (isWhitespace(command, index)) {
        await closeBare(index);
        endToken(index);
        index += 1;
        continue;
      }

      if (code === COMMA && (index + 1 >= length || isWhitespace(command, index + 1))) {
        await closeBare(index);
        endToken(index);
        segment += 1;
        index += 1;
        continue;
      }

      if (tokenStart < 0) tokenStart = index;
      if (bareStart < 0) bareStart = index;
      index += 1;
    }
    await closeBare(Math.min(index, length));

    if (replacements.length === 0) {
      // Large only in aggregate; the record budget deals with it.
      return command;
    }

    let out = '';
    let cursor = 0;
    for (const replacement of replacements) {
      out += command.slice(cursor, replacement.start) + replacement.text;
      cursor = replacement.end;
    }
    return out + command.slice(cursor);
  }

  /**
   * Bring the record under the metadata budget. Each pass replaces the
   * smallest node that removes enough on its own, or the largest node when
   * none does, so as much of the trace survives as possible. Ties break on
   * path, so the outcome is deterministic.
   */
  async enforceBudget(metadata: Record<string, unknown>): Promise<Record<string, unknown>> {
    let current = metadata;
    for (let pass = 0; pass < MAX_BUDGET_PASSES; pass += 1) {
      const json = JSON.stringify(current);
      if (!exceeds(json, this.maxMetadataBytes)) return current;

      const excess = json.length - this.maxMetadataBytes;
      const candidate = pickReplaceable(current, excess);
      if (!candidate) break;
      const serialized = typeof candidate.value === 'string' ? candidate.value : JSON.stringify(candidate.value);
      const marker = await this.omit(candidate.path, serialized);
      current = replaceAt(current, candidate.segments, marker);
    }

    if (!exceeds(JSON.stringify(current), this.maxMetadataBytes)) return current;
    return envelopeOf(current);
  }
}

interface Candidate {
  path: string;
  segments: Array<string | number>;
  value: unknown;
  size: number;
}

/** Top-level keys that identify the trace and are never replaced wholesale. */
const PROTECTED_TOP_LEVEL = new Set(['schemaVersion', 'tool', 'context', 'compaction']);

function pickReplaceable(metadata: Record<string, unknown>, excess: number): Candidate | null {
  const candidates: Candidate[] = [];

  const visit = (value: unknown, segments: Array<string | number>): void => {
    if (segments.length === 1 && PROTECTED_TOP_LEVEL.has(String(segments[0]))) return;
    if (segments.length === 2 && segments[0] === 'outcome' && segments[1] === 'success') return;

    if (segments.length > 0) {
      const size = typeof value === 'string' ? value.length : (JSON.stringify(value) ?? '').length;
      // Replacing something no bigger than its marker cannot help.
      if (size > MARKER_ALLOWANCE) {
        const path = segments
          .map(segment => (typeof segment === 'number' ? `[${segment}]` : segment))
          .join('.')
          .replace(/\.\[/g, '[');
        candidates.push({ path, segments: [...segments], value, size });
      }
    }

    if (Array.isArray(value)) {
      value.forEach((child, index) => visit(child, [...segments, index]));
    } else if (isPlainObject(value)) {
      for (const [key, child] of Object.entries(value)) visit(child, [...segments, key]);
    }
  };

  visit(metadata, []);
  if (candidates.length === 0) return null;

  const byPath = (a: Candidate, b: Candidate): number => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const sufficient = candidates.filter(candidate => candidate.size - MARKER_ALLOWANCE >= excess);
  if (sufficient.length > 0) {
    return sufficient.sort((a, b) => a.size - b.size || byPath(a, b))[0];
  }
  return candidates.sort((a, b) => b.size - a.size || byPath(a, b))[0];
}

function replaceAt(root: Record<string, unknown>, segments: Array<string | number>, replacement: unknown): Record<string, unknown> {
  const clone = (node: unknown, depth: number): unknown => {
    if (depth === segments.length) return replacement;
    const segment = segments[depth];
    if (Array.isArray(node)) {
      const copy: unknown[] = [...(node as unknown[])];
      copy[segment as number] = clone(node[segment as number], depth + 1);
      return copy;
    }
    const record = node as Record<string, unknown>;
    return { ...record, [segment]: clone(record[segment as string], depth + 1) };
  };
  return clone(root, 0) as Record<string, unknown>;
}

/** Last resort: identity, why, and outcome only. */
function envelopeOf(metadata: Record<string, unknown>): Record<string, unknown> {
  const outcome = isPlainObject(metadata.outcome) ? metadata.outcome : {};
  const input = isPlainObject(metadata.input) ? metadata.input : {};
  const files = Array.isArray(input.files) ? input.files.slice(0, 20) : undefined;
  return {
    ...(metadata.schemaVersion !== undefined ? { schemaVersion: metadata.schemaVersion } : {}),
    ...(metadata.tool !== undefined ? { tool: metadata.tool } : {}),
    ...(metadata.context !== undefined ? { context: metadata.context } : {}),
    outcome: { success: outcome.success },
    ...(files ? { input: { files } } : {}),
    ...(metadata.compaction !== undefined ? { compaction: metadata.compaction } : {})
  };
}

/**
 * Compact trace metadata. Returns the input unchanged (same object) when it is
 * already within bounds, so ordinary traces cost one serialization.
 */
export async function compactTraceMetadata(
  metadata: unknown,
  options: TraceCompactionOptions = {}
): Promise<TraceCompactionResult> {
  const maxValueBytes = options.maxValueBytes ?? MAX_TRACE_VALUE_BYTES;
  const maxMetadataBytes = options.maxMetadataBytes ?? MAX_TRACE_METADATA_BYTES;

  const json = JSON.stringify(metadata) ?? 'null';
  if (!exceeds(json, maxValueBytes)) {
    return { metadata, json, changed: false };
  }

  const run = new CompactionRun(maxValueBytes, maxMetadataBytes);
  let compacted = await run.compactValue(metadata, '', null);

  if (isPlainObject(compacted)) {
    compacted = await run.enforceBudget(compacted);
  }

  if (run.omitted.length === 0) {
    return { metadata, json, changed: false };
  }

  const record: TraceCompactionRecord = {
    version: 1,
    originalBytes: utf8ByteLength(json),
    omitted: run.omitted
  };
  const withRecord = isPlainObject(compacted)
    ? { ...compacted, compaction: record }
    : { value: compacted, compaction: record };

  return { metadata: withRecord, json: JSON.stringify(withRecord), changed: true };
}

/**
 * Compact an already-serialized `metadataJson` column value. Strings that are
 * already within bounds are returned as-is without parsing.
 *
 * `maxParseBytes` bounds how large a string this will parse (mobile replay
 * must not parse a 60 MB record); above it the record is reduced to a
 * compaction stub that keeps only the size and hash.
 */
export async function compactTraceMetadataJson(
  metadataJson: string | null | undefined,
  options: TraceCompactionOptions & { maxParseBytes?: number } = {}
): Promise<string | null | undefined> {
  if (metadataJson === null || metadataJson === undefined) return metadataJson;
  const maxValueBytes = options.maxValueBytes ?? MAX_TRACE_VALUE_BYTES;
  if (!exceeds(metadataJson, maxValueBytes)) return metadataJson;

  if (options.maxParseBytes !== undefined && metadataJson.length > options.maxParseBytes) {
    const stub: TraceCompactionRecord = {
      version: 1,
      originalBytes: utf8ByteLength(metadataJson),
      omitted: [{
        path: '',
        bytes: utf8ByteLength(metadataJson),
        hash: await hashValue(metadataJson),
        preview: buildPreview(metadataJson)
      }]
    };
    return JSON.stringify({ compaction: stub });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(metadataJson);
  } catch {
    return metadataJson;
  }
  const result = await compactTraceMetadata(parsed, options);
  return result.changed ? result.json : metadataJson;
}
