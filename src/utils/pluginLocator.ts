import type { App, Plugin } from 'obsidian';
import { getAllPluginIds } from '../constants/branding';

export function getNexusPlugin<T extends Plugin = Plugin>(app: App): T | null {
    const pluginManager = app.plugins;
    if (!pluginManager?.getPlugin) {
        return null;
    }

    for (const id of getAllPluginIds()) {
        const plugin = pluginManager.getPlugin(id);
        if (plugin) {
            return plugin as T;
        }
    }

    return null;
}

export function getNexusPluginFromRegistry<T = Plugin>(
    registry: Record<string, T>
): T | null {
    if (!registry) {
        return null;
    }

    for (const id of getAllPluginIds()) {
        const plugin = registry[id];
        if (plugin) {
            return plugin;
        }
    }

    return null;
}
