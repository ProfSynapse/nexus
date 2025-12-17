import { BaseAgent } from '../baseAgent';
import { AgentManagerConfig } from '../../config/agents';
import {
  ListAgentsTool,
  GetAgentTool,
  CreateAgentTool,
  UpdateAgentTool,
  DeleteAgentTool,
  ListModelsTool,
  ExecutePromptTool,
  BatchExecutePromptTool,
  GenerateImageTool
} from './tools';
import { CustomPromptStorageService } from './services/CustomPromptStorageService';
import { Settings } from '../../settings';
import { sanitizeVaultName } from '../../utils/vaultUtils';
import { LLMProviderManager } from '../../services/llm/providers/ProviderManager';
import { AgentManager } from '../../services/AgentManager';
import { UsageTracker } from '../../services/UsageTracker';
import { Vault, EventRef } from 'obsidian';
import { isModeHidden } from '../../config/toolVisibility';
import { LLMSettingsNotifier } from '../../services/llm/LLMSettingsNotifier';
import { LLMProviderSettings } from '../../types';

/**
 * AgentManager Agent for custom prompt operations
 */
export class AgentManagerAgent extends BaseAgent {
  /**
   * Custom prompt storage service
   */
  private storageService: CustomPromptStorageService;

  /**
   * Vault name for multi-vault support
   */
  private vaultName: string;

  /**
   * Flag to prevent infinite recursion in description getter
   */
  private isGettingDescription = false;

  /**
   * LLM Provider Manager for model operations
   */
  private readonly providerManager: LLMProviderManager;

  /**
   * Agent Manager for inter-agent communication
   */
  private readonly parentAgentManager: AgentManager;

  /**
   * Usage Tracker for LLM cost tracking
   */
  private readonly usageTracker: UsageTracker;

  /**
   * Vault instance for image generation
   */
  private readonly vault: Vault;

  /**
   * EventRef for settings change listener (Obsidian Events API)
   */
  private settingsEventRef: EventRef | null = null;

  /**
   * Create a new AgentManagerAgent with dependency injection
   * @param settings Settings instance for prompt storage
   * @param providerManager LLM Provider Manager for model operations
   * @param parentAgentManager Agent Manager for inter-agent communication
   * @param usageTracker Usage Tracker for LLM cost tracking
   * @param vault Vault instance for image generation
   */
  constructor(
    settings: Settings,
    providerManager: LLMProviderManager,
    parentAgentManager: AgentManager,
    usageTracker: UsageTracker,
    vault: Vault
  ) {
    super(
      AgentManagerConfig.name,
      AgentManagerConfig.description,
      AgentManagerConfig.version
    );

    // Store injected dependencies
    this.providerManager = providerManager;
    this.parentAgentManager = parentAgentManager;
    this.usageTracker = usageTracker;
    this.vault = vault;

    this.storageService = new CustomPromptStorageService(settings);
    this.vaultName = sanitizeVaultName(vault.getName());

    // Register prompt management tools
    this.registerTool(new ListAgentsTool(this.storageService));
    this.registerTool(new GetAgentTool(this.storageService));
    this.registerTool(new CreateAgentTool(this.storageService));
    this.registerTool(new UpdateAgentTool(this.storageService));
    this.registerTool(new DeleteAgentTool(this.storageService));

    // Register LLM tools with dependencies already available
    this.registerTool(new ListModelsTool(this.providerManager));

    // Conditionally register ExecutePromptTool based on visibility config
    if (!isModeHidden('agentManager', 'executePrompt')) {
      this.registerTool(new ExecutePromptTool({
        providerManager: this.providerManager,
        promptStorage: this.storageService,
        agentManager: this.parentAgentManager,
        usageTracker: this.usageTracker
      }));
    }

    this.registerTool(new BatchExecutePromptTool(
      undefined, // plugin - not needed in constructor injection pattern
      undefined, // llmService - will be resolved internally
      this.providerManager,
      this.parentAgentManager,
      this.storageService
    ));

    // Register image generation tool only if Google or OpenRouter API keys are configured
    const llmProviders = settings.settings.llmProviders;
    const hasGoogleKey = llmProviders?.providers?.google?.apiKey && llmProviders?.providers?.google?.enabled;
    const hasOpenRouterKey = llmProviders?.providers?.openrouter?.apiKey && llmProviders?.providers?.openrouter?.enabled;

    if (hasGoogleKey || hasOpenRouterKey) {
      this.registerTool(new GenerateImageTool({
        vault: this.vault,
        llmSettings: llmProviders
      }));
    }

    // Subscribe to settings changes to dynamically register/unregister tools (Obsidian Events API)
    this.settingsEventRef = LLMSettingsNotifier.onSettingsChanged((newSettings) => {
      this.handleSettingsChange(newSettings);
    });
  }

  /**
   * Handle LLM provider settings changes
   * Dynamically registers/unregisters GenerateImageTool based on API key availability
   */
  private handleSettingsChange(settings: LLMProviderSettings): void {
    const hasGoogleKey = settings.providers?.google?.apiKey && settings.providers?.google?.enabled;
    const hasOpenRouterKey = settings.providers?.openrouter?.apiKey && settings.providers?.openrouter?.enabled;
    const shouldHaveGenerateImage = hasGoogleKey || hasOpenRouterKey;
    const hasGenerateImage = this.hasTool('generateImage');

    if (shouldHaveGenerateImage && !hasGenerateImage) {
      // Register the tool - API key now available
      this.registerTool(new GenerateImageTool({
        vault: this.vault,
        llmSettings: settings
      }));
    } else if (!shouldHaveGenerateImage && hasGenerateImage) {
      // Unregister the tool - API key removed
      this.unregisterTool('generateImage');
    } else if (shouldHaveGenerateImage && hasGenerateImage) {
      // Update the existing tool with new settings
      this.unregisterTool('generateImage');
      this.registerTool(new GenerateImageTool({
        vault: this.vault,
        llmSettings: settings
      }));
    }
  }

  /**
   * Clean up resources when the agent is unloaded
   */
  onunload(): void {
    // Unsubscribe from settings changes (Obsidian Events API)
    if (this.settingsEventRef) {
      LLMSettingsNotifier.unsubscribe(this.settingsEventRef);
      this.settingsEventRef = null;
    }
  }

  /**
   * Dynamic description that includes information about custom prompt agents
   */
  get description(): string {
    const baseDescription = AgentManagerConfig.description;
    
    // Prevent infinite recursion
    if (this.isGettingDescription) {
      return `[${this.vaultName}] ${baseDescription}`;
    }
    
    this.isGettingDescription = true;
    try {
      const customAgentsContext = this.getAgentsSummary();
      return `[${this.vaultName}] ${baseDescription}\n\n${customAgentsContext}`;
    } finally {
      this.isGettingDescription = false;
    }
  }
  
  /**
   * Get the storage service for direct access if needed
   * @returns CustomPromptStorageService instance
   */
  getStorageService(): CustomPromptStorageService {
    return this.storageService;
  }

  /**
   * Get the LLM Provider Manager
   * @returns LLM Provider Manager instance
   */
  getProviderManager(): LLMProviderManager {
    return this.providerManager;
  }

  /**
   * Get the Usage Tracker
   * @returns Usage Tracker instance
   */
  getUsageTracker(): UsageTracker {
    return this.usageTracker;
  }

  /**
   * Get the parent Agent Manager
   * @returns Agent Manager instance
   */
  getParentAgentManager(): AgentManager {
    return this.parentAgentManager;
  }

  /**
   * Get the Vault instance
   * @returns Vault instance
   */
  getVault(): Vault {
    return this.vault;
  }

  /**
   * Get a summary of all available custom prompt agents
   * @returns Formatted string with custom prompt agent information
   * @private
   */
  private getAgentsSummary(): string {
    try {
      // Check if storage service is available
      if (!this.storageService) {
        return `🤖 Custom Agents: Storage service not available`;
      }

      // Check if custom prompts feature is enabled
      if (!this.storageService.isEnabled()) {
        return `🤖 Custom Agents: Custom prompts feature is disabled`;
      }

      // Get all custom prompt agents
      const customPrompts = this.storageService.getAllPrompts();
      
      if (!customPrompts || customPrompts.length === 0) {
        return `🤖 Custom Agents: No custom prompt agents created yet`;
      }

      const enabledCount = customPrompts.filter(prompt => prompt.isEnabled).length;
      const agentSummary = [`🤖 Custom Agents (${customPrompts.length} total, ${enabledCount} enabled):`];
      
      for (const prompt of customPrompts) {
        const status = prompt.isEnabled ? '✅' : '❌';
        const description = prompt.description || 'No description provided';
        agentSummary.push(`   ${status} ${prompt.name}: ${description}`);
      }

      return agentSummary.join('\n');
    } catch (error) {
      return `🤖 Custom Agents: Error loading custom prompt agents (${error})`;
    }
  }
}