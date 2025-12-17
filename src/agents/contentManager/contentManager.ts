import { App } from 'obsidian';
import { BaseAgent } from '../baseAgent';
import {
  ReadContentTool,
  CreateContentTool,
  AppendContentTool,
  PrependContentTool,
  ReplaceContentTool,
  ReplaceByLineTool,
  DeleteContentTool,
  FindReplaceContentTool
} from './tools';
// import { AgentManager } from '../../services/AgentManager';
import NexusPlugin from '../../main';
import { WorkspaceService } from '../../services/WorkspaceService';
import { MemoryService } from '../memoryManager/services/MemoryService';

/**
 * Agent for content operations in the vault
 * Consolidates functionality from noteEditor and noteReader
 */
export class ContentManagerAgent extends BaseAgent {
  protected app: App;
  protected plugin: NexusPlugin | null = null;
  
  private workspaceService: WorkspaceService | null = null;
  private memoryService: MemoryService | null = null;

  /**
   * Create a new ContentManagerAgent
   * @param app Obsidian app instance
 * @param plugin Nexus plugin instance
   * @param memoryService Optional injected memory service
   * @param workspaceService Optional injected workspace service
   */
  constructor(
    app: App,
    plugin?: NexusPlugin,
    memoryService?: MemoryService | null,
    workspaceService?: WorkspaceService | null
  ) {
    super(
      'contentManager',
      'Content operations for Obsidian notes',
      '1.0.0'
    );

    this.app = app;
    this.plugin = plugin || null;

    // Use injected services if provided, otherwise fall back to plugin services
    if (memoryService) {
      this.memoryService = memoryService;
    } else if (plugin?.services?.memoryService) {
        this.memoryService = plugin.services.memoryService;
    }

    if (workspaceService) {
      this.workspaceService = workspaceService;
    } else if (plugin?.services?.workspaceService) {
      this.workspaceService = plugin.services.workspaceService;
    }
    
    // Register tools with access to memory services
    this.registerTool(new ReadContentTool(app, this.memoryService));
    this.registerTool(new CreateContentTool(app));
    this.registerTool(new AppendContentTool(app));
    this.registerTool(new PrependContentTool(app));
    this.registerTool(new ReplaceContentTool(app));
    this.registerTool(new ReplaceByLineTool(app));
    this.registerTool(new DeleteContentTool(app));
    this.registerTool(new FindReplaceContentTool(app));
  }
  
  
  /**
   * Gets the workspace service
   * @returns WorkspaceService instance or null
   */
  public getWorkspaceService(): WorkspaceService | null {
    return this.workspaceService;
  }
  
  /**
   * Gets the memory service
   * @returns MemoryService instance or null
   */
  public getMemoryService(): MemoryService | null {
    return this.memoryService;
  }
  
}
