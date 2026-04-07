/**
 * Shared lock for Obsidian plugin data.json writes.
 *
 * Both Settings.saveSettings() and PluginScopedStorageCoordinator.saveState()
 * do load-merge-save on data.json. Without serialization the last writer
 * clobbers the other's changes. This singleton AsyncLock ensures all
 * load-merge-save cycles run sequentially.
 */
import { AsyncLock } from './AsyncLock';

export const pluginDataLock = new AsyncLock();
