import { App } from 'obsidian';
import { BaseAgent } from '../baseAgent';
import { MemoryManagerConfig } from '../../config/agents';
import { parseWorkspaceContext } from '../../utils/contextUtils';
import { MemoryService } from "./services/MemoryService";
import { WorkspaceService } from "../../services/WorkspaceService";
import { getErrorMessage } from '../../utils/errorUtils';
import { sanitizeVaultName } from '../../utils/vaultUtils';
import { getNexusPlugin } from '../../utils/pluginLocator';
import { NexusPluginWithServices } from './modes/utils/pluginTypes';

// Import consolidated modes
import { CreateSessionMode } from './modes/sessions/CreateSessionMode';
import { ListSessionsMode } from './modes/sessions/ListSessionsMode';
import { LoadSessionMode } from './modes/sessions/LoadSessionMode';
import { UpdateSessionMode } from './modes/sessions/UpdateSessionMode';
import { CreateStateMode } from './modes/states/CreateStateMode';
import { ListStatesMode } from './modes/states/ListStatesMode';
import { LoadStateMode } from './modes/states/LoadStateMode';
import { UpdateStateMode } from './modes/states/UpdateStateMode';
import { CreateWorkspaceMode } from './modes/workspaces/CreateWorkspaceMode';
import { ListWorkspacesMode } from './modes/workspaces/ListWorkspacesMode';
import { LoadWorkspaceMode } from './modes/workspaces/LoadWorkspaceMode';
import { UpdateWorkspaceMode } from './modes/workspaces/UpdateWorkspaceMode';

/**
 * Agent for managing workspace memory, sessions, and states
 *
 * CONSOLIDATED ARCHITECTURE:
 * - 15 files total (down from 50+)
 * - 3 session modes: create/load/manage
 * - 3 state modes: create/load/manage  
 * - 4 workspace modes: create/load/manage/associated-notes
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
      MemoryManagerConfig.name,
      MemoryManagerConfig.description,
      MemoryManagerConfig.version
    );

    this.app = app;
    this.vaultName = sanitizeVaultName(app.vault.getName());

    // Store injected services
    this.memoryService = memoryService;
    this.workspaceService = workspaceService;
    
    // Register session modes (4 modes: create, list, load, update - following workspace pattern)
    this.registerMode(new CreateSessionMode(this));
    this.registerMode(new ListSessionsMode(this));
    this.registerMode(new LoadSessionMode(this));
    this.registerMode(new UpdateSessionMode(this));
    
    // Register state modes (4 modes: create, list, load, update - following workspace pattern) 
    this.registerMode(new CreateStateMode(this));
    this.registerMode(new ListStatesMode(this));
    this.registerMode(new LoadStateMode(this));
    this.registerMode(new UpdateStateMode(this));
    
    // Register consolidated workspace modes (5 modes instead of 7)
    this.registerMode(new CreateWorkspaceMode(this));
    this.registerMode(new ListWorkspacesMode(this));
    this.registerMode(new LoadWorkspaceMode(this));
    this.registerMode(new UpdateWorkspaceMode(this));
  }

  /**
   * Dynamic description that includes current workspace information
   */
  get description(): string {
    const baseDescription = MemoryManagerConfig.description;
    
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
   * Execute a mode with automatic session context tracking
   * @param modeSlug The mode to execute
   * @param params Parameters for the mode
   * @returns Result from mode execution
   */
  async executeMode(modeSlug: string, params: any): Promise<any> {
    // If there's a workspace context but no session ID, try to get or create a session
    if (params.workspaceContext?.workspaceId && !params.workspaceContext.sessionId) {
      try {
        const workspaceId = parseWorkspaceContext(params.workspaceContext)?.workspaceId;
        if (workspaceId) {
          // Try to get an active session
          let sessionId: string | null = null;
          
          // Get memory service and then get the most recent active session for this workspace
          const memoryService = await this.getMemoryServiceAsync();
          if (!memoryService) {
            console.warn('[MemoryManagerAgent] Memory service not available for session management');
            return super.executeMode(modeSlug, params);
          }
          
          const sessionsResult = await memoryService.getSessions(workspaceId);
          const activeSessions = sessionsResult.items;

          if (activeSessions && activeSessions.length > 0) {
            sessionId = activeSessions[0].id;
          }
          
          // If no active session, create one automatically for non-session modes
          // (for session creation, we don't want to create a session automatically)
          if (!sessionId && !modeSlug.startsWith('createSession')) {
            const newSession = await memoryService.createSession({
              workspaceId: workspaceId,
              name: `Auto-created session for ${modeSlug}`,
              description: `Automatically created for ${modeSlug} operation`
            });
            
            sessionId = newSession.id;
          }
          
          if (sessionId) {
            // Add the session ID to the parameters
            params.workspaceContext.sessionId = sessionId;
          }
        }
      } catch (error) {
        console.error('Failed to get/create session:', getErrorMessage(error));
      }
    }
    
    // Call the parent executeMode method
    return super.executeMode(modeSlug, params);
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
      return `🏗️ Workspaces: Available (use listWorkspaces mode to see details)`;
      
    } catch (error) {
      return `🏗️ Workspaces: Error loading workspace information (${error})`;
    }
  }
}
