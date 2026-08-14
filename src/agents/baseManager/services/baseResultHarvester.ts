/**
 * Reading rows out of a live Bases query result.
 *
 * ## Layering
 *
 * This module knows nothing about scratch files, embeds or off-screen
 * containers — it takes a `BasesView` that has data and returns plain JSON. If
 * Obsidian ever exposes a "run this config and give me a result" entry point,
 * `BaseQueryRunner` collapses to one call and this file does not change (plan
 * §7).
 *
 * It also, deliberately, runs in the CURRENT build rather than inside the
 * registered view — the registered view may belong to an older Nexus (see
 * `basesAvailability.ts`), so the less it does, the less can be stale.
 *
 * ## Two behaviours that look like bugs and are not
 *
 * - **`data.properties` collapses to `['file.name']`** when the view declares
 *   no `order`. That is Obsidian reporting "the user has chosen no columns", not
 *   "this base has one column" — Obsidian's own `base:query` CLI returns just
 *   the file name in that case. `analyze` answers the more useful question by
 *   falling back to `view.allProperties`, capped, and says which source it used.
 * - **Summary keys in a view are written bare** (`priority: Sum`), while
 *   `getSummaryValue` wants a `BasesPropertyId` (`note.priority`). Bare names
 *   are frontmatter properties, so they are prefixed with `note.` here.
 */

import type { BasesEntry, BasesPropertyId, BasesView, QueryController } from 'obsidian';
import { serializeValue, SerializedValue } from './baseValueSerializer';

/** One row: property id → serialised cell, plus the file it came from. */
export type HarvestedRow = Record<string, SerializedValue>;

export interface HarvestedGroup {
  /** Display string of the groupBy value, or null for the "no value" group. */
  key: string | null;
  /** Rows in this group before the limit was applied. */
  rowCount: number;
  rows: HarvestedRow[];
}

export interface HarvestedResult {
  properties: string[];
  /** `view` = the columns the base declares; `allProperties` = the fallback below. */
  propertiesSource: 'view' | 'allProperties';
  /** True when the fallback column list was capped. */
  propertiesTruncated: boolean;
  rowCount: number;
  returned: number;
  truncated: boolean;
  grouped: boolean;
  rows?: HarvestedRow[];
  groups?: HarvestedGroup[];
  summaries?: Record<string, Record<string, SerializedValue>>;
}

export interface HarvestOptions {
  /** The source view's `order`, used only to tell "no columns chosen" from "one column chosen". */
  declaredOrder?: string[];
  /** The source view's `summaries` map (property → summary name). */
  declaredSummaries?: Record<string, string>;
  /**
   * Whether the source view declares `groupBy`. Read from the config rather
   * than from the result, because `groupedData` always returns at least one
   * group — an ungrouped base would otherwise come back wrapped in a fake group.
   */
  declaredGroupBy?: boolean;
  /** Maximum rows to serialise across all groups. */
  limit: number;
  /**
   * Path of the scratch file the query is running from, which must not appear in
   * its own results.
   *
   * This is not hygiene, it is correctness: a base that matches files by folder
   * (`file.folder == this.file.folder`) or by extension matches the scratch
   * `.base` sitting next to the source, so without this a caller sees a file
   * that does not exist and a `rowCount` one too high. Excluded from the counts
   * as well as from the rows, so `rowCount` is what the user would see.
   */
  excludePath?: string;
}

/**
 * Ceiling on the fallback column list. A vault-wide base can expose a hundred
 * frontmatter properties, and this output lands in a model's context.
 */
const MAX_FALLBACK_PROPERTIES = 30;

/** PROTOCOL v1 (see basesAvailability.ts): the view carries its controller. */
type AnalyzeView = BasesView & { nexusController?: QueryController };

const PROPERTY_PREFIXES = ['file.', 'note.', 'formula.'];

/** `priority` → `note.priority`; `file.name` and `formula.x` are already ids. */
function toPropertyId(name: string): BasesPropertyId {
  return (PROPERTY_PREFIXES.some(prefix => name.startsWith(prefix)) ? name : `note.${name}`) as BasesPropertyId;
}

function chooseProperties(view: AnalyzeView, declaredOrder?: string[]): {
  properties: string[];
  source: 'view' | 'allProperties';
  truncated: boolean;
} {
  const queryProperties = safeArray(view.data?.properties);
  const declaredAny = Array.isArray(declaredOrder) && declaredOrder.length > 0;

  if (declaredAny && queryProperties.length > 0) {
    return { properties: queryProperties, source: 'view', truncated: false };
  }

  const all = safeArray(view.allProperties);
  if (all.length === 0) {
    return { properties: queryProperties, source: 'view', truncated: false };
  }

  return {
    properties: all.slice(0, MAX_FALLBACK_PROPERTIES),
    source: 'allProperties',
    truncated: all.length > MAX_FALLBACK_PROPERTIES
  };
}

function safeArray<T>(value: T[] | undefined | null): T[] {
  return Array.isArray(value) ? value : [];
}

function withoutScratch(entries: BasesEntry[], excludePath?: string): BasesEntry[] {
  return excludePath ? entries.filter(entry => entry.file?.path !== excludePath) : entries;
}

/**
 * One row. `file.path` is always present and always first: it is what makes a
 * returned row actionable (`content read --path …`), and a base whose columns
 * are all formulas would otherwise identify nothing.
 */
function harvestRow(entry: BasesEntry, properties: string[]): HarvestedRow {
  const row: HarvestedRow = { 'file.path': entry.file?.path ?? null };

  for (const property of properties) {
    if (property === 'file.path') continue;
    let value = null;
    try {
      value = entry.getValue(property as BasesPropertyId);
    } catch {
      value = null;
    }
    row[property] = serializeValue(value);
  }

  return row;
}

/**
 * Everything a caller needs from a view that has just received data.
 *
 * `limit` bounds serialisation, never the query: `rowCount` is the true number
 * of matching rows, so a truncated answer still says how much it left behind.
 */
export function harvestView(view: AnalyzeView, options: HarvestOptions): HarvestedResult {
  const { properties, source, truncated: propertiesTruncated } = chooseProperties(view, options.declaredOrder);
  const limit = Math.max(0, options.limit);

  const entries = withoutScratch(safeArray(view.data?.data), options.excludePath);
  const grouped = options.declaredGroupBy === true && Array.isArray(view.data?.groupedData);

  const result: HarvestedResult = {
    properties,
    propertiesSource: source,
    propertiesTruncated,
    rowCount: entries.length,
    returned: 0,
    truncated: false,
    grouped
  };

  if (grouped) {
    const groups: HarvestedGroup[] = [];
    let budget = limit;

    for (const group of safeArray(view.data?.groupedData)) {
      const groupEntries = withoutScratch(safeArray(group.entries), options.excludePath);
      const take = Math.max(0, Math.min(budget, groupEntries.length));
      groups.push({
        key: group.hasKey?.() ? serializeGroupKey(group.key) : null,
        rowCount: groupEntries.length,
        rows: groupEntries.slice(0, take).map(entry => harvestRow(entry, properties))
      });
      budget -= take;
    }

    result.groups = groups;
    result.returned = groups.reduce((total, group) => total + group.rows.length, 0);
  } else {
    result.rows = entries.slice(0, limit).map(entry => harvestRow(entry, properties));
    result.returned = result.rows.length;
  }

  result.truncated = result.returned < result.rowCount;

  const summaries = harvestSummaries(view, entries, options.declaredSummaries);
  if (summaries) result.summaries = summaries;

  return result;
}

function serializeGroupKey(key: unknown): string | null {
  const serialized = serializeValue(key as never);
  return serialized === null ? null : String(serialized);
}

/**
 * Footer aggregates. `getSummaryValue` is the only public route to them and it
 * needs the `QueryController`, which reaches us through the protocol property
 * on the view. A summary that throws (an unknown function name, a property the
 * summary cannot apply to) is skipped rather than failing the whole call — the
 * rows are the point.
 */
function harvestSummaries(
  view: AnalyzeView,
  entries: BasesEntry[],
  declared: Record<string, string> | undefined
): Record<string, Record<string, SerializedValue>> | undefined {
  const controller = view.nexusController;
  if (!controller || !declared || Object.keys(declared).length === 0) return undefined;
  if (typeof view.data?.getSummaryValue !== 'function') return undefined;

  const out: Record<string, Record<string, SerializedValue>> = {};

  for (const [property, summaryKey] of Object.entries(declared)) {
    if (typeof summaryKey !== 'string' || summaryKey === '') continue;
    const propertyId = toPropertyId(property);
    try {
      const value = view.data.getSummaryValue(controller, entries, propertyId, summaryKey);
      out[propertyId] = { [summaryKey]: serializeValue(value) };
    } catch {
      // A summary Obsidian itself refuses to compute is not an analyze failure.
    }
  }

  return Object.keys(out).length > 0 ? out : undefined;
}
