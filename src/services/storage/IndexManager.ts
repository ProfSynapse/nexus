// Location: src/services/storage/IndexManager.ts
// Manages conversation and workspace index files with incremental updates
// Used by: ConversationService, WorkspaceService, DataMigrationService
// Dependencies: FileSystemService for index I/O, StorageTypes for structures

import { FileSystemService } from './FileSystemService';
import {
  ConversationIndex,
  WorkspaceIndex,
  IndividualConversation,
  IndividualWorkspace,
  ConversationMetadata,
  WorkspaceMetadata
} from '../../types/storage/StorageTypes';

type DateRangeBucket = ConversationIndex['byDateRange'][number];

export class IndexManager {
  constructor(private fileSystem: FileSystemService) {}

  /**
   * Load conversation index (creates empty if not exists)
   */
  async loadConversationIndex(): Promise<ConversationIndex> {
    const index = await this.fileSystem.readConversationIndex();

    if (!index) {
      const emptyIndex: ConversationIndex = {
        conversations: {},
        byTitle: {},
        byContent: {},
        byVault: {},
        byDateRange: [],
        lastUpdated: Date.now()
      };
      return emptyIndex;
    }

    return index;
  }

  /**
   * Update single conversation in index
   */
  async updateConversationInIndex(conversation: IndividualConversation): Promise<void> {
    const index = await this.loadConversationIndex();

    // Update metadata
    const metadata: ConversationMetadata = {
      id: conversation.id,
      title: conversation.title,
      created: conversation.created,
      updated: conversation.updated,
      vault_name: conversation.vault_name,
      message_count: conversation.message_count
    };

    index.conversations[conversation.id] = metadata;

    // Update search indices
    this.updateSearchIndicesForConversation(index, conversation);

    // Update timestamp
    index.lastUpdated = Date.now();

    // Save index
    await this.fileSystem.writeConversationIndex(index);
  }

  /**
   * Remove conversation from index
   */
  async removeConversationFromIndex(id: string): Promise<void> {
    const index = await this.loadConversationIndex();

    // Remove metadata
    delete index.conversations[id];

    // Remove from search indices
    this.removeFromSearchIndices(index, id);

    // Update timestamp
    index.lastUpdated = Date.now();

    // Save index
    await this.fileSystem.writeConversationIndex(index);
  }

  /**
   * Rebuild entire conversation index from all conversation files
   */
  async rebuildConversationIndex(): Promise<void> {
    const conversationIds = await this.fileSystem.listConversationIds();
    const conversations: IndividualConversation[] = [];

    // Load all conversations
    for (const id of conversationIds) {
      const conversation = await this.fileSystem.readConversation(id);
      if (conversation) {
        conversations.push(conversation);
      }
    }

    // Build index from scratch
    const index = this.buildConversationSearchIndices(conversations);

    // Save index
    await this.fileSystem.writeConversationIndex(index);
  }

  /**
   * Load workspace index (creates empty if not exists)
   */
  async loadWorkspaceIndex(): Promise<WorkspaceIndex> {
    const index = await this.fileSystem.readWorkspaceIndex();

    if (!index) {
      const emptyIndex: WorkspaceIndex = {
        workspaces: {},
        byName: {},
        byDescription: {},
        byFolder: {},
        sessionsByWorkspace: {},
        lastUpdated: Date.now()
      };
      return emptyIndex;
    }

    return index;
  }

  /**
   * Update single workspace in index
   */
  async updateWorkspaceInIndex(workspace: IndividualWorkspace): Promise<void> {
    const index = await this.loadWorkspaceIndex();

    // Calculate counts
    const sessionCount = Object.keys(workspace.sessions).length;
    let traceCount = 0;
    for (const session of Object.values(workspace.sessions)) {
      traceCount += Object.keys(session.memoryTraces).length;
    }

    // Update metadata
    const metadata: WorkspaceMetadata = {
      id: workspace.id,
      name: workspace.name,
      description: workspace.description,
      rootFolder: workspace.rootFolder,
      created: workspace.created,
      lastAccessed: workspace.lastAccessed,
      isActive: workspace.isActive,
      sessionCount,
      traceCount
    };

    index.workspaces[workspace.id] = metadata;

    // Update search indices
    this.updateSearchIndicesForWorkspace(index, workspace);

    // Update timestamp
    index.lastUpdated = Date.now();

    // Save index
    await this.fileSystem.writeWorkspaceIndex(index);
  }

  /**
   * Remove workspace from index
   */
  async removeWorkspaceFromIndex(id: string): Promise<void> {
    const index = await this.loadWorkspaceIndex();

    // Remove metadata
    delete index.workspaces[id];

    // Remove from search indices
    this.removeFromWorkspaceSearchIndices(index, id);

    // Update timestamp
    index.lastUpdated = Date.now();

    // Save index
    await this.fileSystem.writeWorkspaceIndex(index);
  }

  /**
   * Rebuild entire workspace index from all workspace files
   */
  async rebuildWorkspaceIndex(): Promise<void> {
    const workspaceIds = await this.fileSystem.listWorkspaceIds();
    const workspaces: IndividualWorkspace[] = [];

    // Load all workspaces
    for (const id of workspaceIds) {
      const workspace = await this.fileSystem.readWorkspace(id);
      if (workspace) {
        workspaces.push(workspace);
      }
    }

    // Build index from scratch
    const index = this.buildWorkspaceSearchIndices(workspaces);

    // Save index
    await this.fileSystem.writeWorkspaceIndex(index);
  }

  /**
   * Build complete conversation search indices from conversation array
   */
  buildConversationSearchIndices(conversations: IndividualConversation[]): ConversationIndex {
    const index: ConversationIndex = {
      conversations: {},
      byTitle: {},
      byContent: {},
      byVault: {},
      byDateRange: this.createDateRangeBuckets(),
      lastUpdated: Date.now()
    };

    for (const conversation of conversations) {
      // Add metadata
      index.conversations[conversation.id] = {
        id: conversation.id,
        title: conversation.title,
        created: conversation.created,
        updated: conversation.updated,
        vault_name: conversation.vault_name,
        message_count: conversation.message_count
      };

      // Add to search indices
      this.updateSearchIndicesForConversation(index, conversation);
    }

    return index;
  }

  /**
   * Build complete workspace search indices from workspace array
   */
  buildWorkspaceSearchIndices(workspaces: IndividualWorkspace[]): WorkspaceIndex {
    const index: WorkspaceIndex = {
      workspaces: {},
      byName: {},
      byDescription: {},
      byFolder: {},
      sessionsByWorkspace: {},
      lastUpdated: Date.now()
    };

    for (const workspace of workspaces) {
      // Calculate counts
      const sessionCount = Object.keys(workspace.sessions).length;
      let traceCount = 0;
      for (const session of Object.values(workspace.sessions)) {
        traceCount += Object.keys(session.memoryTraces).length;
      }

      // Add metadata
      index.workspaces[workspace.id] = {
        id: workspace.id,
        name: workspace.name,
        description: workspace.description,
        rootFolder: workspace.rootFolder,
        created: workspace.created,
        lastAccessed: workspace.lastAccessed,
        isActive: workspace.isActive,
        sessionCount,
        traceCount
      };

      // Add to search indices
      this.updateSearchIndicesForWorkspace(index, workspace);
    }

    return index;
  }

  /**
   * Update search indices for a single conversation
   */
  private updateSearchIndicesForConversation(index: ConversationIndex, conversation: IndividualConversation): void {
    const id = conversation.id;

    // Index by title
    this.addToIndex(index.byTitle, conversation.title, id);

    // Index by vault
    this.addToIndex(index.byVault, conversation.vault_name, id);

    // Index by message content
    for (const message of conversation.messages) {
      if (message.content) {
        this.addToIndex(index.byContent, message.content, id);
      }
    }

    // Add to date range bucket
    this.addToDateRangeBucket(index.byDateRange, conversation.created, id);
  }

  /**
   * Update search indices for a single workspace
   */
  private updateSearchIndicesForWorkspace(index: WorkspaceIndex, workspace: IndividualWorkspace): void {
    const id = workspace.id;

    // Index by name
    this.addToIndex(index.byName, workspace.name, id);

    // Index by description
    if (workspace.description) {
      this.addToIndex(index.byDescription, workspace.description, id);
    }

    // Index by folder
    index.byFolder[workspace.rootFolder] = id;

    // Index sessions by workspace
    index.sessionsByWorkspace[id] = Object.keys(workspace.sessions);
  }

  /**
   * Remove conversation from search indices
   */
  private removeFromSearchIndices(index: ConversationIndex, id: string): void {
    // Remove from all search index arrays
    for (const titleKey in index.byTitle) {
      index.byTitle[titleKey] = index.byTitle[titleKey].filter(convId => convId !== id);
      if (index.byTitle[titleKey].length === 0) {
        delete index.byTitle[titleKey];
      }
    }

    for (const contentKey in index.byContent) {
      index.byContent[contentKey] = index.byContent[contentKey].filter(convId => convId !== id);
      if (index.byContent[contentKey].length === 0) {
        delete index.byContent[contentKey];
      }
    }

    for (const vaultKey in index.byVault) {
      index.byVault[vaultKey] = index.byVault[vaultKey].filter(convId => convId !== id);
      if (index.byVault[vaultKey].length === 0) {
        delete index.byVault[vaultKey];
      }
    }

    // Remove from date range buckets
    for (const bucket of index.byDateRange) {
      bucket.conversationIds = bucket.conversationIds.filter(convId => convId !== id);
    }
  }

  /**
   * Remove workspace from search indices
   */
  private removeFromWorkspaceSearchIndices(index: WorkspaceIndex, id: string): void {
    // Remove from all search index arrays
    for (const nameKey in index.byName) {
      index.byName[nameKey] = index.byName[nameKey].filter(wsId => wsId !== id);
      if (index.byName[nameKey].length === 0) {
        delete index.byName[nameKey];
      }
    }

    for (const descKey in index.byDescription) {
      index.byDescription[descKey] = index.byDescription[descKey].filter(wsId => wsId !== id);
      if (index.byDescription[descKey].length === 0) {
        delete index.byDescription[descKey];
      }
    }

    // Remove from folder index
    for (const folder in index.byFolder) {
      if (index.byFolder[folder] === id) {
        delete index.byFolder[folder];
      }
    }

    // Remove from sessions index
    delete index.sessionsByWorkspace[id];
  }

  /**
   * Add text to search index (tokenizes and indexes words)
   */
  private addToIndex(index: Record<string, string[]>, text: string, id: string): void {
    if (!text || typeof text !== 'string') return;

    // Split text into words and clean them
    const words = text.toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(word => word.length > 2);

    for (const word of words) {
      if (!index[word]) index[word] = [];
      if (!index[word].includes(id)) {
        index[word].push(id);
      }
    }
  }

  /**
   * Create monthly date range buckets for the last 12 months
   */
  private createDateRangeBuckets(): Array<{ start: number; end: number; conversationIds: string[] }> {
    const buckets = [];
    const now = Date.now();
    const oneMonth = 30 * 24 * 60 * 60 * 1000;

    for (let i = 0; i < 12; i++) {
      const end = now - (i * oneMonth);
      const start = end - oneMonth;
      buckets.push({
        start,
        end,
        conversationIds: []
      });
    }

    return buckets;
  }

  /**
   * Add conversation to appropriate date range bucket
   */
  private addToDateRangeBucket(buckets: DateRangeBucket[], timestamp: number, id: string): void {
    for (const bucket of buckets) {
      if (timestamp >= bucket.start && timestamp < bucket.end) {
        if (!bucket.conversationIds.includes(id)) {
          bucket.conversationIds.push(id);
        }
        break;
      }
    }
  }
}