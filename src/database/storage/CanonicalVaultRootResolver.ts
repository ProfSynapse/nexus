import type { MCPSettings, MCPStorageSettings } from '../../types/plugin/PluginTypes';
import { DEFAULT_STORAGE_SETTINGS } from '../../types/plugin/PluginTypes';

export interface CanonicalVaultRootPathValidation {
  inputPath: string;
  normalizedPath: string;
  segments: string[];
  isValid: boolean;
  errors: string[];
  warnings: string[];
}

export interface CanonicalVaultRootResolution {
  schemaVersion: number;
  configuredRootPath: string;
  resolvedRootPath: string;
  maxShardBytes: number;
  validation: CanonicalVaultRootPathValidation;
}

export interface CanonicalVaultRootResolverOptions {
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

export function validateVaultRelativePath(
  path: string,
  options: CanonicalVaultRootResolverOptions = {}
): CanonicalVaultRootPathValidation {
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
        errors.push(`Paths under ${configDirPath}/plugins are not allowed for canonical storage.`);
      } else {
        errors.push(`Paths under ${configDirPath} are not allowed for canonical storage.`);
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

export function resolveCanonicalVaultRoot(
  settings: Pick<MCPSettings, 'storage'> | undefined,
  options: CanonicalVaultRootResolverOptions = {}
): CanonicalVaultRootResolution {
  const storage = settings?.storage;
  const configuredRootPath = storage?.rootPath ?? DEFAULT_STORAGE_SETTINGS.rootPath;
  const validation = validateVaultRelativePath(configuredRootPath, options);

  return {
    schemaVersion: storage?.schemaVersion ?? DEFAULT_STORAGE_SETTINGS.schemaVersion ?? 1,
    configuredRootPath,
    resolvedRootPath: validation.normalizedPath,
    maxShardBytes: resolveMaxShardBytes(storage),
    validation
  };
}
