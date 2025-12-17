import { App } from 'obsidian';
import { BaseAgent } from '../baseAgent';
import { MemoryService } from "./services/MemoryService";
import { WorkspaceService } from "../../services/WorkspaceService";
import { sanitizeVaultName } from '../../utils/vaultUtils';
import { getNexusPlugin } from '../../utils/pluginLocator';
import { NexusPluginWithServices } from './tools/utils/pluginTypes';

// Import consolidated tools
import { CreateSessionTool } from './tools/sessions/CreateSession';
import { ListSessionsTool } from './tools/sessions/ListSessions';
import { LoadSessionTool } from './tools/sessions/LoadSession';
import { UpdateSessionTool } from './tools/sessions/UpdateSession';
import { CreateStateTool } from './tools/states/CreateState';
import { ListStatesTool } from './tools/states/ListStates';
import { LoadStateTool } from './tools/states/LoadState';
import { UpdateStateTool } from './tools/states/UpdateState';
import { CreateWorkspaceTool } from './tools/workspaces/CreateWorkspace';
import { ListWorkspacesTool } from './tools/workspaces/ListWorkspaces';
import { LoadWorkspaceTool } from './tools/workspaces/LoadWorkspace';
import { UpdateWorkspaceTool } from './tools/workspaces/UpdateWorkspace';

/**
 * Agent for managing workspace memory, sessions, and states
 *
 * CONSOLIDATED ARCHITECTURE:
 * - 15 files total (down from 50+)
 * - 4 session tools: create/list/load/update
 * - 4 state tools: create/list/load/update
 * - 4 workspace tools: create/list/load/update
 * - 3 services: ValidationService/ContextBuilder/MemoryTraceService
 */
export class MemoryManagerAgent extends BaseAgent {
  /**
   * Memory service instance
   */
  private readonly memoryService: MemoryService;

  /**
   * Workspace service instance
   */
  private readonly workspaceService: WorkspaceService;
  
  /**
   * App instance
   */
  private app: App;

  /**
   * Vault name for multi-vault support
   */
  private vaultName: string;

  /**
   * Flag to prevent infinite recursion in description getter
   */
  private isGettingDescription = false;

  /**
   * Create a new MemoryManagerAgent with consolidated modes
   * @param app Obsidian app instance
   * @param plugin Plugin instance for accessing shared services
   * @param memoryService Injected memory service
   * @param workspaceService Injected workspace service
   */
  constructor(
    app: App,
    public plugin: any,
    memoryService: MemoryService,
    workspaceService: WorkspaceService
  ) {
    super(
      'memoryManager',
      'Manages workspaces, memory sessions, and states for contextual recall',
      '1.2.0'
    );

    this.app = app;
    this.vaultName = sanitizeVaultName(app.vault.getName());

    // Store injected services
    this.memoryService = memoryService;
    this.workspaceService = workspaceService;
    
    // Register session tools (4 tools: create, list, load, update)
    this.registerTool(new CreateSessionTool(this));
    this.registerTool(new ListSessionsTool(this));
    this.registerTool(new LoadSessionTool(this));
    this.registerTool(new UpdateSessionTool(this));

    // Register state tools (4 tools: create, list, load, update)
    this.registerTool(new CreateStateTool(this));
    this.registerTool(new ListStatesTool(this));
    this.registerTool(new LoadStateTool(this));
    this.registerTool(new UpdateStateTool(this));

    // Register workspace tools (4 tools: create, list, load, update)
    this.registerTool(new CreateWorkspaceTool(this));
    this.registerTool(new ListWorkspacesTool(this));
    this.registerTool(new LoadWorkspaceTool(this));
    this.registerTool(new UpdateWorkspaceTool(this));
  }

  /**
   * Dynamic description that includes current workspace information
   */
  get description(): string {
    const baseDescription = 'Manages workspaces, memory sessions, and states for contextual recall';
    
    // Prevent infinite recursion
    if (this.isGettingDescription) {
      return `[${this.vaultName}] ${baseDescription}`;
    }
    
    this.isGettingDescription = true;
    try {
      const workspaceContext = this.getWorkspacesSummary();
      return `[${this.vaultName}] ${baseDescription}\n\n${workspaceContext}`;
    } finally {
      this.isGettingDescription = false;
    }
  }
  
  /**
   * Initialize the agent
   */
  async initialize(): Promise<void> {
    await super.initialize();
    // No additional initialization needed
  }
  
  /**
   * Get the memory service instance - now uses injected service
   */
  getMemoryService(): MemoryService | null {
    return this.memoryService;
  }
  
  /**
   * Get the workspace service instance - now uses injected service
   */
  getWorkspaceService(): WorkspaceService | null {
    return this.workspaceService;
  }
  
  /**
   * Get the memory service instance asynchronously - now uses injected service
   */
  async getMemoryServiceAsync(): Promise<MemoryService | null> {
    return this.memoryService;
  }
  
  /**
   * Get the workspace service instance asynchronously - now uses injected service
   */
  async getWorkspaceServiceAsync(): Promise<WorkspaceService | null> {
    return this.workspaceService;
  }
  
  /**
   * Get the Obsidian app instance
   */
  getApp() {
    return this.app;
  }

  /**
   * Get the CacheManager service instance
   */
  getCacheManager() {
    const plugin = getNexusPlugin<NexusPluginWithServices>(this.app);
    return plugin?.getServiceIfReady('cacheManager') || null;
  }

  /**
   * Get a summary of available workspaces
   * @returns Formatted string with workspace information
   * @private
   */
  private getWorkspacesSummary(): string {
    try {
      // Check if workspace service is available using ServiceContainer
      const workspaceService = this.getWorkspaceService();
      if (!workspaceService) {
        return `🏗️ Workspaces: Service not available (initializing...)`;
      }

      // Service is available - return success message
      return `🏗️ Workspaces: Available (use listWorkspaces tool to see details)`;
      
    } catch (error) {
      return `🏗️ Workspaces: Error loading workspace information (${error})`;
    }
  }
}
