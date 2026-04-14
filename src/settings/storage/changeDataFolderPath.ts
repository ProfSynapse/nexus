import type { App } from 'obsidian';

import type { ServiceManager } from '../../core/ServiceManager';
import { validateVaultRelativePath } from '../../database/storage/VaultRootResolver';
import type { VaultRootRelocationResult } from '../../database/migration/VaultRootRelocationService';
import { DEFAULT_STORAGE_SETTINGS } from '../../types/plugin/PluginTypes';
import type { Settings } from '../../settings';

export interface DataFolderRuntimeAdapter {
  isReady(): boolean;
  relocateVaultRoot(
    targetRootPath: string,
    options?: { maxShardBytes?: number }
  ): Promise<VaultRootRelocationResult & { switched: boolean }>;
}

export interface DataFolderChangeResult {
  success: boolean;
  persisted: boolean;
  relocated: boolean;
  applyOnNextStartup: boolean;
  normalizedRootPath?: string;
  message: string;
  warnings: string[];
  errors: string[];
}

export interface DataFolderChangeContext {
  app: App;
  settings: Settings;
  serviceManager?: ServiceManager;
  nextRootPath: string;
}

function buildFailureResult(
  message: string,
  normalizedRootPath: string | undefined,
  warnings: string[],
  errors: string[]
): DataFolderChangeResult {
  return {
    success: false,
    persisted: false,
    relocated: false,
    applyOnNextStartup: false,
    normalizedRootPath,
    message,
    warnings,
    errors
  };
}

function getRelocationErrors(
  relocationResult: VaultRootRelocationResult & { switched: boolean },
  fallback: string
): string[] {
  if (Array.isArray(relocationResult.errors)) {
    return relocationResult.errors.filter((error): error is string => typeof error === 'string' && error.length > 0);
  }

  return [fallback];
}

export async function changeDataFolderPath(
  context: DataFolderChangeContext
): Promise<DataFolderChangeResult> {
  const currentStorage = context.settings.settings.storage ?? DEFAULT_STORAGE_SETTINGS;
  const validation = validateVaultRelativePath(context.nextRootPath, {
    configDir: context.app.vault.configDir
  });
  const normalizedRootPath = validation.normalizedPath || undefined;

  if (!validation.isValid) {
    return buildFailureResult(
      validation.errors[0] ?? 'Data folder path is invalid.',
      normalizedRootPath,
      validation.warnings,
      validation.errors
    );
  }

  if (currentStorage.rootPath === validation.normalizedPath) {
    return {
      success: true,
      persisted: false,
      relocated: false,
      applyOnNextStartup: false,
      normalizedRootPath: validation.normalizedPath,
      message: `Data folder is already set to "${validation.normalizedPath}".`,
      warnings: validation.warnings,
      errors: []
    };
  }

  const runtimeAdapter =
    context.serviceManager?.getServiceIfReady<DataFolderRuntimeAdapter>('hybridStorageAdapter') ?? null;

  if (!runtimeAdapter?.isReady()) {
    context.settings.settings.storage = {
      ...currentStorage,
      rootPath: validation.normalizedPath
    };
    await context.settings.saveSettings();

    return {
      success: true,
      persisted: true,
      relocated: false,
      applyOnNextStartup: true,
      normalizedRootPath: validation.normalizedPath,
      message: `Data folder saved as "${validation.normalizedPath}". It will apply on next startup.`,
      warnings: validation.warnings,
      errors: []
    };
  }

  const relocationResult = await runtimeAdapter.relocateVaultRoot(validation.normalizedPath, {
    maxShardBytes: currentStorage.maxShardBytes
  });

  if (!relocationResult.success || !relocationResult.verified || !relocationResult.switched) {
    const relocationErrors = getRelocationErrors(relocationResult, 'Failed to relocate data folder.');
    return buildFailureResult(
      relocationErrors[0] ?? 'Failed to relocate data folder.',
      validation.normalizedPath,
      validation.warnings,
      relocationErrors
    );
  }

  context.settings.settings.storage = {
    ...currentStorage,
    rootPath: validation.normalizedPath
  };
  await context.settings.saveSettings();

  return {
    success: true,
    persisted: true,
    relocated: true,
    applyOnNextStartup: false,
    normalizedRootPath: validation.normalizedPath,
    message: `Data folder moved to "${validation.normalizedPath}".`,
    warnings: validation.warnings,
    errors: []
  };
}
