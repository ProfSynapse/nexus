/**
 * Turning a Bases `Value` into something that can sit in a JSON tool result.
 *
 * ## Three things here are not negotiable, all learned from the Phase 0 spike
 *
 * 1. **Never call `value.type()`.** The instance-level `type` is a getter that
 *    returns `this.constructor`. Calling it therefore re-invokes the constructor
 *    with `this` bound to the existing value, which overwrites the value IN
 *    PLACE — and `getValue('file.file')` hands back `entry.implicit` itself
 *    rather than a copy, so the damage is to the live query result, not to a
 *    throwaway. The corrupted value still stringifies to something plausible,
 *    which is what makes this a data-integrity bug and not a crash. Nothing in
 *    this file touches `.type` on an instance; the class-level `static type`
 *    string is read off the prototype's constructor, which never invokes it.
 *
 * 2. **Never `JSON.stringify` a `Value`.** `LinkValue` and `FileValue` reach
 *    `app` and are circular, so it throws. `String(value)` is the only safe
 *    universal serialisation — and it is also the *right* one, because
 *    `toString()` is what the user sees in the table. `LinkValue` renders as
 *    `[[bravo]]`, which keeps a returned row actionable.
 *
 * 3. **Never mutate.** `ListValue.get(i)` and `length()` are read-only public
 *    API; nothing else on a `Value` is called.
 *
 * ## Why a type string at all, when `String()` always works
 *
 * A model reading `"priority": 3` can compare it; reading `"priority": "3"` it
 * has to guess whether the quotes are meaningful. Obsidian's own `base:query`
 * CLI stringifies everything, and that loses the distinction between the number
 * 3 and the string "3". So numbers, booleans, nulls and lists are recovered
 * where the type is knowable, and everything else — dates, durations, links,
 * tags, objects, errors — keeps its display string.
 *
 * The type is read as `Object.getPrototypeOf(value).constructor.type`, the
 * `static type: string` that every `Value` subclass declares (public API,
 * `@since 1.10.0`). When that is missing (a minified build that dropped it, a
 * plugin's own `Value` subclass), a structural fallback catches lists and
 * everything else degrades to its display string — never to a wrong type.
 *
 * Those strings are CAPITALISED in the shipped app — `'String'`, `'Number'`,
 * `'Null'`, `'List'`, `'Link'`, `'Date'`, verified against Obsidian 1.13.7 — so
 * they are compared case-insensitively rather than against the lowercase names
 * a reader of the API docs would guess. Getting this wrong is not cosmetic: a
 * property a note does not have comes back as a `NullValue` whose `toString()`
 * is the four characters `null`, so a missed `Null` puts the *string* "null"
 * into a row where the honest answer is an empty cell. `constructor.name` is no
 * help — the app is minified and every `Value` class is named `t`.
 */

import type { Value } from 'obsidian';

/** What a serialised cell may be. Deliberately JSON-safe and shallow. */
export type SerializedValue = string | number | boolean | null | SerializedValue[];

/** Cap on list recursion. Bases lists nest at most shallowly; this is a stop, not a policy. */
const MAX_LIST_DEPTH = 3;

/**
 * `static type` off the prototype chain, lowercased, WITHOUT reading the
 * instance getter.
 *
 * `Object.getPrototypeOf(value).constructor` is the class object; its `type` is
 * the static string ('string', 'number', 'list', …). Reading `value.type`
 * instead would return the constructor and invite the calling footgun above.
 */
function valueTypeName(value: object): string | undefined {
  try {
    const prototype: unknown = Object.getPrototypeOf(value);
    const constructor = (prototype as { constructor?: unknown } | null)?.constructor;
    const staticType = (constructor as { type?: unknown } | undefined)?.type;
    return typeof staticType === 'string' ? staticType.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

/** Read-only duck type for `ListValue`, used only when the type string is unavailable. */
interface ListLike {
  length(): number;
  get(index: number): Value;
}

function asListLike(value: object): ListLike | null {
  const candidate = value as Partial<ListLike>;
  return typeof candidate.length === 'function' && typeof candidate.get === 'function'
    ? (candidate as ListLike)
    : null;
}

function serializeList(list: ListLike, depth: number): SerializedValue[] {
  const out: SerializedValue[] = [];
  let size = 0;
  try {
    size = list.length();
  } catch {
    return out;
  }

  for (let index = 0; index < size; index++) {
    let item: Value | null = null;
    try {
      item = list.get(index);
    } catch {
      item = null;
    }
    out.push(serializeValue(item, depth + 1));
  }
  return out;
}

/**
 * One cell, JSON-safe.
 *
 * Errors are values in Bases (`ErrorValue`), not exceptions, so a broken
 * formula arrives here as an ordinary value and is returned as its message
 * string rather than being swallowed.
 */
export function serializeValue(value: Value | null | undefined, depth = 0): SerializedValue {
  if (value === null || value === undefined) return null;
  // A plain primitive can only arrive from a non-Obsidian caller (a test, a
  // future API that hands back raw values); pass it through rather than
  // stringifying a number that is already a number.
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  const typeName = valueTypeName(value);

  if (typeName === 'null') return null;

  if (typeName === 'list' || (typeName === undefined && asListLike(value))) {
    const list = asListLike(value);
    if (list) {
      return depth >= MAX_LIST_DEPTH ? displayString(value) : serializeList(list, depth);
    }
  }

  const display = displayString(value);

  if (typeName === 'number') {
    const parsed = Number(display);
    return Number.isFinite(parsed) ? parsed : display;
  }

  if (typeName === 'boolean') {
    if (display === 'true') return true;
    if (display === 'false') return false;
    return display;
  }

  // Everything else — string, date, duration, link, tag, file, object, error —
  // keeps the string the user would read in the table.
  return display;
}

/**
 * `toString()` through `String()`, which cannot throw for a well-behaved
 * `Value` but is guarded anyway: a third-party `Value` subclass with a throwing
 * `toString` must degrade one cell, not fail the whole query.
 */
function displayString(value: { toString(): string }): string {
  try {
    // `Value.toString()` is abstract public API, so every real value overrides
    // it — this is never `[object Object]` stringification.
    return String(value);
  } catch {
    return '';
  }
}
