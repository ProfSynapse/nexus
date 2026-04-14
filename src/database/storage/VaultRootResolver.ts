import type { MCPSettings, MCPStorageSettings } from '../../types/plugin/PluginTypes';
import { DEFAULT_STORAGE_SETTINGS } from '../../types/plugin/PluginTypes';

export interface VaultRootPathValidation {
  inputPath: string;
  normalizedPath: string;
  segments: string[];
  isValid: boolean;
  errors: string[];
  warnings: string[];
}

export interface VaultRootResolution {
  schemaVersion: number;
  configuredPath: string;
  resolvedPath: string;
  guidesPath: string;
  dataPath: string;
  maxShardBytes: number;
  validation: VaultRootPathValidation;
}

export interface VaultRootResolverOptions {
  configDir?: string;
}

function normalizeVaultRelativePath(path: string): string {
  if (typeof path !== 'string') {
    return '';
  }

  const trimmed = path.trim();
  if (!trimmed) {
    return '';
  }

  return trimmed
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/\/{2,}/g, '/');
}

function isAbsoluteVaultPath(path: string): boolean {
  if (typeof path !== 'string') {
    return false;
  }

  const trimmed = path.trim();
  if (!trimmed) {
    return false;
  }

  const normalized = trimmed.replace(/\\/g, '/');
  return normalized.startsWith('/') || normalized.startsWith('//') || /^[A-Za-z]:/.test(normalized);
}

function hasHiddenDotfolder(segment: string): boolean {
  return segment.startsWith('.');
}

function normalizeConfigDirPath(configDir: string | undefined): string {
  return normalizeVaultRelativePath(configDir ?? '');
}

function buildManagedSubpath(rootPath: string, subfolder: 'guides' | 'data'): string {
  const normalizedRootPath = normalizeVaultRelativePath(rootPath);
  if (!normalizedRootPath) {
    return subfolder;
  }

  return `${normalizedRootPath}/${subfolder}`;
}

export function validateVaultRelativePath(
  path: string,
  options: VaultRootResolverOptions = {}
): VaultRootPathValidation {
  const normalizedPath = normalizeVaultRelativePath(path);
  const segments = normalizedPath ? normalizedPath.split('/') : [];
  const errors: string[] = [];
  const warnings: string[] = [];
  const configDirPath = normalizeConfigDirPath(options.configDir);

  if (!path || path.trim().length === 0) {
    errors.push('Storage root path cannot be empty.');
  }

  if (isAbsoluteVaultPath(path)) {
    errors.push('Storage root path must be relative to the vault root.');
  }

  if (segments.some(segment => segment === '.' || segment === '..')) {
    errors.push('Path traversal segments are not allowed.');
  }

  if (configDirPath) {
    const configDirSegments = configDirPath.split('/');
    const isUnderConfigDir =
      normalizedPath === configDirPath || normalizedPath.startsWith(`${configDirPath}/`);
    if (isUnderConfigDir) {
      if (segments[configDirSegments.length]?.toLowerCase() === 'plugins') {
        errors.push(`Paths under ${configDirPath}/plugins are not allowed for data folder.`);
      } else {
        errors.push(`Paths under ${configDirPath} are not allowed for data folder.`);
      }
    }
  }

  if (segments.some(hasHiddenDotfolder)) {
    warnings.push('Hidden folders may not sync reliably in Obsidian Sync.');
  }

  return {
    inputPath: path,
    normalizedPath,
    segments,
    isValid: errors.length === 0,
    errors,
    warnings
  };
}

function resolveMaxShardBytes(storage: MCPStorageSettings | undefined): number {
  const candidate = storage?.maxShardBytes;
  if (typeof candidate === 'number' && Number.isFinite(candidate) && candidate > 0) {
    return Math.floor(candidate);
  }

  return DEFAULT_STORAGE_SETTINGS.maxShardBytes;
}

export function resolveVaultRoot(
  settings: Pick<MCPSettings, 'storage'> | undefined,
  options: VaultRootResolverOptions = {}
): VaultRootResolution {
  const storage = settings?.storage;
  const configuredPath = storage?.rootPath ?? DEFAULT_STORAGE_SETTINGS.rootPath;
  const validation = validateVaultRelativePath(configuredPath, options);

  return {
    schemaVersion: storage?.schemaVersion ?? DEFAULT_STORAGE_SETTINGS.schemaVersion ?? 1,
    configuredPath,
    resolvedPath: validation.normalizedPath,
    guidesPath: buildManagedSubpath(validation.normalizedPath, 'guides'),
    dataPath: buildManagedSubpath(validation.normalizedPath, 'data'),
    maxShardBytes: resolveMaxShardBytes(storage),
    validation
  };
}
