/**
 * Unit tests for the pinned Pyodide asset manifest. The download/write mechanics
 * require a live network + Electron and are validated separately; here we lock
 * the manifest's shape so a version bump can't silently drop a required wheel.
 */

import {
  buildPyodideAssetManifest,
  PYODIDE_VERSION,
} from '../../src/agents/apps/dataAnalysis/services/PyodideEnsurer';

describe('Pyodide asset manifest', () => {
  const manifest = buildPyodideAssetManifest();
  const files = manifest.map((a) => a.file);

  it('includes the core runtime files', () => {
    for (const core of ['pyodide.js', 'pyodide.asm.js', 'pyodide.asm.wasm', 'python_stdlib.zip', 'pyodide-lock.json']) {
      expect(files).toContain(core);
    }
  });

  it('includes pandas + numpy + their compiled deps', () => {
    expect(files.some((f) => f.startsWith('pandas-'))).toBe(true);
    expect(files.some((f) => f.startsWith('numpy-'))).toBe(true);
    expect(files.some((f) => f.startsWith('python_dateutil-'))).toBe(true);
    expect(files.some((f) => f.startsWith('pytz-'))).toBe(true);
    expect(files.some((f) => f.startsWith('six-'))).toBe(true);
  });

  it('includes micropip + packaging (needed to install the Excel wheels)', () => {
    expect(files.some((f) => f.startsWith('micropip-'))).toBe(true);
    expect(files.some((f) => f.startsWith('packaging-'))).toBe(true);
  });

  it('includes the Excel wheels from PyPI', () => {
    const openpyxl = manifest.find((a) => a.file.startsWith('openpyxl-'));
    const etxml = manifest.find((a) => a.file.startsWith('et_xmlfile-'));
    expect(openpyxl?.url).toContain('files.pythonhosted.org');
    expect(etxml?.url).toContain('files.pythonhosted.org');
  });

  it('pins CDN assets to the declared version', () => {
    const cdn = manifest.filter((a) => a.url.includes('cdn.jsdelivr.net'));
    expect(cdn.length).toBeGreaterThan(0);
    for (const a of cdn) {
      expect(a.url).toContain(`/pyodide/v${PYODIDE_VERSION}/full/`);
      expect(a.url.endsWith(a.file)).toBe(true);
    }
  });

  it('gives every asset a positive size floor and a valid URL', () => {
    for (const a of manifest) {
      expect(a.minBytes).toBeGreaterThan(0);
      expect(a.url).toMatch(/^https:\/\//);
      expect(a.file.length).toBeGreaterThan(0);
    }
  });
});
