import { App, normalizePath, Plugin } from 'obsidian';

export interface ResolvedPluginStorageRoot {
  pluginDir: string;
  dataJsonPath: string;
  dataRoot: string;
  migrationRoot: string;
}

export function resolveActivePluginFolderName(plugin: Plugin): string {
  const manifestDir = plugin.manifest.dir;
  if (typeof manifestDir === 'string' && manifestDir.trim().length > 0) {
    const segments = manifestDir.replace(/\\/g, '/').split('/').filter(Boolean);
    const folderName = segments[segments.length - 1];
    if (folderName) {
      return folderName;
    }
  }

  return plugin.manifest.id;
}

export function resolvePluginStorageRoot(app: App, plugin: Plugin): ResolvedPluginStorageRoot {
  const pluginFolderName = resolveActivePluginFolderName(plugin);
  const pluginDir = normalizePath(`${app.vault.configDir}/plugins/${pluginFolderName}`);
  const dataRoot = normalizePath(`${pluginDir}/data`);

  return {
    pluginDir,
    dataJsonPath: normalizePath(`${pluginDir}/data.json`),
    dataRoot,
    migrationRoot: normalizePath(`${dataRoot}/migration`)
  };
}