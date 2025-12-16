import { App } from 'obsidian';
import { BaseAgent } from '../baseAgent';
import { VaultLibrarianConfig } from '../../config/agents';
import {
  SearchContentMode,
  SearchDirectoryMode,
  SearchMemoryMode,
  BatchMode
} from './modes';
import { MemorySettings, DEFAULT_MEMORY_SETTINGS } from '../../types';
import { MemoryService } from "../memoryManager/services/MemoryService";
import { WorkspaceService } from '../../services/WorkspaceService';
import { IStorageAdapter } from '../../database/interfaces/IStorageAdapter';
import { EmbeddingService } from '../../services/embeddings/EmbeddingService';
import { getErrorMessage } from '../../utils/errorUtils';
import { getNexusPlugin } from '../../utils/pluginLocator';

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
  private searchContentMode: SearchContentMode | null = null;
  private settings: MemorySettings;
  
  /**
   * Create a new VaultLibrarianAgent
   * @param app Obsidian app instance
   * @param enableVectorModes Whether to enable vector-based modes (legacy parameter)
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
      let plugin: any = null;
      try {
        if (app.plugins) {
          plugin = getNexusPlugin(app);
          if (plugin) {
            const pluginAny = plugin as any;
            const memorySettings = pluginAny.settings?.settings?.memory;
            if (memorySettings) {
              this.settings = memorySettings;
            }

            if (pluginAny.serviceContainer) {
              if (!this.memoryService) {
                this.memoryService = pluginAny.serviceContainer.getIfReady('memoryService');
              }
              if (!this.workspaceService) {
                this.workspaceService = pluginAny.serviceContainer.getIfReady('workspaceService');
              }
              // Get SQLite storage adapter for memory search
              if (!this.storageAdapter) {
                this.storageAdapter = pluginAny.serviceContainer.getIfReady('hybridStorageAdapter');
              }
              // Get EmbeddingService for semantic search
              if (!this.embeddingService) {
                this.embeddingService = pluginAny.serviceContainer.getIfReady('embeddingService');
              }
            }
          }
        }
      } catch (error) {
        console.warn('[VaultLibrarian] Failed to access plugin services:', error);
      }
    }
    
    // Get plugin reference for modes that need it
    let pluginRef: any = null;
    try {
      if (app.plugins) {
        pluginRef = getNexusPlugin(app);
      }
    } catch (error) {
      console.warn('[VaultLibrarian] Failed to get plugin reference:', error);
    }

    // Register ContentSearchMode (fuzzy + keyword + semantic search)
    this.searchContentMode = new SearchContentMode(
      pluginRef || ({ app } as any) // Fallback to minimal plugin interface if not found
    );
    // Wire up EmbeddingService for semantic search if available
    if (this.embeddingService) {
      this.searchContentMode.setEmbeddingService(this.embeddingService);
    }
    this.registerMode(this.searchContentMode);

    // Register focused search modes with enhanced validation and service integration
    this.registerMode(new SearchDirectoryMode(
      pluginRef || ({ app } as any),
      this.workspaceService || undefined
    ));


    this.registerMode(new SearchMemoryMode(
      pluginRef || ({ app } as any),
      this.memoryService || undefined,
      this.workspaceService || undefined,
      this.storageAdapter || undefined  // SQLite storage adapter for memory trace search
    ));
    
    // Always register BatchMode (supports both semantic and non-semantic users)
    this.registerMode(new BatchMode(
      pluginRef || ({ app } as any), // Fallback to minimal plugin interface if not found
      this.memoryService || undefined,
      this.workspaceService || undefined,
      this.storageAdapter || undefined
    ));
    
    
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
