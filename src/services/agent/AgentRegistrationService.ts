/**
 * Location: src/services/agent/AgentRegistrationService.ts
 *
 * This service orchestrates agent initialization and registration
 * Refactored to use extracted services following SOLID principles
 *
 * Used by: MCPConnector
 * Dependencies: AgentInitializationService, AgentValidationService
 */

import { App, Plugin, Events } from 'obsidian';
import NexusPlugin from '../../main';
import { AgentManager } from '../AgentManager';
import type { ServiceManager } from '../../core/ServiceManager';
import { NexusError, NexusErrorCode } from '../../utils/errors';
import { logger } from '../../utils/logger';
import { CustomPromptStorageService } from "../../agents/promptManager/services/CustomPromptStorageService";
import { AgentInitializationService } from './AgentInitializationService';
import { AgentValidationService } from './AgentValidationService';
import type { AppManager } from '../apps/AppManager';
import type { IAgent } from '../../agents/interfaces/IAgent';

export interface AgentRegistrationServiceInterface {
  /**
   * Initializes all configured agents
   */
  initializeAllAgents(): Promise<Map<string, any>>;

  /**
   * Gets registered agent by name
   */
  getAgent(name: string): any | null;

  /**
   * Gets all registered agents
   */
  getAllAgents(): Map<string, any>;

  /**
   * Registers agents with server
   */
  registerAgentsWithServer(registerFunction: (agent: any) => void): void;

  /**
   * Gets agent registration status
   */
  getRegistrationStatus(): AgentRegistrationStatus;

  /**
   * Gets the AppManager instance (available after PHASE 3 initialization)
   */
  getAppManager(): any | null;
}

export interface AgentRegistrationStatus {
  totalAgents: number;
  initializedAgents: number;
  failedAgents: number;
  initializationErrors: Record<string, Error>;
  registrationTime: Date;
  registrationDuration: number;
}

/**
 * Type guard to check if plugin has Settings
 */
function hasSettings(plugin: Plugin | NexusPlugin): plugin is NexusPlugin {
  return 'settings' in plugin && plugin.settings !== undefined;
}

export class AgentRegistrationService implements AgentRegistrationServiceInterface {
  private agentManager: AgentManager;
  private registrationStatus: AgentRegistrationStatus;
  private initializationErrors: Record<string, Error> = {};
  private initializationService: AgentInitializationService;
  private validationService: AgentValidationService;
  private isInitialized: boolean = false;
  private initializationPromise: Promise<Map<string, any>> | null = null;
  private appManagerInstance: AppManager | null = null;

  constructor(
    private app: App,
    private plugin: Plugin | NexusPlugin,
    private events: Events,
    private serviceManager?: ServiceManager,
    private customPromptStorage?: CustomPromptStorageService,
    sharedAgentManager?: AgentManager
  ) {
    // Use shared AgentManager if provided, otherwise create a new one
    this.agentManager = sharedAgentManager ?? new AgentManager(app, plugin, events);
    this.registrationStatus = {
      totalAgents: 0,
      initializedAgents: 0,
      failedAgents: 0,
      initializationErrors: {},
      registrationTime: new Date(),
      registrationDuration: 0
    };

    // Initialize extracted services
    this.initializationService = new AgentInitializationService(
      app,
      plugin,
      this.agentManager,
      serviceManager,
      customPromptStorage
    );
    this.validationService = new AgentValidationService(plugin);
  }

  /**
   * Initializes all configured agents.
   * Supports lazy initialization - can be called multiple times safely.
   */
  async initializeAllAgents(): Promise<Map<string, any>> {
    // Return cached result if already initialized
    if (this.isInitialized) {
      return this.getAllAgents();
    }

    // Return existing promise if initialization is in progress (prevents double-init)
    if (this.initializationPromise) {
      return this.initializationPromise;
    }

    // Start initialization and cache the promise
    this.initializationPromise = this.doInitializeAllAgents();
    return this.initializationPromise;
  }

  /**
   * Internal method that performs the actual agent initialization
   */
  private async doInitializeAllAgents(): Promise<Map<string, any>> {
    const startTime = Date.now();
    this.registrationStatus.registrationTime = new Date();
    this.initializationErrors = {};

    try {
      const { hasValidLLMKeys, enableSearchModes, enableLLMModes } = await this.validationService.getCapabilityStatus();
      const memorySettings = this.getMemorySettings();

      logger.systemLog(`Agent initialization started - Search modes: ${enableSearchModes}, LLM modes: ${enableLLMModes}`);

      // Log additional debugging info for AgentManager
      if (!hasValidLLMKeys) {
        logger.systemLog('LLM validation failed - AgentManager features may be limited');
      }

      // PHASE 1: Initialize independent agents IN PARALLEL
      // These agents have no dependencies on each other
      await Promise.all([
        this.safeInitialize('contentManager', () => this.initializationService.initializeContentManager()),
        this.safeInitialize('storageManager', () => this.initializationService.initializeStorageManager()),
        this.safeInitialize('canvasManager', () => this.initializationService.initializeCanvasManager()),
      ]);

      // PHASE 2: Initialize dependent agents IN PARALLEL (where possible)
      await Promise.all([
        this.safeInitialize('promptManager', () => this.initializationService.initializePromptManager(enableLLMModes)),
        this.safeInitialize('searchManager', () => this.initializationService.initializeSearchManager(enableSearchModes, memorySettings)),
        this.safeInitialize('memoryManager', () => this.initializationService.initializeMemoryManager()),
        this.safeInitialize('taskManager', () => this.initializationService.initializeTaskManager()),
        this.safeInitialize('ingestManager', () => this.initializationService.initializeIngestManager()),
      ]);

      // Wire cross-agent dependencies (after Phase 2, both agents are available)
      try {
        const memoryAgent = this.agentManager.getAgent('memoryManager') as IAgent & { setTaskService?: (s: unknown) => void };
        const taskAgent = this.agentManager.getAgent('taskManager') as IAgent & { getTaskService?: () => unknown };
        if (memoryAgent?.setTaskService && taskAgent?.getTaskService) {
          memoryAgent.setTaskService(taskAgent.getTaskService());
          logger.systemLog('Wired TaskService into MemoryManager for loadWorkspace task summaries');
        }
      } catch { /* Either agent failed to init — skip wiring */ }

      // PHASE 3: Load app agents (must be after core agents, before ToolManager)
      await this.safeInitialize('apps', async () => {
        const { AppManager: AppManagerClass } = await import('../apps/AppManager');
        const pluginSettings = hasSettings(this.plugin) ? this.plugin.settings.settings : undefined;
        const appsSettings = pluginSettings?.apps || { apps: {} };
        const appManager = new AppManagerClass(
          appsSettings,
          (agent) => this.agentManager.registerAgent(agent),
          (name) => this.agentManager.unregisterAgent(name),
          this.app.vault
        );
        await appManager.loadInstalledApps();
        this.appManagerInstance = appManager;
        logger.systemLog('App agents loaded');
      });

      // PHASE 4: ToolManager MUST be last (needs all other agents including apps)
      await this.safeInitialize('toolManager', () => this.initializationService.initializeToolManager());

      logger.systemLog('Using native chatbot UI instead of ChatAgent');

      // Calculate final statistics
      const agents = this.agentManager.getAgents();
      this.registrationStatus = {
        totalAgents: agents.length,
        initializedAgents: agents.length - Object.keys(this.initializationErrors).length,
        failedAgents: Object.keys(this.initializationErrors).length,
        initializationErrors: this.initializationErrors,
        registrationTime: this.registrationStatus.registrationTime,
        registrationDuration: Date.now() - startTime
      };

      // Log conditional mode availability status
      if (!enableSearchModes && !enableLLMModes) {
        logger.systemLog("No valid API keys found - modes requiring API keys will be disabled");
      } else {
        if (!enableSearchModes) {
          logger.systemLog("Search modes disabled");
        }
        if (!enableLLMModes) {
          logger.systemLog("LLM modes disabled - no valid LLM API keys configured");
        }
      }

      logger.systemLog(`Agent initialization completed - ${this.registrationStatus.initializedAgents}/${this.registrationStatus.totalAgents} agents initialized`);

      // Mark as initialized so subsequent calls return immediately
      this.isInitialized = true;

      return new Map(agents.map(agent => [agent.name, agent]));

    } catch (error) {
      this.registrationStatus.registrationDuration = Date.now() - startTime;
      // Clear the promise so initialization can be retried
      this.initializationPromise = null;

      logger.systemError(error as Error, 'Agent Registration');
      throw new NexusError(
        NexusErrorCode.InternalError,
        'Failed to initialize agents',
        error
      );
    }
  }

  /**
   * Helper to get memory settings from plugin
   */
  private getMemorySettings(): { enabled?: boolean } {
    const pluginWithSettings = this.plugin as Plugin & { settings?: { settings?: { memory?: { enabled?: boolean } } } };
    return pluginWithSettings?.settings?.settings?.memory ?? { enabled: false };
  }

  /**
   * Safe initialization wrapper with error handling
   */
  private async safeInitialize(agentName: string, initFn: () => Promise<void>): Promise<void> {
    try {
      await initFn();
    } catch (error) {
      this.initializationErrors[agentName] = error as Error;
      logger.systemError(error as Error, `${agentName} Agent Initialization`);
    }
  }

  /**
   * Gets registered agent by name.
   * Triggers lazy initialization if agents haven't been initialized yet.
   */
  getAgent(name: string): any | null {
    // Trigger lazy initialization if not yet initialized
    if (!this.isInitialized && !this.initializationPromise) {
      // Start initialization in background - caller may need to retry
      this.initializeAllAgents().catch(err => {
        logger.systemError(err as Error, 'Lazy Agent Initialization');
      });
    }

    try {
      return this.agentManager.getAgent(name);
    } catch (error) {
      return null;
    }
  }

  /**
   * Gets all registered agents.
   * Triggers lazy initialization if agents haven't been initialized yet.
   */
  getAllAgents(): Map<string, any> {
    // Trigger lazy initialization if not yet initialized
    if (!this.isInitialized && !this.initializationPromise) {
      // Start initialization in background - caller may need to retry
      this.initializeAllAgents().catch(err => {
        logger.systemError(err as Error, 'Lazy Agent Initialization');
      });
    }

    const agents = this.agentManager.getAgents();
    return new Map(agents.map(agent => [agent.name, agent]));
  }

  /**
   * Async version of getAgent that waits for initialization to complete.
   * Use this when you need guaranteed agent availability.
   */
  async getAgentAsync(name: string): Promise<any | null> {
    // Ensure agents are initialized
    if (!this.isInitialized) {
      await this.initializeAllAgents();
    }

    try {
      return this.agentManager.getAgent(name);
    } catch (error) {
      return null;
    }
  }

  /**
   * Async version of getAllAgents that waits for initialization to complete.
   * Use this when you need guaranteed agent availability.
   */
  async getAllAgentsAsync(): Promise<Map<string, any>> {
    // Ensure agents are initialized
    if (!this.isInitialized) {
      await this.initializeAllAgents();
    }

    const agents = this.agentManager.getAgents();
    return new Map(agents.map(agent => [agent.name, agent]));
  }

  /**
   * Check if agents have been initialized
   */
  isAgentsInitialized(): boolean {
    return this.isInitialized;
  }

  /**
   * Registers agents with server
   */
  registerAgentsWithServer(registerFunction: (agent: any) => void): void {
    try {
      const agents = this.agentManager.getAgents();

      for (const agent of agents) {
        registerFunction(agent);
      }

      logger.systemLog(`Registered ${agents.length} agents with server`);
    } catch (error) {
      logger.systemError(error as Error, 'Agent Server Registration');
      throw new NexusError(
        NexusErrorCode.InternalError,
        'Failed to register agents with server',
        error
      );
    }
  }

  /**
   * Gets agent registration status
   */
  getRegistrationStatus(): AgentRegistrationStatus {
    return { ...this.registrationStatus };
  }

  /**
   * Gets the AppManager instance (available after PHASE 3 initialization)
   */
  getAppManager(): AppManager | null {
    return this.appManagerInstance;
  }
}
