import { App, normalizePath, Plugin } from 'obsidian';

export interface ResolvedPluginStorageRoot {
  pluginDir: string;
  dataJsonPath: string;
  dataRoot: string;
  migrationRoot: string;
  compatibilityDataRoots: string[];
}

const KNOWN_PLUGIN_FOLDER_NAMES = ['nexus', 'claudesidian-mcp'] as const;

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
  const activePluginFolderName = resolveActivePluginFolderName(plugin);
  const pluginDir = normalizePath(`${app.vault.configDir}/plugins/${activePluginFolderName}`);
  const dataRoot = normalizePath(`${pluginDir}/data`);
  const compatibilityFolderNames = Array.from(new Set([
    plugin.manifest.id,
    ...KNOWN_PLUGIN_FOLDER_NAMES
  ])).filter(folderName => folderName !== activePluginFolderName);
  const compatibilityDataRoots = compatibilityFolderNames.map(folderName =>
    normalizePath(`${app.vault.configDir}/plugins/${folderName}/data`)
  );

  return {
    pluginDir,
    dataJsonPath: normalizePath(`${pluginDir}/data.json`),
    dataRoot,
    migrationRoot: normalizePath(`${dataRoot}/migration`),
    compatibilityDataRoots
  };
}
