/**
 * Desktop module loaders take Node's require from the main window.
 *
 * The plugin runs in the main window, the one window guaranteed to have Node's
 * require. window.activeWindow is whichever window has focus: a popout, or the
 * Settings window (its own window since Obsidian 1.14), which is exactly where
 * OAuth and CLI-provider setup is clicked. Looked up there, require may be
 * missing ("desktop module loader is unavailable"), or hand back a module whose
 * objects (an OAuth callback server, a child process) belong to a window that
 * can close under them.
 *
 * The first test drives the shared loader. The second guards the copies of the
 * same loader that live privately in individual services, which cannot be
 * reached without standing each service up.
 */

import * as fs from 'fs';
import * as path from 'path';
import { desktopRequire } from '../../src/utils/desktopRequire';

describe('desktopRequire', () => {
  it('uses the main window require even while a window without one has focus', () => {
    const testWindow = window as unknown as object;
    const descriptor = Object.getOwnPropertyDescriptor(testWindow, 'activeWindow');
    const mainRequire = jest.fn(() => ({ marker: 'main' }));
    const requireDescriptor = Object.getOwnPropertyDescriptor(testWindow, 'require');
    Object.defineProperty(testWindow, 'require', { configurable: true, writable: true, value: mainRequire });
    // The focused window has no Node require at all.
    Object.defineProperty(testWindow, 'activeWindow', { configurable: true, get: () => ({}) });

    try {
      expect(desktopRequire<{ marker: string }>('node:http')).toEqual({ marker: 'main' });
      expect(mainRequire).toHaveBeenCalledWith('node:http');
    } finally {
      if (descriptor) Object.defineProperty(testWindow, 'activeWindow', descriptor);
      if (requireDescriptor) Object.defineProperty(testWindow, 'require', requireDescriptor);
    }
  });
});

describe('private desktop module loaders', () => {
  function sourceFiles(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return sourceFiles(full);
      return /\.tsx?$/.test(entry.name) ? [full] : [];
    });
  }

  it('none looks require up on window.activeWindow', () => {
    const root = path.resolve(__dirname, '../../src');
    const offenders = sourceFiles(root).filter(file =>
      /activeWindow\s+as\s+Window\s*&\s*\{\s*require\?/.test(fs.readFileSync(file, 'utf8'))
    ).map(file => path.relative(root, file));

    expect(offenders).toEqual([]);
  });
});
