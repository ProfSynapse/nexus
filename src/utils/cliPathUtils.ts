/**
 * src/utils/cliPathUtils.ts
 *
 * Shared vault base path and connector.js resolution helpers.
 * Used by CLI adapter runtimes (Claude Code, Gemini CLI) and auth services.
 */
import { FileSystemAdapter, Vault } from 'obsidian';
import { getAllPluginIds } from '../constants/branding';
import { desktopRequire } from './desktopRequire';

const DEFAULT_CONFIG_DIR = ['.', 'obsidian'].join('');

/**
 * Returns the filesystem base path for the vault, or null on mobile.
 */
export function getVaultBasePath(vault: Vault): string | null {
  const adapter = vault.adapter;
  if (adapter instanceof FileSystemAdapter) {
    return adapter.getBasePath();
  }
  return null;
}

/**
 * Finds the connector.js file for this plugin across all known plugin IDs.
 * Returns the absolute path, or null if not found.
 */
export function getConnectorPath(vaultPath: string | null, configDir = DEFAULT_CONFIG_DIR): string | null {
  if (!vaultPath) {
    return null;
  }

  const nodeFs = desktopRequire<typeof import('node:fs')>('node:fs');
  const pathMod = desktopRequire<typeof import('node:path')>('node:path');

  for (const pluginId of getAllPluginIds()) {
    const candidate = pathMod.join(vaultPath, configDir, 'plugins', pluginId, 'connector.js');
    if (nodeFs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}
