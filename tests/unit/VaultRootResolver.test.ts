import {
  DEFAULT_STORAGE_SETTINGS
} from '../../src/types/plugin/PluginTypes';
import {
  resolveVaultRoot,
  validateVaultRelativePath
} from '../../src/database/storage/VaultRootResolver';

describe('VaultRootResolver', () => {
  it('resolves the default data folder when storage settings are absent', () => {
    const result = resolveVaultRoot(undefined, { configDir: '.obsidian' });

    expect(result.configuredPath).toBe(DEFAULT_STORAGE_SETTINGS.rootPath);
    expect(result.resolvedPath).toBe(DEFAULT_STORAGE_SETTINGS.rootPath);
    expect(result.guidesPath).toBe(`${DEFAULT_STORAGE_SETTINGS.rootPath}/guides`);
    expect(result.dataPath).toBe(`${DEFAULT_STORAGE_SETTINGS.rootPath}/data`);
    expect(result.schemaVersion).toBe(DEFAULT_STORAGE_SETTINGS.schemaVersion);
    expect(result.maxShardBytes).toBe(DEFAULT_STORAGE_SETTINGS.maxShardBytes);
    expect(result.validation.isValid).toBe(true);
  });

  it('normalizes vault-relative paths from settings', () => {
    const result = resolveVaultRoot({
      storage: {
        schemaVersion: 7,
        rootPath: '  storage\\\\assistant-data// ',
        maxShardBytes: 2_097_152
      }
    }, { configDir: '.obsidian' });

    expect(result.configuredPath).toBe('  storage\\\\assistant-data// ');
    expect(result.resolvedPath).toBe('storage/assistant-data');
    expect(result.guidesPath).toBe('storage/assistant-data/guides');
    expect(result.dataPath).toBe('storage/assistant-data/data');
    expect(result.schemaVersion).toBe(7);
    expect(result.maxShardBytes).toBe(2_097_152);
    expect(result.validation.isValid).toBe(true);
    expect(result.validation.normalizedPath).toBe('storage/assistant-data');
  });

  it('rejects empty, absolute, obsidian, and traversal paths', () => {
    const cases = [
      {
        input: '',
        error: 'Storage root path cannot be empty.'
      },
      {
        input: '/Users/me/Assistant data',
        error: 'Storage root path must be relative to the vault root.'
      },
      {
        input: 'C:\\Users\\me\\Assistant data',
        error: 'Storage root path must be relative to the vault root.'
      },
      {
        input: '.obsidian',
        error: 'Paths under .obsidian are not allowed for data folder.'
      },
      {
        input: '.obsidian/plugins/nexus',
        error: 'Paths under .obsidian/plugins are not allowed for data folder.'
      },
      {
        input: '../Assistant data',
        error: 'Path traversal segments are not allowed.'
      },
      {
        input: 'Archive/../Assistant data',
        error: 'Path traversal segments are not allowed.'
      }
    ];

    for (const testCase of cases) {
      const result = validateVaultRelativePath(testCase.input, { configDir: '.obsidian' });
      expect(result.isValid).toBe(false);
      expect(result.errors).toContain(testCase.error);
    }
  });

  it('warns when the data folder is hidden but still valid', () => {
    const result = validateVaultRelativePath('storage/.nexus', { configDir: '.obsidian' });

    expect(result.isValid).toBe(true);
    expect(result.warnings).toContain(
      'Hidden folders may not sync reliably in Obsidian Sync.'
    );
  });
});
