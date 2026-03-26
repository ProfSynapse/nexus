/**
 * src/utils/cliPathUtils.ts
 *
 * Shared vault base path and connector.js resolution helpers.
 * Used by CLI adapter runtimes (Claude Code, Gemini CLI) and auth services.
 */
import { FileSystemAdapter, Vault } from 'obsidian';
import { getAllPluginIds } from '../constants/branding';

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
export function getConnectorPath(vaultPath: string | null): string | null {
  if (!vaultPath) {
    return null;
  }

  const pathMod = require('path') as typeof import('path');
  const nodeFs = require('fs') as typeof import('fs');

  const configFolders = nodeFs
    .readdirSync(vaultPath, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  for (const configFolder of configFolders) {
    for (const pluginId of getAllPluginIds()) {
      const candidate = pathMod.join(vaultPath, configFolder, 'plugins', pluginId, 'connector.js');
      if (nodeFs.existsSync(candidate)) {
        return candidate;
      }
    }
  }

  return null;
}
