/**
 * Unit tests for the vault-path confinement resolver.
 * See src/core/vaultPath.ts and docs/plans/vault-path-confinement-plan.md.
 */

import {
  tryResolveVaultPath,
  resolveVaultPath,
  vaultPathFromTrusted,
  setConfinementConfigDir,
  VaultPathError,
} from '@/core/vaultPath';

// The Obsidian config-dir denylist is injected at startup; register the default
// so the ".obsidian" rejection cases below are exercised (`.git` is unconditional).
beforeAll(() => setConfinementConfigDir('.obsidian'));

describe('vaultPath resolver — rejects escaping paths', () => {
  const escaping: Array<[string, string]> = [
    ['.. alone', '..'],
    ['../ at start', '../secrets.md'],
    ['../../ climb', '../../etc/passwd'],
    ['.. in the middle', 'notes/../../tmp/x.md'],
    ['.. at the end', 'notes/..'],
    ['deep traversal', 'a/b/c/../../../../../tmp/x.md'],
    ['leading ~', '~/escape.md'],
    ['bare ~', '~'],
    ['~user home', '~alice/notes.md'],
    ['Windows drive backslash', 'C:\\Windows\\x.md'],
    ['Windows drive forward slash', 'C:/Windows/x.md'],
    ['UNC path', '\\\\server\\share\\x.md'],
    ['leading backslash', '\\x.md'],
    ['backslash traversal', 'a\\..\\..\\b.md'],
    ['dot segment in middle', 'notes/./secret.md'],
    // Windows strips trailing dots/spaces at the syscall layer, so these reach
    // the filesystem as ".." even though they don't literally equal "..".
    ['Windows dot-dot-space segment', 'a/.. /b.md'],
    ['Windows dot-dot-space climb', 'a/.. /.. /secret.md'],
    ['dots-only segment', 'a/.../b.md'],
    ['dot-space segment', 'a/. /b.md'],
    ['spaces-only segment', 'a/  /b.md'],
    ['dot-dot with trailing dots', 'a/..../b.md'],
    // Control characters (incl. NUL) — never valid, defeat downstream handling.
    ['null byte', 'notes/x\x00.md'],
    ['carriage return', 'notes/x\r.md'],
    // NTFS alternate data stream via interior colon.
    ['ADS colon', 'notes/x.md:hidden'],
    ['bare colon', 'a/b:c.md'],
    // Windows reserved device names (any folder, with/without extension).
    ['reserved NUL', 'NUL'],
    ['reserved NUL.md', 'notes/NUL.md'],
    ['reserved CON lowercase', 'con.txt'],
    ['reserved COM1', 'a/COM1.md'],
    ['reserved LPT9', 'LPT9'],
    ['reserved NUL trailing space', 'notes/NUL. '],
    // Sensitive vault-internal dirs — inside the vault but RCE/config-tamper vectors.
    ['.obsidian plugin write', '.obsidian/plugins/x/main.js'],
    ['.obsidian data.json', '.obsidian/plugins/x/data.json'],
    ['.git hook write', '.git/hooks/post-commit'],
    ['.obsidian case-insensitive', '.Obsidian/x.json'],
    ['.git leading slash', '/.git/config'],
  ];

  it.each(escaping)('rejects %s (%s)', (_label, input) => {
    const result = tryResolveVaultPath(input);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(typeof result.error).toBe('string');
      expect(result.error.length).toBeGreaterThan(0);
    }
  });

  it('rejects non-string and empty/whitespace input', () => {
    // @ts-expect-error — exercising the runtime guard for non-string input
    expect(tryResolveVaultPath(null).ok).toBe(false);
    // @ts-expect-error — exercising the runtime guard for non-string input
    expect(tryResolveVaultPath(42).ok).toBe(false);
    expect(tryResolveVaultPath('').ok).toBe(false);
    expect(tryResolveVaultPath('   ').ok).toBe(false);
  });

  it('gives a traversal-specific error for ".." but a Windows-drive error for "C:\\x"', () => {
    const trav = tryResolveVaultPath('../x.md');
    const drive = tryResolveVaultPath('C:\\x.md');
    expect(trav.ok).toBe(false);
    expect(drive.ok).toBe(false);
    if (!trav.ok) expect(trav.error).toMatch(/\.\./);
    if (!drive.ok) expect(drive.error).toMatch(/absolute/i);
  });

  it('strips a POSIX leading slash to a vault-relative path (backward-compat, still confined)', () => {
    // Leading "/" never escaped the vault (it resolves inside it); preserve the
    // long-standing lenient behavior. The real escape vector ".." stays rejected.
    expect(tryResolveVaultPath('/notes/x.md')).toEqual({ ok: true, path: 'notes/x.md' });
    expect(tryResolveVaultPath('/tmp/ESCAPE.md')).toEqual({ ok: true, path: 'tmp/ESCAPE.md' });
    expect(tryResolveVaultPath('/Users/someone/x.md')).toEqual({ ok: true, path: 'Users/someone/x.md' });
    // ...but a leading slash followed by traversal is still rejected.
    expect(tryResolveVaultPath('/../escape.md').ok).toBe(false);
  });
});

describe('vaultPath resolver — accepts legitimate vault paths (no false positives)', () => {
  const valid: Array<[string, string]> = [
    ['simple note', 'notes/a.md', 'notes/a.md'],
    ['name containing double dots', 'notes/a..b.md', 'notes/a..b.md'],
    ['dotted filename', 'a.b.md', 'a.b.md'],
    ['folder with double dots', 'foo..bar/x.md', 'foo..bar/x.md'],
    ['nested Nexus data', 'Nexus/data/x.md', 'Nexus/data/x.md'],
    ['deep nesting', 'a/b/c/d/e.md', 'a/b/c/d/e.md'],
    ['collapses duplicate slashes', 'a//b.md', 'a/b.md'],
    ['strips trailing slash', 'folder/', 'folder'],
    ['double dots as whole name', '..foo.md', '..foo.md'],
    ['trailing double-dot name', 'a/b..', 'a/b..'],
    ['name with inner space', 'my notes/daily log.md', 'my notes/daily log.md'],
    ['name ending in single dot', 'notes/draft./x.md', 'notes/draft./x.md'],
  ];

  it.each(valid)('accepts %s and canonicalizes to %s', (_label, input, expected) => {
    const result = tryResolveVaultPath(input);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(String(result.path)).toBe(expected);
    }
  });

  it('treats a lone "." as the vault root', () => {
    const result = tryResolveVaultPath('.');
    expect(result.ok).toBe(true);
    if (result.ok) expect(String(result.path)).toBe('');
  });
});

describe('sensitive-dir denylist (config-dir injection)', () => {
  afterAll(() => setConfinementConfigDir('.obsidian')); // restore the suite default

  it('always rejects .git regardless of injected config dir', () => {
    setConfinementConfigDir(null);
    expect(tryResolveVaultPath('.git/hooks/pre-commit').ok).toBe(false);
  });

  it('rejects the injected config dir but allows a note named like the default', () => {
    setConfinementConfigDir('.obsidian');
    expect(tryResolveVaultPath('.obsidian/plugins/x/main.js').ok).toBe(false);
    // A folder that merely shares the prefix is not the config dir — allowed.
    expect(tryResolveVaultPath('.obsidian-notes/x.md').ok).toBe(true);
  });

  it('honors a CUSTOM config dir and then allows .obsidian', () => {
    setConfinementConfigDir('my-config');
    expect(tryResolveVaultPath('my-config/plugins/x/main.js').ok).toBe(false);
    expect(tryResolveVaultPath('.obsidian/x.md').ok).toBe(true); // not the config dir now
  });

  it('leaves trusted paths exempt from the denylist', () => {
    setConfinementConfigDir('.obsidian');
    expect(String(vaultPathFromTrusted('.obsidian/plugins/x/data.json'))).toBe('.obsidian/plugins/x/data.json');
  });
});

describe('resolveVaultPath (throwing variant)', () => {
  it('throws VaultPathError on traversal', () => {
    expect(() => resolveVaultPath('../x.md')).toThrow(VaultPathError);
  });

  it('returns the confined path for a valid input', () => {
    expect(String(resolveVaultPath('notes/a..b.md'))).toBe('notes/a..b.md');
  });
});

describe('vaultPathFromTrusted (canonicalize-only, no rejection)', () => {
  it('folds away "." and empty segments', () => {
    expect(String(vaultPathFromTrusted('a/./b//c'))).toBe('a/b/c');
  });

  it('pops ".." segments and never begins with ".."', () => {
    expect(String(vaultPathFromTrusted('a/b/../c'))).toBe('a/c');
    expect(String(vaultPathFromTrusted('../../a'))).toBe('a');
    expect(String(vaultPathFromTrusted('..'))).toBe('');
  });

  it('pops the Windows dot-dot-space form and skips all-dots/spaces segments', () => {
    expect(String(vaultPathFromTrusted('a/b/.. /c'))).toBe('a/c'); // ".. " → parent
    expect(String(vaultPathFromTrusted('a/.../b'))).toBe('a/b');   // "..." → no-op skip
    expect(String(vaultPathFromTrusted('a/   /b'))).toBe('a/b');   // spaces → no-op skip
  });

  it('handles empty / nullish input without throwing', () => {
    expect(String(vaultPathFromTrusted(''))).toBe('');
    // @ts-expect-error — defensive nullish handling
    expect(String(vaultPathFromTrusted(undefined))).toBe('');
  });
});
