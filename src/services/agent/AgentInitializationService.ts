/**
 * Location: src/services/agent/AgentInitializationService.ts
 *
 * Purpose: Handles individual agent initialization logic
 * Extracted from AgentRegistrationService.ts to follow Single Responsibility Principle
 *
 * Used by: AgentRegistrationService for agent creation
 * Dependencies: Agent implementations, ServiceManager
 */

import { App, Plugin } from 'obsidian';
import NexusPlugin from '../../main';
import { AgentManager } from '../AgentManager';
import { ServiceManager } from '../../core/ServiceManager';
import {
  ContentManagerAgent,
  CommandManagerAgent,
  VaultManagerAgent,
  VaultLibrarianAgent,
  MemoryManagerAgent,
  AgentManagerAgent
} from '../../agents';
import { logger } from '../../utils/logger';
import { CustomPromptStorageService } from "../../agents/agentManager/services/CustomPromptStorageService";
import { LLMProviderManager } from '../llm/providers/ProviderManager';
import { DEFAULT_LLM_PROVIDER_SETTINGS, MCPSettings, MemorySettings } from '../../types';
import { Settings } from '../../settings';
import { MemoryService } from '../../agents/memoryManager/services/MemoryService';
import { WorkspaceService } from '../WorkspaceService';
import { VaultOperations } from '../../core/VaultOperations';
import { UsageTracker } from '../UsageTracker';

/**
 * Type guard to check if plugin has Settings
 */
function hasSettings(plugin: Plugin | NexusPlugin): plugin is NexusPlugin {
  return 'settings' in plugin && plugin.settings !== undefined;
}

/**
 * Type guard to check if plugin has services
 */
function hasServices(plugin: Plugin | NexusPlugin): plugin is NexusPlugin & { services: Record<string, unknown> } {
  return 'services' in plugin && typeof plugin.services === 'object' && plugin.services !== null;
}

/**
 * Service for initializing individual agents
 */
export class AgentInitializationService {
  constructor(
    private app: App,
    private plugin: Plugin | NexusPlugin,
    private agentManager: AgentManager,
    private serviceManager?: ServiceManager,
    private customPromptStorage?: CustomPromptStorageService
  ) {}

  /**
   * Initialize ContentManager agent
   */
  async initializeContentManager(): Promise<void> {
    const contentManagerAgent = new ContentManagerAgent(
      this.app,
      hasSettings(this.plugin) ? this.plugin : undefined
    );

    this.agentManager.registerAgent(contentManagerAgent);
    logger.systemLog('ContentManager agent initialized successfully');
  }

  /**
   * Initialize CommandManager agent
   */
  async initializeCommandManager(): Promise<void> {
    const commandManagerAgent = new CommandManagerAgent(this.app);
    this.agentManager.registerAgent(commandManagerAgent);
    logger.systemLog('CommandManager agent initialized successfully');
  }

  /**
   * Initialize VaultManager agent
   */
  async initializeVaultManager(): Promise<void> {
    const vaultManagerAgent = new VaultManagerAgent(this.app);

    this.agentManager.registerAgent(vaultManagerAgent);
    logger.systemLog('VaultManager agent initialized successfully');
  }

  /**
   * Initialize AgentManager agent
   */
  async initializeAgentManager(enableLLMModes: boolean): Promise<void> {
    if (!this.customPromptStorage) {
      // Try to create custom prompt storage directly if settings are available
      if (hasSettings(this.plugin)) {
        try {
          this.customPromptStorage = new CustomPromptStorageService(this.plugin.settings);
          logger.systemLog('AgentManager - created custom prompt storage during initialization');
        } catch (error) {
          logger.systemError(error as Error, 'AgentManager - Failed to create custom prompt storage');
          return;
        }
      } else {
        logger.systemError(new Error('Plugin settings not available'), 'AgentManager agent initialization');
        return;
      }
    }

    // Initialize LLM Provider Manager if LLM modes are enabled
    let llmProviderManager: LLMProviderManager | null = null;
    let usageTracker: UsageTracker | null = null;

    if (enableLLMModes) {
      try {
        // Get LLM provider settings from plugin settings or use defaults
        const pluginSettings = hasSettings(this.plugin) ? this.plugin.settings.settings : undefined;
        const llmProviderSettings = pluginSettings?.llmProviders || DEFAULT_LLM_PROVIDER_SETTINGS;

        // Create LLM Provider Manager with vault for Nexus (WebLLM) support
        llmProviderManager = new LLMProviderManager(llmProviderSettings, this.app.vault);

        if (this.serviceManager) {
          try {
            const vaultOperations = await this.serviceManager.getService('vaultOperations');
            if (vaultOperations) {
              llmProviderManager.setVaultOperations(vaultOperations);
            }
          } catch (error) {
          }
        }

        // Create usage tracker
        const { UsageTracker } = await import('../UsageTracker');
        usageTracker = new UsageTracker('llm', pluginSettings);

      } catch (error) {
        logger.systemError(error as Error, 'LLM Provider Manager Initialization');
        // Continue without LLM modes - basic prompt management will still work
      }
    } else {
      logger.systemLog('LLM modes disabled - AgentManager will function with prompt management only');
    }

    // Create AgentManagerAgent with constructor injection
    if (llmProviderManager && usageTracker && hasSettings(this.plugin)) {
      const agentManagerAgent = new AgentManagerAgent(
        this.plugin.settings,
        llmProviderManager,
        this.agentManager,
        usageTracker,
        this.app.vault
      );

      this.agentManager.registerAgent(agentManagerAgent);
      logger.systemLog(`AgentManager agent created with full LLM support - LLM modes enabled: ${enableLLMModes}`);
    } else {
      // Create basic AgentManager with minimal dependencies for prompt management
      try {
        // Create minimal LLM provider manager and usage tracker for basic functionality
        const pluginSettings = hasSettings(this.plugin) ? this.plugin.settings.settings : undefined;
        const llmProviderSettings = pluginSettings?.llmProviders || DEFAULT_LLM_PROVIDER_SETTINGS;

        const minimalProviderManager = new LLMProviderManager(llmProviderSettings, this.app.vault);
        const minimalUsageTracker = new UsageTracker('llm', pluginSettings);

        if (!hasSettings(this.plugin)) {
          logger.systemError(new Error('Plugin settings not available for basic AgentManager'), 'Basic AgentManager Creation');
          return;
        }

        const agentManagerAgent = new AgentManagerAgent(
          this.plugin.settings,
          minimalProviderManager,
          this.agentManager,
          minimalUsageTracker,
          this.app.vault
        );

        this.agentManager.registerAgent(agentManagerAgent);
        logger.systemLog('AgentManager agent created with basic support - LLM features may be limited');
      } catch (basicError) {
        logger.systemError(basicError as Error, 'Basic AgentManager Creation');
        logger.systemLog('AgentManager agent creation failed - prompt management features unavailable');
      }
    }
  }

  /**
   * Initialize VaultLibrarian agent
   */
  async initializeVaultLibrarian(enableSearchModes: boolean, memorySettings: MemorySettings): Promise<void> {
    // Get required services
    let memoryService: MemoryService | null = null;
    let workspaceService: WorkspaceService | null = null;

    if (this.serviceManager) {
      memoryService = this.serviceManager.getServiceIfReady<MemoryService>('memoryService');
      workspaceService = this.serviceManager.getServiceIfReady<WorkspaceService>('workspaceService');
    } else if (hasServices(this.plugin)) {
      // Fallback to plugin's direct service access
      memoryService = this.plugin.services.memoryService as MemoryService | undefined || null;
      workspaceService = this.plugin.services.workspaceService as WorkspaceService | undefined || null;
    }

    const vaultLibrarianAgent = new VaultLibrarianAgent(
      this.app,
      enableSearchModes,  // Pass search modes enabled status
      memoryService,
      workspaceService
    );

    // Update VaultLibrarian with memory settings
    if (memorySettings) {
      vaultLibrarianAgent.updateSettings(memorySettings);
    }

    this.agentManager.registerAgent(vaultLibrarianAgent);
    logger.systemLog('VaultLibrarian agent initialized successfully');
  }

  /**
   * Initialize MemoryManager agent
   */
  async initializeMemoryManager(): Promise<void> {
    // Get required services - try ServiceManager first, then plugin direct access
    let memoryService: MemoryService | null = null;
    let workspaceService: WorkspaceService | null = null;

    if (this.serviceManager) {
      memoryService = this.serviceManager.getServiceIfReady<MemoryService>('memoryService');
      workspaceService = this.serviceManager.getServiceIfReady<WorkspaceService>('workspaceService');
    } else if (hasServices(this.plugin)) {
      // Fallback to plugin's direct service access
      memoryService = this.plugin.services.memoryService as MemoryService | undefined || null;
      workspaceService = this.plugin.services.workspaceService as WorkspaceService | undefined || null;
    }

    if (!memoryService || !workspaceService) {
      logger.systemError(new Error(`Required services not available - memoryService: ${!!memoryService}, workspaceService: ${!!workspaceService}`), 'MemoryManager Agent Initialization');
      return;
    }

    const memoryManagerAgent = new MemoryManagerAgent(
      this.app,
      this.plugin,
      memoryService,
      workspaceService
    );

    this.agentManager.registerAgent(memoryManagerAgent);
    logger.systemLog('MemoryManager agent initialized successfully');
  }
}
