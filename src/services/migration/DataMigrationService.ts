// Location: src/services/migration/DataMigrationService.ts
// Migration service for converting ChromaDB to split-file architecture
// Used by: main.ts during plugin initialization to migrate from ChromaDB to conversations/ and workspaces/
// Dependencies: FileSystemService, IndexManager, ChromaDataLoader, DataTransformer

import { Plugin } from 'obsidian';
import { FileSystemService } from '../storage/FileSystemService';
import { IndexManager } from '../storage/IndexManager';
import { ChromaDataLoader } from './ChromaDataLoader';
import { DataTransformer } from './DataTransformer';

export interface MigrationStatus {
  isRequired: boolean;
  hasLegacyData: boolean;
  migrationComplete: boolean;
}

export interface MigrationResult {
  success: boolean;
  conversationsMigrated: number;
  workspacesMigrated: number;
  sessionsMigrated: number;
  tracesMigrated: number;
  errors: string[];
  migrationTime: number;
}

interface ChromaDataSummary {
  totalItems: number;
  collections: Record<string, number>;
  oldestItem?: number;
  newestItem?: number;
}

interface ChromaAccessTest {
  accessible: string[];
  missing: string[];
  errors: string[];
}

export class DataMigrationService {
  private chromaLoader: ChromaDataLoader;
  private transformer: DataTransformer;

  constructor(
    private plugin: Plugin,
    private fileSystem: FileSystemService,
    private indexManager: IndexManager
  ) {
    this.chromaLoader = new ChromaDataLoader(fileSystem);
    this.transformer = new DataTransformer();
  }

  /**
   * Check if migration is needed
   */
  async checkMigrationStatus(): Promise<MigrationStatus> {
    // Check if new structure already exists
    const conversationsExist = await this.fileSystem.conversationsDirectoryExists();
    const workspacesExist = await this.fileSystem.workspacesDirectoryExists();

    if (conversationsExist && workspacesExist) {
      return {
        isRequired: false,
        hasLegacyData: false,
        migrationComplete: true
      };
    }

    // Check for legacy ChromaDB data
    const hasLegacyData = await this.chromaLoader.detectLegacyData();

    return {
      isRequired: hasLegacyData,
      hasLegacyData,
      migrationComplete: false
    };
  }

  /**
   * Initialize fresh directories and empty index files for first-time users
   */
  async initializeFreshDirectories(): Promise<void> {
    // Create conversations/ and workspaces/ directories
    await this.fileSystem.ensureConversationsDirectory();
    await this.fileSystem.ensureWorkspacesDirectory();

    // Create empty index files with proper structure
    const emptyConversationIndex = {
      conversations: {},
      byTitle: {},
      byContent: {},
      byVault: {},
      byDateRange: [],
      lastUpdated: Date.now()
    };
    await this.fileSystem.writeConversationIndex(emptyConversationIndex);

    const emptyWorkspaceIndex = {
      workspaces: {},
      byName: {},
      byDescription: {},
      byFolder: {},
      sessionsByWorkspace: {},
      lastUpdated: Date.now()
    };
    await this.fileSystem.writeWorkspaceIndex(emptyWorkspaceIndex);
  }

  /**
   * Perform migration from ChromaDB to split-file structure
   */
  async performMigration(): Promise<MigrationResult> {
    const startTime = Date.now();
    const result: MigrationResult = {
      success: false,
      conversationsMigrated: 0,
      workspacesMigrated: 0,
      sessionsMigrated: 0,
      tracesMigrated: 0,
      errors: [],
      migrationTime: 0
    };

    try {
      // Step 1: Create conversations/ and workspaces/ directories
      await this.fileSystem.ensureConversationsDirectory();
      await this.fileSystem.ensureWorkspacesDirectory();

      // Step 2: Get data summary for reporting
      await this.chromaLoader.getDataSummary();

      // Step 3: Load all ChromaDB collections
      const chromaData = await this.chromaLoader.loadAllCollections();

      // Step 4: Transform to split-file structure
      const { conversations, workspaces } = this.transformer.transformToNewStructure(chromaData);

      // Step 5: Write conversation files
      for (const conversation of conversations) {
        try {
          await this.fileSystem.writeConversation(conversation.id, conversation);
          result.conversationsMigrated++;
        } catch (error) {
          console.error(`[DataMigrationService] Failed to write conversation ${conversation.id}:`, error);
          result.errors.push(`Failed to write conversation ${conversation.id}`);
        }
      }

      // Step 6: Build and write conversation index
      const conversationIndex = this.indexManager.buildConversationSearchIndices(conversations);
      await this.fileSystem.writeConversationIndex(conversationIndex);

      // Step 7: Write workspace files
      for (const workspace of workspaces) {
        try {
          await this.fileSystem.writeWorkspace(workspace.id, workspace);
          result.workspacesMigrated++;

          // Count sessions and traces
          result.sessionsMigrated += Object.keys(workspace.sessions).length;
          for (const session of Object.values(workspace.sessions)) {
            result.tracesMigrated += Object.keys(session.memoryTraces).length;
          }
        } catch (error) {
          console.error(`[DataMigrationService] Failed to write workspace ${workspace.id}:`, error);
          result.errors.push(`Failed to write workspace ${workspace.id}`);
        }
      }

      // Step 8: Build and write workspace index
      const workspaceIndex = this.indexManager.buildWorkspaceSearchIndices(workspaces);
      await this.fileSystem.writeWorkspaceIndex(workspaceIndex);

      // Step 9: Clean up legacy data folder (optional - can be done manually)

      result.success = true;
      result.migrationTime = Date.now() - startTime;

    } catch (error) {
      console.error('[DataMigrationService] Migration failed:', error);
      result.errors.push(`Migration failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }

    result.migrationTime = Date.now() - startTime;
    return result;
  }

  /**
   * Ensure all conversations have metadata field (idempotent)
   * Can be run multiple times safely - only updates conversations without metadata
   */
  async ensureConversationMetadata(): Promise<{ updated: number; errors: string[] }> {
    const result = {
      updated: 0,
      errors: [] as string[]
    };

    try {
      const conversationIds = await this.fileSystem.listConversationIds();

      for (const id of conversationIds) {
        try {
          const conversation = await this.fileSystem.readConversation(id);

          if (conversation && !conversation.metadata) {
            conversation.metadata = {};
            await this.fileSystem.writeConversation(id, conversation);
            result.updated++;
          }
        } catch (error) {
          const errorMsg = `Failed to update conversation ${id}: ${error instanceof Error ? error.message : String(error)}`;
          console.error('[DataMigrationService]', errorMsg);
          result.errors.push(errorMsg);
        }
      }

    } catch (error) {
      const errorMsg = `Failed to list conversations: ${error instanceof Error ? error.message : String(error)}`;
      console.error('[DataMigrationService]', errorMsg);
      result.errors.push(errorMsg);
    }

    return result;
  }

  /**
   * Get detailed information about the migration for debugging
   */
  async getMigrationInfo(): Promise<{
    chromaDataSummary?: ChromaDataSummary;
    conversationsExist: boolean;
    workspacesExist: boolean;
    accessTest?: ChromaAccessTest;
    errors: string[];
  }> {
    const info: {
      chromaDataSummary?: ChromaDataSummary;
      conversationsExist: boolean;
      workspacesExist: boolean;
      accessTest?: ChromaAccessTest;
      errors: string[];
    } = {
      conversationsExist: false,
      workspacesExist: false,
      errors: []
    };

    try {
      // Check if new structure exists
      info.conversationsExist = await this.fileSystem.conversationsDirectoryExists();
      info.workspacesExist = await this.fileSystem.workspacesDirectoryExists();

      // Test ChromaDB access
      info.accessTest = await this.chromaLoader.testCollectionAccess();

      // Get data summary if possible
      if (info.accessTest && info.accessTest.accessible.length > 0) {
        info.chromaDataSummary = await this.chromaLoader.getDataSummary();
      }
    } catch (error) {
      info.errors.push(`Error getting migration info: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }

    return info;
  }

  /**
   * Rebuild indexes from existing split-file structure
   */
  async rebuildIndexes(): Promise<{ success: boolean; error?: string }> {
    try {
      // Rebuild conversation index
      await this.indexManager.rebuildConversationIndex();

      // Rebuild workspace index
      await this.indexManager.rebuildWorkspaceIndex();

      return { success: true };
    } catch (error) {
      console.error('[DataMigrationService] Failed to rebuild indexes:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }
}