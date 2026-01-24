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
import { AgentFactoryRegistry } from '../../core/ServiceFactory';
import { NexusError, NexusErrorCode } from '../../utils/errors';
import { logger } from '../../utils/logger';
import { CustomPromptStorageService } from "../../agents/promptManager/services/CustomPromptStorageService";
import { AgentInitializationService } from './AgentInitializationService';
import { AgentValidationService } from './AgentValidationService';

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
}

export interface AgentRegistrationStatus {
  totalAgents: number;
  initializedAgents: number;
  failedAgents: number;
  initializationErrors: Record<string, Error>;
  registrationTime: Date;
  registrationDuration: number;
}

export class AgentRegistrationService implements AgentRegistrationServiceInterface {
  private agentManager: AgentManager;
  private registrationStatus: AgentRegistrationStatus;
  private initializationErrors: Record<string, Error> = {};
  private factoryRegistry: AgentFactoryRegistry;
  private initializationService: AgentInitializationService;
  private validationService: AgentValidationService;

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
    this.factoryRegistry = new AgentFactoryRegistry();
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
   * Initializes all configured agents using ServiceManager and constructor injection
   */
  async initializeAllAgentsWithServiceManager(): Promise<Map<string, any>> {
    if (!this.serviceManager) {
      throw new Error('ServiceManager is required for dependency injection');
    }

    const startTime = Date.now();
    this.registrationStatus.registrationTime = new Date();
    this.initializationErrors = {};

    try {
      logger.systemLog('Initializing agents with ServiceManager dependency injection...');

      const agentNames = ['contentManager', 'storageManager', 'searchManager', 'memoryManager', 'promptManager', 'canvasManager'];
      const initializedAgents = new Map<string, any>();

      for (const agentName of agentNames) {
        try {
          await this.initializeAgentWithFactory(agentName);
          const agent = this.agentManager.getAgent(agentName);
          if (agent) {
            initializedAgents.set(agentName, agent);
          }
        } catch (error) {
          this.initializationErrors[agentName] = error as Error;
          logger.systemError(error as Error, `${agentName} Agent Initialization`);
        }
      }

      // Calculate final statistics
      this.registrationStatus = {
        totalAgents: agentNames.length,
        initializedAgents: initializedAgents.size,
        failedAgents: Object.keys(this.initializationErrors).length,
        initializationErrors: this.initializationErrors,
        registrationTime: this.registrationStatus.registrationTime,
        registrationDuration: Date.now() - startTime
      };

      logger.systemLog(`ServiceManager-based agent initialization completed - ${this.registrationStatus.initializedAgents}/${this.registrationStatus.totalAgents} agents initialized`);

      return initializedAgents;

    } catch (error) {
      this.registrationStatus.registrationDuration = Date.now() - startTime;
      logger.systemError(error as Error, 'Agent Registration with ServiceManager');
      throw new NexusError(
        NexusErrorCode.InternalError,
        'Failed to initialize agents with ServiceManager',
        error
      );
    }
  }

  /**
   * Initialize single agent using factory pattern with dependency injection
   */
  private async initializeAgentWithFactory(agentName: string): Promise<void> {
    const factory = this.factoryRegistry.getFactory(agentName);
    if (!factory) {
      throw new Error(`No factory found for agent: ${agentName}`);
    }

    // Resolve dependencies using ServiceManager
    const dependencies = new Map<string, any>();
    for (const depName of factory.dependencies) {
      try {
        const dependency = await this.serviceManager!.getService(depName);
        dependencies.set(depName, dependency);
      } catch (error) {
        logger.systemWarn(`Optional dependency '${depName}' not available for agent '${agentName}': ${error}`);
        // For optional dependencies, continue without them
        dependencies.set(depName, null);
      }
    }

    // Create agent with injected dependencies
    const agent = await factory.create(dependencies, this.app, this.plugin);
    this.agentManager.registerAgent(agent);

    logger.systemLog(`${agentName} agent initialized successfully with dependency injection`);
  }

  /**
   * Initializes all configured agents (legacy method - maintain backward compatibility)
   */
  async initializeAllAgents(): Promise<Map<string, any>> {
    const startTime = Date.now();
    this.registrationStatus.registrationTime = new Date();
    this.initializationErrors = {};

    try {
      // Get memory settings to determine what to enable
      const pluginWithSettings = this.plugin as Plugin & { settings?: { settings?: { memory?: { enabled?: boolean } } } };
      const memorySettings = pluginWithSettings?.settings?.settings?.memory;
      const isMemoryEnabled = memorySettings?.enabled;

      // Get capability status
      const { hasValidLLMKeys, enableSearchModes, enableLLMModes } = await this.validationService.getCapabilityStatus();

      logger.systemLog(`Agent initialization started - Search modes: ${enableSearchModes}, LLM modes: ${enableLLMModes}`);

      // Log additional debugging info for AgentManager
      if (!hasValidLLMKeys) {
        logger.systemLog('LLM validation failed - AgentManager features may be limited');
      }

      // Initialize agents in order using AgentInitializationService
      await this.safeInitialize('contentManager', () => this.initializationService.initializeContentManager());
      await this.safeInitialize('storageManager', () => this.initializationService.initializeStorageManager());
      await this.safeInitialize('canvasManager', () => this.initializationService.initializeCanvasManager());
      await this.safeInitialize('promptManager', () => this.initializationService.initializePromptManager(enableLLMModes));
      await this.safeInitialize('searchManager', () => this.initializationService.initializeSearchManager(enableSearchModes, memorySettings ?? { enabled: false }));
      await this.safeInitialize('memoryManager', () => this.initializationService.initializeMemoryManager());

      // ToolManager MUST be initialized LAST - it needs all other agents to be registered
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

      return new Map(agents.map(agent => [agent.name, agent]));

    } catch (error) {
      this.registrationStatus.registrationDuration = Date.now() - startTime;

      logger.systemError(error as Error, 'Agent Registration');
      throw new NexusError(
        NexusErrorCode.InternalError,
        'Failed to initialize agents',
        error
      );
    }
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
   * Gets registered agent by name
   */
  getAgent(name: string): any | null {
    try {
      return this.agentManager.getAgent(name);
    } catch (error) {
      return null;
    }
  }

  /**
   * Gets all registered agents
   */
  getAllAgents(): Map<string, any> {
    const agents = this.agentManager.getAgents();
    return new Map(agents.map(agent => [agent.name, agent]));
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
}
