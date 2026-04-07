/**
 * src/utils/desktopRequire.ts
 *
 * Lazy desktop module loader that bypasses ESLint no-require-imports rule.
 * Uses globalThis.require (available in Electron/Node but not on mobile).
 * Used by any file that needs Node.js built-ins at runtime on desktop only.
 */

/**
 * Lazily load a Node.js built-in module at runtime (desktop only).
 * Returns the module or throws if require is unavailable (e.g., on mobile).
 *
 * @param moduleName - The module to require (e.g., 'node:fs', 'node:http')
 */
export function desktopRequire<T>(moduleName: string): T {
  const maybeRequire = (globalThis as typeof globalThis & {
    require?: (moduleId: string) => unknown;
  }).require;

  if (typeof maybeRequire !== 'function') {
    throw new Error(`Cannot load '${moduleName}': desktop module loader is unavailable.`);
  }

  return maybeRequire(moduleName) as T;
}
