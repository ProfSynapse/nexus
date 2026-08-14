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
  StorageManagerAgent,
  SearchManagerAgent,
  MemoryManagerAgent,
  PromptManagerAgent,
  ToolManagerAgent,
  CanvasManagerAgent,
  BaseManagerAgent,
  IngestManagerAgent
} from '../../agents';
import { ensureAnalyzeViewRegistered } from '../../agents/baseManager/services/basesAvailability';
import { logger } from '../../utils/logger';
import { getErrorMessage } from '../../utils/errorUtils';
import { withTimeout } from '../../utils/withTimeout';
import { CustomPromptStorageService } from "../../agents/promptManager/services/CustomPromptStorageService";
import { LLMProviderManager } from '../llm/providers/ProviderManager';
import { DEFAULT_LLM_PROVIDER_SETTINGS, MemorySettings } from '../../types';
import { MemoryService } from '../../agents/memoryManager/services/MemoryService';
import { WorkspaceService } from '../WorkspaceService';
import { UsageTracker } from '../UsageTracker';
import type { VaultOperations } from '../../core/VaultOperations';
import type { HybridStorageAdapter } from '../../database/adapters/HybridStorageAdapter';
import type { IStorageAdapter } from '../../database/interfaces/IStorageAdapter';
import type { MigratableDatabase } from '../../database/schema/SchemaMigrator';
import { TaskBoardEvents } from '../task/TaskBoardEvents';
import type { NexusPluginWithServices } from '../../agents/memoryManager/tools/utils/pluginTypes';

/**
 * Ceiling on a live workspace lookup during tool discovery. Generous enough
 * that a cold WorkspaceService still resolves, short enough that a wedged
 * storage layer degrades discovery instead of hanging the caller.
 */
const LIVE_WORKSPACE_LOOKUP_TIMEOUT_MS = 4000;

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

interface PluginServices {
  memoryService?: MemoryService;
  workspaceService?: WorkspaceService;
}

function hasTypedServices(plugin: Plugin | NexusPlugin): plugin is NexusPlugin & { services: PluginServices } {
  return hasServices(plugin);
}

interface StorageAdapterWithCache extends IStorageAdapter {
  cache: MigratableDatabase;
}

function hasMigratableCache(adapter: IStorageAdapter): adapter is StorageAdapterWithCache {
  const ready = typeof adapter.isQueryReady === 'function' ? adapter.isQueryReady() : adapter.isReady();
  if (!ready || !('cache' in adapter)) {
    return false;
  }

  const cache = (adapter as { cache?: unknown }).cache;
  return !!cache
    && typeof cache === 'object'
    && 'exec' in cache
    && typeof (cache as Record<string, unknown>).exec === 'function'
    && 'run' in cache
    && typeof (cache as Record<string, unknown>).run === 'function';
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
  initializeContentManager(): void {
    const contentManagerAgent = new ContentManagerAgent(
      this.app,
      hasSettings(this.plugin) ? this.plugin : undefined
    );

    this.agentManager.registerAgent(contentManagerAgent);
    logger.systemLog('ContentManager agent initialized successfully');
  }

  /**
   * Initialize StorageManager agent
   */
  initializeStorageManager(): void {
    const storageManagerAgent = new StorageManagerAgent(this.app);

    this.agentManager.registerAgent(storageManagerAgent);
    logger.systemLog('StorageManager agent initialized successfully');
  }

  /**
   * Initialize CanvasManager agent
   */
  initializeCanvasManager(): void {
    const canvasManagerAgent = new CanvasManagerAgent(this.app);

    this.agentManager.registerAgent(canvasManagerAgent);
    logger.systemLog('CanvasManager agent initialized successfully');
  }

  /**
   * Initialize BaseManager agent (Obsidian Bases, `.base` files).
   *
   * Conditional by design: `registerBasesView` returns false when Bases is
   * disabled in the vault, and that one call is both the availability probe and
   * the registration Phase 3's `analyze` needs. When it fails, the agent is not
   * registered at all — `getTools` then never advertises a command that could
   * only answer "not available" (plan §3).
   *
   * Enabling Bases after startup therefore takes effect on the next reload;
   * runtime toggling is explicitly out of scope (it would need a second dynamic
   * registrar alongside AppManager — see issue #174).
   *
   * @returns whether the agent was registered
   */
  initializeBaseManager(): boolean {
    if (!ensureAnalyzeViewRegistered(this.plugin)) {
      return false;
    }

    this.agentManager.registerAgent(new BaseManagerAgent(this.app));
    logger.systemLog('BaseManager agent initialized successfully');
    return true;
  }

  /**
   * Initialize PromptManager agent
   */
  async initializePromptManager(enableLLMModes: boolean): Promise<void> {
    if (!this.customPromptStorage) {
      // Try to create custom prompt storage directly if settings are available
      if (hasSettings(this.plugin)) {
        try {
          // Pass null for db - will be set when PromptManagerAgent is created below
          this.customPromptStorage = new CustomPromptStorageService(null, this.plugin.settings);
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
            const vaultOperations = await this.serviceManager.getService<VaultOperations>('vaultOperations');
            if (vaultOperations) {
              llmProviderManager.setVaultOperations(vaultOperations);
            }
          } catch {
            void 0;
          }
        }

        // Create usage tracker
        const { UsageTracker } = await import('../UsageTracker');
        usageTracker = new UsageTracker('llm', (pluginSettings ?? {}) as Record<string, unknown>);

      } catch (error) {
        logger.systemError(error as Error, 'LLM Provider Manager Initialization');
        // Continue without LLM modes - basic prompt management will still work
      }
    } else {
      logger.systemLog('LLM modes disabled - AgentManager will function with prompt management only');
    }

    // Get database for SQLite-based prompt storage (non-blocking - uses data.json fallback if not ready)
    let db: MigratableDatabase | null = null;
    if (this.serviceManager) {
      try {
        // Use getServiceIfReady to avoid blocking on SQLite WASM loading during startup
        const storageAdapter = this.serviceManager.getServiceIfReady<IStorageAdapter>('hybridStorageAdapter');
        // Only use SQLite if adapter exists AND is fully ready (WASM loaded)
        if (storageAdapter && hasMigratableCache(storageAdapter)) {
          db = storageAdapter.cache;
        }
      } catch {
        // Database not available, will use data.json fallback
      }
    }

    // Create PromptManagerAgent with constructor injection
    if (llmProviderManager && usageTracker && hasSettings(this.plugin)) {
      const promptManagerAgent = new PromptManagerAgent(
        this.plugin.settings,
        llmProviderManager,
        this.agentManager,
        usageTracker,
        this.app,
        this.app.vault,
        db
      );

      this.agentManager.registerAgent(promptManagerAgent);
      logger.systemLog(`PromptManager agent created with full LLM support - LLM modes enabled: ${enableLLMModes}`);
    } else {
      // Create basic PromptManager with minimal dependencies for prompt management
      try {
        // Create minimal LLM provider manager and usage tracker for basic functionality
        const pluginSettings = hasSettings(this.plugin) ? this.plugin.settings.settings : undefined;
        const llmProviderSettings = pluginSettings?.llmProviders || DEFAULT_LLM_PROVIDER_SETTINGS;

        const minimalProviderManager = new LLMProviderManager(llmProviderSettings, this.app.vault);
        const minimalUsageTracker = new UsageTracker('llm', (pluginSettings ?? {}) as Record<string, unknown>);

        if (!hasSettings(this.plugin)) {
          logger.systemError(new Error('Plugin settings not available for basic PromptManager'), 'Basic PromptManager Creation');
          return;
        }

        const promptManagerAgent = new PromptManagerAgent(
          this.plugin.settings,
          minimalProviderManager,
          this.agentManager,
          minimalUsageTracker,
          this.app,
          this.app.vault,
          db
        );

        this.agentManager.registerAgent(promptManagerAgent);
        logger.systemLog('PromptManager agent created with basic support - LLM features may be limited');
      } catch (basicError) {
        logger.systemError(basicError as Error, 'Basic PromptManager Creation');
        logger.systemLog('PromptManager agent creation failed - prompt management features unavailable');
      }
    }
  }

  /**
   * Initialize SearchManager agent
   */
  initializeSearchManager(enableSearchModes: boolean, memorySettings: MemorySettings): void {
    // Get required services
    let memoryService: MemoryService | null = null;
    let workspaceService: WorkspaceService | null = null;
    const storageAdapterGetter = this.serviceManager
      ? () => this.serviceManager?.getServiceIfReady<IStorageAdapter>('hybridStorageAdapter') ?? undefined
      : undefined;

    if (this.serviceManager) {
      memoryService = this.serviceManager.getServiceIfReady<MemoryService>('memoryService');
      workspaceService = this.serviceManager.getServiceIfReady<WorkspaceService>('workspaceService');
    } else if (hasTypedServices(this.plugin)) {
      // Fallback to plugin's direct service access
      memoryService = this.plugin.services.memoryService ?? null;
      workspaceService = this.plugin.services.workspaceService ?? null;
    }

    const searchManagerAgent = new SearchManagerAgent(
      this.app,
      enableSearchModes,  // Pass search modes enabled status
      memoryService,
      workspaceService,
      storageAdapterGetter
    );

    // Update SearchManager with memory settings
    if (memorySettings) {
      void searchManagerAgent.updateSettings(memorySettings);
    }

    this.agentManager.registerAgent(searchManagerAgent);
    logger.systemLog('SearchManager agent initialized successfully');
  }

  /**
   * Initialize MemoryManager agent
   */
  initializeMemoryManager(): void {
    // Get required services - try ServiceManager first, then plugin direct access
    let memoryService: MemoryService | null = null;
    let workspaceService: WorkspaceService | null = null;

    if (this.serviceManager) {
      memoryService = this.serviceManager.getServiceIfReady<MemoryService>('memoryService');
      workspaceService = this.serviceManager.getServiceIfReady<WorkspaceService>('workspaceService');
    } else if (hasTypedServices(this.plugin)) {
      // Fallback to plugin's direct service access
      memoryService = this.plugin.services.memoryService ?? null;
      workspaceService = this.plugin.services.workspaceService ?? null;
    }

    if (!memoryService || !workspaceService) {
      logger.systemError(new Error(`Required services not available - memoryService: ${!!memoryService}, workspaceService: ${!!workspaceService}`), 'MemoryManager Agent Initialization');
      return;
    }

    const pluginWithServices = hasServices(this.plugin)
      ? (this.plugin as NexusPluginWithServices)
      : null;
    if (!pluginWithServices) {
      logger.systemError(new Error('Plugin services not available - MemoryManager agent initialization'), 'MemoryManager Agent Initialization');
      return;
    }

    const memoryManagerAgent = new MemoryManagerAgent(
      this.app,
      pluginWithServices,
      memoryService,
      workspaceService,
      this.customPromptStorage
    );

    this.agentManager.registerAgent(memoryManagerAgent);
    logger.systemLog('MemoryManager agent initialized successfully');
  }

  /**
   * Initialize TaskManager agent
   */
  async initializeTaskManager(): Promise<void> {
    if (!this.serviceManager) {
      logger.systemWarn('TaskManager requires ServiceManager — skipping');
      return;
    }

    const { TaskManagerAgent } = await import('../../agents/taskManager/taskManager');
    const { TaskService } = await import('../../agents/taskManager/services/TaskService');
    const { DAGService } = await import('../../agents/taskManager/services/DAGService');

    // Get adapter — may need to await if not yet ready
    let adapter = this.serviceManager.getServiceIfReady<HybridStorageAdapter>('hybridStorageAdapter');
    if (!adapter) {
      adapter = await this.serviceManager.getService('hybridStorageAdapter');
    }
    if (!adapter) {
      logger.systemWarn('HybridStorageAdapter not available — TaskManager skipped');
      return;
    }

    const dagService = new DAGService();

    // Workspace resolver: checks by ID first, then by name, returns resolved UUID or null
    const { resolveWorkspaceId } = await import('../../database/sync/resolveWorkspaceId');
    const sqliteCache = adapter.cache;
    const validateWorkspace = async (workspaceId: string): Promise<string | null> => {
      const result = await resolveWorkspaceId(workspaceId, sqliteCache);
      if (result.warning) {
        console.error(`[TaskService] ${result.warning}`);
      }
      // Ambiguous name — fail with nudge listing all matching UUIDs
      if (result.matchingIds && result.matchingIds.length > 1) {
        throw new Error(result.warning);
      }
      return result.id;
    };

    const taskService = new TaskService(
      adapter.projects,
      adapter.tasks,
      dagService,
      validateWorkspace,
      TaskBoardEvents,
      async () => typeof adapter.waitForQueryReady === 'function' ? adapter.waitForQueryReady() : adapter.isReady()
    );
    const taskManagerAgent = new TaskManagerAgent(this.app, this.plugin as NexusPlugin, taskService);

    this.agentManager.registerAgent(taskManagerAgent);
    logger.systemLog('TaskManager agent initialized successfully');
  }

  /**
   * Initialize IngestManager agent
   */
  initializeIngestManager(): void {
    // Lazy getter — resolves LLMProviderManager via PromptManager at call time
    const getProviderManager = (): LLMProviderManager | null => {
      try {
        const promptAgent = this.agentManager.getAgent('promptManager') as
          | { getProviderManager?: () => LLMProviderManager }
          | undefined;
        if (promptAgent?.getProviderManager) {
          return promptAgent.getProviderManager();
        }
      } catch {
        // PromptManager not available
      }
      return null;
    };

    const ingestManagerAgent = new IngestManagerAgent(this.app.vault, getProviderManager);
    this.agentManager.registerAgent(ingestManagerAgent);
    logger.systemLog('IngestManager agent initialized successfully');
  }

  /**
   * Initialize ToolManager agent
   * MUST be called AFTER all other agents are initialized
   * ToolManager needs access to all registered agents for tool discovery/execution
   */
  async initializeToolManager(): Promise<void> {
    // Get all currently registered agents as a Map
    const agents = this.agentManager.getAgents();
    const agentRegistry = new Map<string, typeof agents[0]>();
    for (const agent of agents) {
      agentRegistry.set(agent.name, agent);
    }

    // Build schema data for dynamic tool descriptions
    const schemaData = await this.buildSchemaData();

    // Create ToolManagerAgent with the full agent registry and schema data.
    // The workspace provider is passed separately: schemaData is a snapshot
    // taken here, and it is empty whenever SQLite was not query-ready yet, so
    // getTools re-reads the list at call time instead.
    const toolManagerAgent = new ToolManagerAgent(
      this.app,
      agentRegistry,
      schemaData,
      () => this.listWorkspaceSummariesLive()
    );

    this.agentManager.registerAgent(toolManagerAgent);
    logger.systemLog(`ToolManager agent initialized successfully with ${agentRegistry.size} agents`);
  }

  /**
   * Check if SQLite storage is ready for queries.
   * Returns true only when HybridStorageAdapter exists AND its WASM is fully loaded.
   */
  private isSQLiteReady(): boolean {
    if (!this.serviceManager) return false;
    const storageAdapter = this.serviceManager.getServiceIfReady<IStorageAdapter>('hybridStorageAdapter');
    if (storageAdapter) {
      if (typeof storageAdapter.isQueryReady === 'function') {
        return storageAdapter.isQueryReady();
      }
      return storageAdapter.isReady();
    }
    return false;
  }

  /**
   * List the current workspaces for the BOOT SNAPSHOT only.
   *
   * Non-blocking by design: WorkspaceService.listWorkspaces() blocks on
   * ensureInitialized(), so this returns empty rather than stalling startup
   * when SQLite is not query-ready. On desktop the storage adapter is only
   * created ~3s after background init (PluginLifecycleManager), which is after
   * agents are registered — so at boot this list is routinely empty. That is
   * acceptable here and NOT acceptable at call time; see
   * listWorkspaceSummariesLive().
   */
  private async listWorkspaceSummaries(): Promise<{ name: string; description?: string }[]> {
    try {
      let workspaceService: WorkspaceService | null = null;

      if (this.serviceManager) {
        workspaceService = this.serviceManager.getServiceIfReady<WorkspaceService>('workspaceService');
      } else if (hasTypedServices(this.plugin)) {
        workspaceService = this.plugin.services.workspaceService ?? null;
      }

      // CRITICAL: Check if SQLite is ready BEFORE calling any service methods
      if (!workspaceService || !this.isSQLiteReady()) {
        return [];
      }

      return this.toWorkspaceSummaries(await workspaceService.listWorkspaces());
    } catch {
      logger.systemWarn('Failed to fetch workspaces for schema data');
      return [];
    }
  }

  /**
   * List the current workspaces for a live discovery call.
   *
   * Deliberately does NOT reuse the boot snapshot's two gates. Both of them
   * fail open-ended: getServiceIfReady() only sees services that happen to be
   * instantiated already, and isSQLiteReady() is false until the deferred WASM
   * load finishes. An empty list here is the bug we are fixing — it is what
   * leaves an agent with no real workspace name and makes it invent one from
   * the user's phrasing.
   *
   * By the time discovery runs we are long past startup, so awaiting the
   * service is correct rather than risky. The timeout exists only so a wedged
   * storage layer degrades getTools to "no names" instead of hanging it.
   */
  private async listWorkspaceSummariesLive(): Promise<{ name: string; description?: string }[]> {
    try {
      const workspaceService = await withTimeout(
        this.resolveWorkspaceService(),
        LIVE_WORKSPACE_LOOKUP_TIMEOUT_MS,
        null
      );
      if (!workspaceService) {
        logger.systemWarn('Live workspace lookup: WorkspaceService unavailable');
        return [];
      }

      // Only report a list we can claim is COMPLETE. For a few seconds after
      // load the SQLite cache is still replaying JSONL, and listWorkspaces()
      // happily returns the partial set — measured live at 1 of 12. Callers
      // present this list as "these are the only workspaces that exist", so a
      // partial answer is worse than none: it is the same confident falsehood
      // that made agents invent names, just with different wording.
      if (!(await this.waitForQueryReady())) {
        return [];
      }

      const workspaces = await withTimeout(
        workspaceService.listWorkspaces(),
        LIVE_WORKSPACE_LOOKUP_TIMEOUT_MS,
        null
      );
      if (!workspaces) {
        logger.systemWarn('Live workspace lookup: listWorkspaces() timed out');
        return [];
      }

      return this.toWorkspaceSummaries(workspaces);
    } catch (error) {
      logger.systemWarn(`Live workspace lookup failed: ${getErrorMessage(error)}`);
      return [];
    }
  }

  /**
   * True once the SQLite cache has finished replaying JSONL and its queries
   * return the complete set. Bounded so a slow rebuild degrades discovery to
   * "no list" rather than hanging it.
   */
  private async waitForQueryReady(): Promise<boolean> {
    const adapter = this.serviceManager?.getServiceIfReady<IStorageAdapter>('hybridStorageAdapter');
    if (!adapter) {
      return false;
    }

    if (adapter.isQueryReady?.()) {
      return true;
    }

    if (typeof adapter.waitForQueryReady !== 'function') {
      // No readiness signal to consult — fall back to the coarse ready flag.
      return adapter.isReady();
    }

    return withTimeout(adapter.waitForQueryReady(), LIVE_WORKSPACE_LOOKUP_TIMEOUT_MS, false);
  }

  /**
   * Resolve WorkspaceService, instantiating it if it has not been created yet.
   */
  private async resolveWorkspaceService(): Promise<WorkspaceService | null> {
    if (this.serviceManager) {
      const ready = this.serviceManager.getServiceIfReady<WorkspaceService>('workspaceService');
      if (ready) return ready;
      return (await this.serviceManager.getService<WorkspaceService>('workspaceService')) ?? null;
    }

    if (hasTypedServices(this.plugin)) {
      return this.plugin.services.workspaceService ?? null;
    }

    return null;
  }

  private toWorkspaceSummaries(
    workspaces: { name: string; description?: string; isArchived?: boolean }[]
  ): { name: string; description?: string }[] {
    return workspaces
      .filter(workspace => !workspace.isArchived)
      .map(workspace => ({
        name: workspace.name,
        description: workspace.description
      }));
  }

  /**
   * Build schema data for ToolManager
   * Fetches workspaces, custom agents, and vault root structure
   * Non-blocking: uses JSONL/data.json fallback if SQLite isn't ready
   */
  private async buildSchemaData(): Promise<{
    workspaces: { name: string; description?: string }[];
    customAgents: { name: string; description?: string }[];
    vaultRoot: string[];
  }> {
    const schemaData: {
      workspaces: { name: string; description?: string }[];
      customAgents: { name: string; description?: string }[];
      vaultRoot: string[];
    } = {
      workspaces: [],
      customAgents: [],
      vaultRoot: []
    };

    // Fetch workspaces - NON-BLOCKING: only fetch if SQLite is ready to avoid blocking on ensureInitialized()
    schemaData.workspaces = await this.listWorkspaceSummaries();

    // Fetch custom agents - NON-BLOCKING: only fetch if SQLite is ready
    try {
      // Check if SQLite is ready before fetching prompts
      if (this.customPromptStorage && this.isSQLiteReady()) {
        // getAllPrompts is synchronous and uses data.json fallback if db is null
        const prompts = this.customPromptStorage.getAllPrompts();
        schemaData.customAgents = prompts.map(p => ({
          name: p.name,
          description: p.description
        }));
      }
      // If SQLite not ready, return empty - schema data will be populated on subsequent calls
    } catch {
      logger.systemWarn('Failed to fetch custom agents for schema data');
    }

    // Get vault root structure (top-level files and folders) - synchronous, no SQLite dependency
    try {
      const root = this.app.vault.getRoot();
      const children = root.children || [];
      schemaData.vaultRoot = children
        .map(child => child.name)
        .filter(name => !name.startsWith('.')) // Exclude hidden folders
        .sort();
    } catch {
      logger.systemWarn('Failed to fetch vault root for schema data');
    }

    return schemaData;
  }
}
