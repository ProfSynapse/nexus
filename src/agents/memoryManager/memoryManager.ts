import { App } from 'obsidian';
import { BaseAgent } from '../baseAgent';
import { MemoryService } from "./services/MemoryService";
import { WorkspaceService } from "../../services/WorkspaceService";
import { CustomPromptStorageService } from "../promptManager/services/CustomPromptStorageService";
import { sanitizeVaultName } from '../../utils/vaultUtils';
import { getErrorMessage } from '../../utils/errorUtils';
import { getNexusPlugin } from '../../utils/pluginLocator';
import { NexusPluginWithServices } from './tools/utils/pluginTypes';
import type { WorkspaceTaskSummary } from '../taskManager/types';

// Import consolidated tools
import { CreateStateTool } from './tools/states/createState';
import { ListStatesTool } from './tools/states/listStates';
import { LoadStateTool } from './tools/states/loadState';
import { CreateWorkspaceTool } from './tools/workspaces/createWorkspace';
import { ListWorkspacesTool } from './tools/workspaces/listWorkspaces';
import { LoadWorkspaceTool } from './tools/workspaces/loadWorkspace';
import { UpdateWorkspaceTool } from './tools/workspaces/updateWorkspace';
import { ArchiveWorkspaceTool } from './tools/workspaces/archiveWorkspace';
import { RunWorkflowTool } from './tools/workspaces/runWorkflow';

interface TaskServiceLike {
  getWorkspaceSummary(workspaceId: string): Promise<WorkspaceTaskSummary>;
}

interface CacheManagerLike {
  getRecentFiles(limit: number, folder: string): Array<{ path: string; modified: number }> | null;
}

/**
 * Agent for managing workspace memory and states
 *
 * CONSOLIDATED ARCHITECTURE:
 * - Sessions are now implicit (sessionId comes from context, no CRUD needed)
 * - 3 state tools: create/list/load (states are immutable - no update/archive)
 * - 6 workspace tools: create/list/load/update/archive/run
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
   * Custom prompt storage service for SQLite-backed prompt resolution
   */
  public readonly customPromptStorage?: CustomPromptStorageService;

  /**
   * TaskService reference for loadWorkspace integration (optional, set during plugin init)
   */
  private taskService: TaskServiceLike | null = null;
  
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
   * @param customPromptStorage Optional prompt storage service for SQLite-backed lookups
   */
  constructor(
    app: App,
    public plugin: NexusPluginWithServices,
    memoryService: MemoryService,
    workspaceService: WorkspaceService,
    customPromptStorage?: CustomPromptStorageService
  ) {
    super(
      'memoryManager',
      'Manages workspaces and states for contextual recall',
      '1.3.0'
    );

    this.app = app;
    this.vaultName = sanitizeVaultName(app.vault.getName());

    // Store injected services
    this.memoryService = memoryService;
    this.workspaceService = workspaceService;
    this.customPromptStorage = customPromptStorage;

    // Register state tools (3 tools: create, list, load) - lazy loaded
    this.registerLazyTool({
      slug: 'createState', name: 'Create State',
      description: 'Create a state with restoration context for later resumption',
      version: '2.0.0',
      factory: () => new CreateStateTool(this),
    });
    this.registerLazyTool({
      slug: 'listStates', name: 'List States',
      description: 'List states with optional filtering and sorting',
      version: '2.0.0',
      factory: () => new ListStatesTool(this),
    });
    this.registerLazyTool({
      slug: 'loadState', name: 'Load State',
      description: 'Load a saved state and optionally create a continuation session with restored context',
      version: '2.0.0',
      factory: () => new LoadStateTool(this),
    });

    // Register workspace tools (6 tools: create, list, load, update, archive, run) - lazy loaded
    this.registerLazyTool({
      slug: 'createWorkspace', name: 'Create Workspace',
      description: 'Create a new workspace with structured context data',
      version: '2.0.0',
      factory: () => new CreateWorkspaceTool(this),
    });
    this.registerLazyTool({
      slug: 'listWorkspaces', name: 'List Workspaces',
      description: 'List available workspaces with filters and sorting',
      version: '1.0.0',
      factory: () => new ListWorkspacesTool(this),
    });
    this.registerLazyTool({
      slug: 'loadWorkspace', name: 'Load Workspace',
      description: 'Load a workspace by ID and restore context and state',
      version: '2.0.0',
      factory: () => new LoadWorkspaceTool(this),
    });
    this.registerLazyTool({
      slug: 'updateWorkspace', name: 'Update Workspace',
      description: 'Update workspace properties. Pass only fields to change - others remain unchanged.',
      version: '2.0.0',
      factory: () => new UpdateWorkspaceTool(this),
    });
    this.registerLazyTool({
      slug: 'archiveWorkspace', name: 'Archive Workspace',
      description: 'Archive a workspace (soft delete). Workspace will be hidden from lists but can be restored.',
      version: '1.0.0',
      factory: () => new ArchiveWorkspaceTool(this),
    });
    this.registerLazyTool({
      slug: 'runWorkflow', name: 'Run Workflow',
      description: 'Run a workflow immediately and create a fresh conversation for it.',
      version: '1.0.0',
      factory: () => new RunWorkflowTool(this),
    });
  }

  /**
   * Dynamic description that includes current workspace information
   */
  get description(): string {
    const baseDescription = 'Manages workspaces and states for contextual recall';
    
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
  getMemoryServiceAsync(): Promise<MemoryService | null> {
    return Promise.resolve(this.memoryService);
  }
  
  /**
   * Get the workspace service instance asynchronously - now uses injected service
   */
  getWorkspaceServiceAsync(): Promise<WorkspaceService | null> {
    return Promise.resolve(this.workspaceService);
  }
  
  /**
   * Get the Obsidian app instance
   */
  getApp(): App {
    return this.app;
  }

  /**
   * Set the TaskService reference for loadWorkspace task summary integration.
   * Called during plugin init after TaskManagerAgent is created.
   */
  setTaskService(service: TaskServiceLike): void {
    this.taskService = service;
  }

  /**
   * Get the TaskService reference (may be null if TaskManager not initialized).
   */
  getTaskService(): TaskServiceLike | null {
    return this.taskService;
  }

  /**
   * Get the CacheManager service instance
   */
  getCacheManager(): CacheManagerLike | null {
    const plugin = getNexusPlugin<NexusPluginWithServices>(this.app);
    return plugin?.getServiceIfReady<CacheManagerLike>('cacheManager') || null;
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
      return `🏗️ Workspaces: Error loading workspace information (${getErrorMessage(error)})`;
    }
  }
}
