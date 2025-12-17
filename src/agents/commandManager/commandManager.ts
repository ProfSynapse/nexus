import { App } from 'obsidian';
import { BaseAgent } from '../baseAgent';
import { CommandManagerConfig } from '../../config/agents';
import {
  ListCommandsTool,
  ExecuteCommandTool
} from './tools';
import { isAgentHidden } from '../../config/toolVisibility';

/**
 * CommandManager Agent for command palette operations
 */
export class CommandManagerAgent extends BaseAgent {
  /**
   * Obsidian app instance
   */
  private app: App;

  /**
   * Create a new CommandManagerAgent
   * @param app Obsidian app instance
   */
  constructor(app: App) {
    super(
      CommandManagerConfig.name,
      CommandManagerConfig.description,
      CommandManagerConfig.version
    );

    this.app = app;

    // Register tools only if agent is not hidden
    if (!isAgentHidden('commandManager')) {
      this.registerTool(new ListCommandsTool(app));
      this.registerTool(new ExecuteCommandTool(app, this));
    }
  }
  
  /**
   * Get a list of available commands
   * @param filter Optional filter to apply to command list
   * @returns Promise that resolves with the command list
   */
  async listCommands(filter?: string): Promise<{
    commands: Array<{
      id: string;
      name: string;
      icon?: string;
      hotkeys?: string[];
    }>;
    total: number;
  }> {
    // Get all commands from the app
    const commands = this.app.commands.listCommands();
    
    // Filter commands if filter is provided
    const filteredCommands = filter
      ? commands.filter(cmd => 
          cmd.name.toLowerCase().includes(filter.toLowerCase()) ||
          cmd.id.toLowerCase().includes(filter.toLowerCase())
        )
      : commands;
    
    // Map to the desired format
    const mappedCommands = filteredCommands.map(cmd => ({
      id: cmd.id,
      name: cmd.name,
      icon: cmd.icon,
      hotkeys: this.getCommandHotkeys(cmd.id)
    }));
    
    return {
      commands: mappedCommands,
      total: mappedCommands.length
    };
  }
  
  /**
   * Execute a command by ID
   * @param commandId ID of the command to execute
   * @returns Promise that resolves when the command is executed
   */
  async executeCommand(commandId: string): Promise<boolean> {
    try {
      // Check if the command exists
      const commands = this.app.commands.listCommands();
      const command = commands.find(cmd => cmd.id === commandId);
      
      if (!command) {
        throw new Error(`Command with ID ${commandId} not found`);
      }
      
      // Execute the command
      await this.app.commands.executeCommandById(commandId);
      
      return true;
    } catch (error) {
      console.error(`Error executing command ${commandId}:`, error);
      throw error;
    }
  }
  
  /**
   * Get hotkeys for a command
   * @param commandId ID of the command
   * @returns Array of hotkey strings or undefined if none
   */
  private getCommandHotkeys(commandId: string): string[] | undefined {
    try {
      // Access the Obsidian internal API to retrieve hotkeys
      // Using Record<string, unknown> pattern for internal API access
      const appInternal = this.app as unknown as Record<string, unknown>;
      const hotkeyManager = appInternal.hotkeyManager as Record<string, unknown> | undefined;
      if (!hotkeyManager) return undefined;

      // Get all hotkeys from the manager
      const getHotkeys = hotkeyManager.getHotkeys as ((id: string) => Array<{ modifiers: string[]; key: string }>) | undefined;
      if (!getHotkeys) return undefined;
      const hotkeys = getHotkeys(commandId) || [];

      // Format hotkey strings
      return hotkeys.map((hotkey) => {
        // Accessing internal Obsidian API properties
        const { modifiers, key } = hotkey;
        const modifierKeys = [];
        
        // Add modifiers in a standard order
        if (modifiers.includes('Mod')) modifierKeys.push('Ctrl/Cmd');
        if (modifiers.includes('Shift')) modifierKeys.push('Shift');
        if (modifiers.includes('Alt')) modifierKeys.push('Alt');
        if (modifiers.includes('Meta')) modifierKeys.push('Meta');
        
        // Join modifiers + key with + sign
        return [...modifierKeys, key].join('+');
      });
    } catch (error) {
      console.warn(`Error retrieving hotkeys for command ${commandId}:`, error);
      return undefined;
    }
  }
}