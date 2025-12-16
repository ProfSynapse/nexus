// Location: src/services/storage/FileSystemService.ts
// File system utility for managing conversations/ and workspaces/ directories
// Used by: IndexManager, ConversationService, WorkspaceService, DataMigrationService
// Dependencies: Obsidian Plugin API for file system operations

import { normalizePath, Plugin } from 'obsidian';
import { VaultOperations } from '../../core/VaultOperations';
import { IndividualConversation, IndividualWorkspace, ConversationIndex, WorkspaceIndex } from '../../types/storage/StorageTypes';

export class FileSystemService {
  private plugin: Plugin;
  private conversationsPath: string;
  private workspacesPath: string;

  constructor(plugin: Plugin, private vaultOperations: VaultOperations) {
    this.plugin = plugin;
    // Store in vault root for Obsidian Sync compatibility
    this.conversationsPath = normalizePath('.conversations');
    this.workspacesPath = normalizePath('.workspaces');
  }

  /**
   * Ensure conversations/ directory exists
   */
  async ensureConversationsDirectory(): Promise<void> {
    await this.vaultOperations.ensureDirectory(this.conversationsPath);
  }

  /**
   * Ensure workspaces/ directory exists
   */
  async ensureWorkspacesDirectory(): Promise<void> {
    await this.vaultOperations.ensureDirectory(this.workspacesPath);
  }

  /**
   * Write individual conversation file
   */
  async writeConversation(id: string, data: IndividualConversation): Promise<void> {
    await this.ensureConversationsDirectory();
    const filePath = normalizePath(`${this.conversationsPath}/${id}.json`);
    const jsonString = JSON.stringify(data, null, 2);
    await this.vaultOperations.writeFile(filePath, jsonString);
  }

  /**
   * Read individual conversation file
   */
  async readConversation(id: string): Promise<IndividualConversation | null> {
    const filePath = normalizePath(`${this.conversationsPath}/${id}.json`);
    const content = await this.vaultOperations.readFile(filePath);
    
    if (!content) return null;
    
    try {
      const data = JSON.parse(content);
      return data;
    } catch (error) {
      return null;
    }
  }

  /**
   * Delete individual conversation file
   */
  async deleteConversation(id: string): Promise<void> {
    const filePath = normalizePath(`${this.conversationsPath}/${id}.json`);
    await this.vaultOperations.deleteFile(filePath);
  }

  /**
   * List all conversation IDs
   */
  async listConversationIds(): Promise<string[]> {
    try {
      const files = await this.vaultOperations.listDirectory(this.conversationsPath);
      const conversationIds = files.files
        .filter(file => file.endsWith('.json') && !file.endsWith('index.json'))
        .map(file => {
          const filename = file.split('/').pop() || '';
          return filename.replace('.json', '');
        });
      return conversationIds;
    } catch (error) {
      return [];
    }
  }

  /**
   * Write individual workspace file
   */
  async writeWorkspace(id: string, data: IndividualWorkspace): Promise<void> {
    const filePath = normalizePath(`${this.workspacesPath}/${id}.json`);
    const jsonString = JSON.stringify(data, null, 2);
    await this.vaultOperations.writeFile(filePath, jsonString);
  }

  /**
   * Read individual workspace file
   */
  async readWorkspace(id: string): Promise<IndividualWorkspace | null> {
    const filePath = normalizePath(`${this.workspacesPath}/${id}.json`);
    const content = await this.vaultOperations.readFile(filePath);
    
    if (!content) return null;

    try {
      const data = JSON.parse(content);
      return data;
    } catch (error) {
      return null;
    }
  }

  /**
   * Delete individual workspace file
   */
  async deleteWorkspace(id: string): Promise<void> {
    const filePath = normalizePath(`${this.workspacesPath}/${id}.json`);
    await this.vaultOperations.deleteFile(filePath);
  }

  /**
   * List all workspace IDs
   */
  async listWorkspaceIds(): Promise<string[]> {
    try {
      const files = await this.vaultOperations.listDirectory(this.workspacesPath);
      const workspaceIds = files.files
        .filter(file => file.endsWith('.json') && !file.endsWith('index.json'))
        .map(file => {
          const filename = file.split('/').pop() || '';
          return filename.replace('.json', '');
        });
      return workspaceIds;
    } catch (error) {
      return [];
    }
  }

  /**
   * Read conversation index file
   */
  async readConversationIndex(): Promise<ConversationIndex | null> {
    const filePath = normalizePath(`${this.conversationsPath}/index.json`);
    const content = await this.vaultOperations.readFile(filePath);
    
    if (!content) return null;

    try {
      const data = JSON.parse(content);
      return data;
    } catch (error) {
      return null;
    }
  }

  /**
   * Write conversation index file
   */
  async writeConversationIndex(index: ConversationIndex): Promise<void> {
    const filePath = normalizePath(`${this.conversationsPath}/index.json`);
    const jsonString = JSON.stringify(index, null, 2);
    await this.vaultOperations.writeFile(filePath, jsonString);
  }

  /**
   * Read workspace index file
   */
  async readWorkspaceIndex(): Promise<WorkspaceIndex | null> {
    const filePath = normalizePath(`${this.workspacesPath}/index.json`);
    const content = await this.vaultOperations.readFile(filePath);
    
    if (!content) return null;

    try {
      const data = JSON.parse(content);
      return data;
    } catch (error) {
      return null;
    }
  }

  /**
   * Write workspace index file
   */
  async writeWorkspaceIndex(index: WorkspaceIndex): Promise<void> {
    const filePath = normalizePath(`${this.workspacesPath}/index.json`);
    const jsonString = JSON.stringify(index, null, 2);
    await this.vaultOperations.writeFile(filePath, jsonString);
  }

  /**
   * Check if conversations directory exists
   */
  async conversationsDirectoryExists(): Promise<boolean> {
    return await this.vaultOperations.folderExists(this.conversationsPath);
  }

  /**
   * Check if workspaces directory exists
   */
  async workspacesDirectoryExists(): Promise<boolean> {
    return await this.vaultOperations.folderExists(this.workspacesPath);
  }

  /**
   * Read legacy ChromaDB collection for migration
   */
  async readChromaCollection(collectionName: string): Promise<any[]> {
    const chromaPath = normalizePath(`${this.plugin.manifest.dir}/data/chroma-db/collections/${collectionName}/items.json`);
    const content = await this.vaultOperations.readFile(chromaPath);
    
    if (!content) return [];

    try {
      const data = JSON.parse(content);
      const items = data.items || [];
      return items;
    } catch (error) {
      return [];
    }
  }

  /**
   * Get conversations directory path
   */
  getConversationsPath(): string {
    return this.conversationsPath;
  }

  /**
   * Get workspaces directory path
   */
  getWorkspacesPath(): string {
    return this.workspacesPath;
  }

  /**
   * Get ChromaDB path for migration detection
   */
  getChromaPath(): string {
    return normalizePath(`${this.plugin.manifest.dir}/data/chroma-db`);
  }
}