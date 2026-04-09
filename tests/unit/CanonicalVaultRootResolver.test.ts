import {
  DEFAULT_STORAGE_SETTINGS
} from '../../src/types/plugin/PluginTypes';
import {
  resolveCanonicalVaultRoot,
  validateVaultRelativePath
} from '../../src/database/storage/CanonicalVaultRootResolver';

describe('CanonicalVaultRootResolver', () => {
  it('resolves the default Nexus root when storage settings are absent', () => {
    const result = resolveCanonicalVaultRoot(undefined, { configDir: '.obsidian' });

    expect(result.configuredRootPath).toBe(DEFAULT_STORAGE_SETTINGS.rootPath);
    expect(result.resolvedRootPath).toBe(DEFAULT_STORAGE_SETTINGS.rootPath);
    expect(result.schemaVersion).toBe(DEFAULT_STORAGE_SETTINGS.schemaVersion);
    expect(result.maxShardBytes).toBe(DEFAULT_STORAGE_SETTINGS.maxShardBytes);
    expect(result.validation.isValid).toBe(true);
  });

  it('normalizes vault-relative paths from settings', () => {
    const result = resolveCanonicalVaultRoot({
      storage: {
        schemaVersion: 7,
        rootPath: '  storage\\\\nexus// ',
        maxShardBytes: 2_097_152
      }
    }, { configDir: '.obsidian' });

    expect(result.configuredRootPath).toBe('  storage\\\\nexus// ');
    expect(result.resolvedRootPath).toBe('storage/nexus');
    expect(result.schemaVersion).toBe(7);
    expect(result.maxShardBytes).toBe(2_097_152);
    expect(result.validation.isValid).toBe(true);
    expect(result.validation.normalizedPath).toBe('storage/nexus');
  });

  it('rejects empty, absolute, obsidian, and traversal paths', () => {
    const cases = [
      {
        input: '',
        error: 'Storage root path cannot be empty.'
      },
      {
        input: '/Users/me/Nexus',
        error: 'Storage root path must be relative to the vault root.'
      },
      {
        input: 'C:\\Users\\me\\Nexus',
        error: 'Storage root path must be relative to the vault root.'
      },
      {
        input: '.obsidian',
        error: 'Paths under .obsidian are not allowed for canonical storage.'
      },
      {
        input: '.obsidian/plugins/nexus',
        error: 'Paths under .obsidian/plugins are not allowed for canonical storage.'
      },
      {
        input: '../Nexus',
        error: 'Path traversal segments are not allowed.'
      },
      {
        input: 'Archive/../Nexus',
        error: 'Path traversal segments are not allowed.'
      }
    ];

    for (const testCase of cases) {
      const result = validateVaultRelativePath(testCase.input, { configDir: '.obsidian' });
      expect(result.isValid).toBe(false);
      expect(result.errors).toContain(testCase.error);
    }
  });

  it('warns when the canonical root is hidden but still valid', () => {
    const result = validateVaultRelativePath('storage/.nexus', { configDir: '.obsidian' });

    expect(result.isValid).toBe(true);
    expect(result.warnings).toContain(
      'Hidden folders may not sync reliably in Obsidian Sync.'
    );
  });
});
