import { BaseAgent } from '../baseAgent';
import {
  ListPromptsTool,
  GetPromptTool,
  CreatePromptTool,
  UpdatePromptTool,
  ArchivePromptTool,
  ListModelsTool,
  ExecutePromptsTool,
  GenerateImageTool,
  SubagentTool,
} from './tools';
import type { SubagentExecutor } from '../../services/chat/SubagentExecutor';
import type { SubagentToolContext } from './tools/subagent';
import { CustomPromptStorageService } from './services/CustomPromptStorageService';
import { Settings } from '../../settings';
import { sanitizeVaultName } from '../../utils/vaultUtils';
import { LLMProviderManager } from '../../services/llm/providers/ProviderManager';
import { AgentManager } from '../../services/AgentManager';
import { UsageTracker } from '../../services/UsageTracker';
import { Vault, EventRef } from 'obsidian';
import { LLMSettingsNotifier } from '../../services/llm/LLMSettingsNotifier';
import { LLMProviderSettings } from '../../types';

/**
 * PromptManager Agent for custom prompt operations
 */
export class PromptManagerAgent extends BaseAgent {
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
   * Subagent tool - stored for later executor wiring
   */
  private subagentTool: SubagentTool;

  /**
   * Create a new PromptManagerAgent with dependency injection
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
      'promptManager',
      'Manage custom prompts for personalized AI interactions',
      '1.0.0'
    );

    // Store injected dependencies
    this.providerManager = providerManager;
    this.parentAgentManager = parentAgentManager;
    this.usageTracker = usageTracker;
    this.vault = vault;

    this.storageService = new CustomPromptStorageService(settings);
    this.vaultName = sanitizeVaultName(vault.getName());

    // Register prompt management tools
    this.registerTool(new ListPromptsTool(this.storageService));
    this.registerTool(new GetPromptTool(this.storageService));
    this.registerTool(new CreatePromptTool(this.storageService));
    this.registerTool(new UpdatePromptTool(this.storageService));
    this.registerTool(new ArchivePromptTool(this.storageService));

    // Register LLM tools with dependencies already available
    this.registerTool(new ListModelsTool(this.providerManager));

    // Register unified prompt execution tool (handles single and batch)
    this.registerTool(new ExecutePromptsTool(
      undefined, // plugin - not needed in constructor injection pattern
      this.providerManager.getLLMService(), // Get LLM service from provider manager
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

    // Register subagent tool (internal chat only - executor wired up separately)
    // Supports both spawn and cancel actions via action parameter
    this.subagentTool = new SubagentTool();
    this.registerTool(this.subagentTool);

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
   * Dynamic description that includes information about custom prompts
   */
  get description(): string {
    const baseDescription = 'Manage custom prompts for personalized AI interactions';

    // Prevent infinite recursion
    if (this.isGettingDescription) {
      return `[${this.vaultName}] ${baseDescription}`;
    }

    this.isGettingDescription = true;
    try {
      const customPromptsContext = this.getPromptsSummary();
      return `[${this.vaultName}] ${baseDescription}\n\n${customPromptsContext}`;
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
   * Wire up the SubagentExecutor to the subagent tool
   * Called after the executor is created (typically in ChatView or ChatService)
   * @param executor The SubagentExecutor instance
   * @param contextProvider Function that provides execution context
   */
  setSubagentExecutor(
    executor: SubagentExecutor,
    contextProvider: () => SubagentToolContext
  ): void {
    this.subagentTool.setSubagentExecutor(executor);
    this.subagentTool.setContextProvider(contextProvider);
  }

  /**
   * Get the SubagentTool instance for external access
   * @returns SubagentTool instance
   */
  getSubagentTool(): SubagentTool {
    return this.subagentTool;
  }

  /**
   * Get a summary of all available custom prompts
   * @returns Formatted string with custom prompt information
   * @private
   */
  private getPromptsSummary(): string {
    try {
      // Check if storage service is available
      if (!this.storageService) {
        return `Custom Prompts: Storage service not available`;
      }

      // Check if custom prompts feature is enabled
      if (!this.storageService.isEnabled()) {
        return `Custom Prompts: Custom prompts feature is disabled`;
      }

      // Get all custom prompts
      const customPrompts = this.storageService.getAllPrompts();

      if (!customPrompts || customPrompts.length === 0) {
        return `Custom Prompts: No custom prompts created yet`;
      }

      const enabledCount = customPrompts.filter(prompt => prompt.isEnabled).length;
      const promptSummary = [`Custom Prompts (${customPrompts.length} total, ${enabledCount} enabled):`];

      for (const prompt of customPrompts) {
        const status = prompt.isEnabled ? '✅' : '❌';
        const description = prompt.description || 'No description provided';
        promptSummary.push(`   ${status} ${prompt.name}: ${description}`);
      }

      return promptSummary.join('\n');
    } catch (error) {
      return `Custom Prompts: Error loading custom prompts (${error})`;
    }
  }
}