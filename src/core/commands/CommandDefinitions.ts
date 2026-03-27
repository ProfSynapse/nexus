/**
 * Command Definitions
 * Basic command definitions for plugin functionality
 */

import type NexusPlugin from '../../main';
import type { ServiceManager } from '../ServiceManager';

interface SettingsHostApp {
  setting: {
    open(): void;
    openTabById(id: string): void;
  };
}

export interface CommandContext {
  plugin: NexusPlugin;
  serviceManager: ServiceManager;
  getService?: <T>(name: string, timeoutMs?: number) => Promise<T | null>;
  isInitialized?: () => boolean;
}

export const BASIC_COMMAND_DEFINITIONS = [
  {
    id: 'open-settings',
    name: 'Open Plugin Settings',
    callback: (context: CommandContext): void => {
      const app = context.plugin.app as unknown as SettingsHostApp;
      app.setting.open();
      app.setting.openTabById(context.plugin.manifest.id);
    }
  }
];

export const MAINTENANCE_COMMAND_DEFINITIONS = BASIC_COMMAND_DEFINITIONS;
export const TROUBLESHOOT_COMMAND_DEFINITION = BASIC_COMMAND_DEFINITIONS[0];