/**
 * Command Definitions
 * Basic command definitions for plugin functionality
 */

export interface CommandContext {
  plugin: {
    app: {
      setting: {
        open(): void;
        openTabById(id: string): void;
      };
    };
    manifest: {
      id: string;
    };
  };
  serviceManager: unknown;
  getService?: (name: string, timeoutMs?: number) => unknown;
  isInitialized?: () => boolean;
}

export const BASIC_COMMAND_DEFINITIONS = [
  {
    id: 'open-settings',
    name: 'Open Plugin Settings',
    callback: (context: CommandContext): void => {
      context.plugin.app.setting.open();
      context.plugin.app.setting.openTabById(context.plugin.manifest.id);
    }
  }
];

export const MAINTENANCE_COMMAND_DEFINITIONS = BASIC_COMMAND_DEFINITIONS;
export const TROUBLESHOOT_COMMAND_DEFINITION = BASIC_COMMAND_DEFINITIONS[0];
