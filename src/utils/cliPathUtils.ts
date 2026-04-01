/**
 * src/utils/cliPathUtils.ts
 *
 * Shared vault base path and connector.js resolution helpers.
 * Used by CLI adapter runtimes (Claude Code, Gemini CLI) and auth services.
 */
import * as nodeFs from 'node:fs';
import * as pathMod from 'node:path';
import { FileSystemAdapter, Vault } from 'obsidian';
import { getAllPluginIds } from '../constants/branding';

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

  for (const pluginId of getAllPluginIds()) {
    const candidate = pathMod.join(vaultPath, configDir, 'plugins', pluginId, 'connector.js');
    if (nodeFs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}
