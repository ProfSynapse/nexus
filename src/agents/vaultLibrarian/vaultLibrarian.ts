import { App, Plugin } from 'obsidian';
import { BaseAgent } from '../baseAgent';
import { VaultLibrarianConfig } from '../../config/agents';
import {
  SearchContentTool,
  SearchDirectoryTool,
  SearchMemoryTool,
  BatchTool
} from './tools';
import { MemorySettings, DEFAULT_MEMORY_SETTINGS } from '../../types';
import { MemoryService } from "../memoryManager/services/MemoryService";
import { WorkspaceService } from '../../services/WorkspaceService';
import { IStorageAdapter } from '../../database/interfaces/IStorageAdapter';
import { EmbeddingService } from '../../services/embeddings/EmbeddingService';
import { getErrorMessage } from '../../utils/errorUtils';
import { getNexusPlugin } from '../../utils/pluginLocator';
import { ServiceManager } from '../../core/ServiceManager';

/**
 * Interface for accessing NexusPlugin services
 * Represents the plugin structure needed by VaultLibrarian for service access
 */
interface NexusPluginWithServices extends Plugin {
  settings?: {
    settings?: {
      memory?: MemorySettings;
    };
  };
  getServiceContainer?(): ServiceManager;
}

/**
 * Agent for searching and navigating the vault
 * Provides comprehensive search capabilities across vault content
 */
export class VaultLibrarianAgent extends BaseAgent {
  public app: App;
  private memoryService: MemoryService | null = null;
  private workspaceService: WorkspaceService | null = null;
  private storageAdapter: IStorageAdapter | null = null;
  private embeddingService: EmbeddingService | null = null;
  private searchContentTool: SearchContentTool | null = null;
  private settings: MemorySettings;
  
  /**
   * Create a new VaultLibrarianAgent
   * @param app Obsidian app instance
   * @param enableVectorModes Whether to enable vector-based tools (legacy parameter)
   * @param memoryService Optional injected memory service
   * @param workspaceService Optional injected workspace service
   */
  constructor(
    app: App,
    enableVectorModes = false,
    memoryService?: MemoryService | null,
    workspaceService?: WorkspaceService | null
  ) {
    super(
      VaultLibrarianConfig.name,
      VaultLibrarianConfig.description,
      VaultLibrarianConfig.version
    );

    this.app = app;

    // Initialize with default settings
    this.settings = { ...DEFAULT_MEMORY_SETTINGS };

    // Use injected services if provided
    this.memoryService = memoryService || null;
    this.workspaceService = workspaceService || null;

    // If services not injected, try to get them from plugin (backward compatibility)
    if (!this.memoryService || !this.workspaceService) {
      let plugin: NexusPluginWithServices | null = null;
      try {
        if (app.plugins) {
          plugin = getNexusPlugin<NexusPluginWithServices>(app);
          if (plugin) {
            const memorySettings = plugin.settings?.settings?.memory;
            if (memorySettings) {
              this.settings = memorySettings;
            }

            const serviceContainer = plugin.getServiceContainer?.();
            if (serviceContainer) {
              if (!this.memoryService) {
                this.memoryService = serviceContainer.getServiceIfReady<MemoryService>('memoryService');
              }
              if (!this.workspaceService) {
                this.workspaceService = serviceContainer.getServiceIfReady<WorkspaceService>('workspaceService');
              }
              // Get SQLite storage adapter for memory search
              if (!this.storageAdapter) {
                this.storageAdapter = serviceContainer.getServiceIfReady<IStorageAdapter>('hybridStorageAdapter');
              }
              // Get EmbeddingService for semantic search
              if (!this.embeddingService) {
                this.embeddingService = serviceContainer.getServiceIfReady<EmbeddingService>('embeddingService');
              }
            }
          }
        }
      } catch (error) {
        console.warn('[VaultLibrarian] Failed to access plugin services:', error);
      }
    }
    
    // Get plugin reference for tools that need it
    let pluginRef: Plugin | null = null;
    try {
      if (app.plugins) {
        pluginRef = getNexusPlugin(app);
      }
    } catch (error) {
      console.warn('[VaultLibrarian] Failed to get plugin reference:', error);
    }

    // Create minimal plugin fallback if plugin not found
    // Tools accept Plugin interface which only requires app property
    const pluginOrFallback: Plugin = pluginRef || this.createMinimalPlugin(app);

    // Register ContentSearchTool (fuzzy + keyword + semantic search)
    this.searchContentTool = new SearchContentTool(pluginOrFallback);
    // Wire up EmbeddingService for semantic search if available
    if (this.embeddingService) {
      this.searchContentTool.setEmbeddingService(this.embeddingService);
    }
    this.registerTool(this.searchContentTool);

    // Register focused search tools with enhanced validation and service integration
    this.registerTool(new SearchDirectoryTool(
      pluginOrFallback,
      this.workspaceService || undefined
    ));


    this.registerTool(new SearchMemoryTool(
      pluginOrFallback,
      this.memoryService || undefined,
      this.workspaceService || undefined,
      this.storageAdapter || undefined  // SQLite storage adapter for memory trace search
    ));

    // Always register BatchTool (supports both semantic and non-semantic users)
    this.registerTool(new BatchTool(
      pluginOrFallback,
      this.memoryService || undefined,
      this.workspaceService || undefined,
      this.storageAdapter || undefined
    ));
    
    
  }
  
  
  /**
   * Create a minimal Plugin interface for tools when actual plugin is unavailable
   * This satisfies the Plugin interface requirements with stub implementations
   *
   * Uses 'as unknown as Plugin' because we're creating a stub object that only implements
   * the subset of Plugin methods actually used by the tools (primarily app property).
   * The Plugin class is abstract and cannot be instantiated directly.
   */
  private createMinimalPlugin(app: App): Plugin {
    // Create a minimal object that satisfies what tools actually use from Plugin
    // Tools primarily access plugin.app, so we provide that and stub the rest
    return {
      app,
      manifest: {
        id: 'vault-librarian-fallback',
        name: 'VaultLibrarian Fallback',
        version: '1.0.0',
        minAppVersion: '0.0.0',
        description: 'Fallback plugin interface',
        author: 'System',
        isDesktopOnly: false
      },
      // Stub implementations for Plugin methods
      onload: () => {},
      addCommand: () => ({ id: '', name: '', callback: () => {} }),
      removeCommand: () => {},
      addRibbonIcon: () => document.createElement('div'),
      loadData: async () => ({}),
      saveData: async () => {},
      registerView: () => {},
      registerHoverLinkSource: () => {},
      registerExtensions: () => {},
      registerMarkdownPostProcessor: () => {},
      registerMarkdownCodeBlockProcessor: () => {},
      registerEditorExtension: () => {},
      registerObsidianProtocolHandler: () => {},
      registerEditorSuggest: () => {},
      onExternalSettingsChange: () => {},
      addStatusBarItem: () => document.createElement('div'),
      addSettingTab: () => {},
      registerDomEvent: () => {},
      registerScopeEvent: () => {},
      registerInterval: () => 0,
      register: () => {},
      onUserEnable: () => {},
      // Component methods (Plugin extends Component)
      load: () => {},
      unload: () => {},
      addChild: <T>(component: T): T => component,
      removeChild: () => {},
      registerEvent: () => {}
    } as unknown as Plugin;
  }

  /**
   * Update the agent settings
   * @param settings New memory settings
   */
  async updateSettings(settings: MemorySettings): Promise<void> {
    this.settings = settings;
  }
  
  /**
   * Initialize the VaultLibrarianAgent
   * This is called after the agent is registered with the agent manager
   */
  async initialize(): Promise<void> {
    await super.initialize();
    
    // Initialize search service in background - non-blocking
    this.initializeSearchService().catch(error => {
    });
  }
  
  /**
   * Initialize the search service
   */
  async initializeSearchService(): Promise<void> {
    // Search service initialization for JSON-based storage
  }

  
  /**
   * Clean up resources when the agent is unloaded
   */
  onunload(): void {
    try {
      // Call parent class onunload if it exists
      super.onunload?.();
    } catch (error) {
    }
  }
}
