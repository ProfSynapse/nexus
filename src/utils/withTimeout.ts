/**
 * Location: src/utils/withTimeout.ts
 *
 * Purpose: Bound a promise that may never settle, without turning slowness
 * into an error. Used where a stalled storage layer must degrade a feature
 * rather than hang the caller.
 *
 * Uses window timers for Obsidian popout-window compatibility.
 */

/**
 * Resolve `promise`, or `fallback` if it has not settled within `timeoutMs`.
 *
 * A rejection propagates — only slowness is absorbed here, so genuine errors
 * still surface to the caller.
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  fallback: T
): Promise<T> {
  let timer: number | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>(resolve => {
        timer = window.setTimeout(() => resolve(fallback), timeoutMs);
      })
    ]);
  } finally {
    if (timer !== undefined) window.clearTimeout(timer);
  }
}
