/**
 * Parse a JSON value stored in a SQLite column.
 *
 * On parse failure this logs a warning tagged with `context` — so a corrupt
 * column becomes observable instead of silently nulling a field — and returns
 * undefined. Callers tolerate the missing value rather than failing the whole
 * row read, which is the right behavior for a rebuildable cache: one bad row
 * should not abort a query, but it should not vanish without a trace either.
 */
export function parseJsonColumn<T>(json: string | null | undefined, context: string): T | undefined {
  if (json === null || json === undefined || json === '') {
    return undefined;
  }
  try {
    return JSON.parse(json) as T;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[parseJsonColumn:${context}] Failed to parse JSON column: ${message}`);
    return undefined;
  }
}
