/**
 * src/utils/desktopRequire.ts
 *
 * Lazy desktop module loader that bypasses ESLint no-require-imports rule.
 * Uses the main window's require (available in Electron/Node but not on mobile).
 * Used by any file that needs Node.js built-ins at runtime on desktop only.
 *
 * `window`, never `window.activeWindow`: the plugin runs in the main window,
 * which is the one window guaranteed to have Node's require. activeWindow is
 * whichever window has focus, a popout or the Settings window (its own window
 * since Obsidian 1.14), and a module loaded through it, such as the http server
 * behind an OAuth callback, would belong to a window that can close under it.
 * The desktop module loaders elsewhere in src/ follow the same rule.
 */

/**
 * Lazily load a Node.js built-in module at runtime (desktop only).
 * Returns the module or throws if require is unavailable (e.g., on mobile).
 *
 * @param moduleName - The module to require (e.g., 'node:fs', 'node:http')
 */
export function desktopRequire<T>(moduleName: string): T {
  const maybeRequire = (window as Window & {
    require?: (moduleId: string) => unknown;
  }).require;

  if (typeof maybeRequire !== 'function') {
    throw new Error(`Cannot load '${moduleName}': desktop module loader is unavailable.`);
  }

  return maybeRequire(moduleName) as T;
}
