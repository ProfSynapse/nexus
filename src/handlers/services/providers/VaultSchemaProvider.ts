/**
 * VaultSchemaProvider - Dynamic vault structure injection for VaultManager tool schemas
 * Location: /src/handlers/services/providers/VaultSchemaProvider.ts
 * 
 * This file provides dynamic enhancement of VaultManager tool schemas by injecting
 * current vault folder and file structure information. Uses the Obsidian Vault API
 * to query vault structure and enhance tool descriptions and parameter schemas
 * with contextual vault information for better Claude understanding.
 */

import { ISchemaProvider, EnhancedJSONSchema } from '../../interfaces/ISchemaProvider';
import { BaseSchemaProvider } from '../BaseSchemaProvider';
import { App, TFile, TFolder } from 'obsidian';
import { logger } from '../../../utils/logger';
import { FileUtils } from '../../../database/utils/FileUtils';

interface VaultStructureInfo {
  rootFolders: Array<{
    name: string;
    fileCount: number;
    subfolderCount: number;
  }>;
  rootFileCount: number;
  totalFiles: number;
  totalFolders: number;
  recentFiles: Array<{
    name: string;
    path: string;
    folder?: string;
  }>;
}

interface CachedVaultData {
  structure: VaultStructureInfo;
  timestamp: number;
  vaultName: string;
}

/**
 * Schema provider that injects current vault structure into VaultManager tool schemas
 * Extends BaseSchemaProvider to provide vault-specific context for file operations
 */
export class VaultSchemaProvider extends BaseSchemaProvider {
  readonly name = 'VaultSchemaProvider';
  readonly description = 'Injects current vault structure into VaultManager tool schemas for better context';
  
  private cache: CachedVaultData | null = null;
  private readonly CACHE_DURATION_MS = 30000; // 30 seconds
  private readonly MAX_FOLDERS_TO_SHOW = 10;
  private readonly MAX_FILES_TO_SHOW = 8;
  private readonly MAX_DEPTH = 2; // Root + 1 sublevel
  private app: App;

  constructor(app: App) {
    super();
    this.app = app;
  }

  /**
   * Get provider priority (higher numbers = higher priority)
   * VaultSchemaProvider has medium priority
   */
  getPriority(): number {
    return 50;
  }

  /**
   * Check if tool name should be enhanced by this provider
   * Only enhances VaultManager tools
   */
  protected shouldEnhanceToolName(toolName: string): boolean {
    // Check if this is a VaultManager tool
    return toolName.toLowerCase().includes('vault') || 
           toolName.toLowerCase().includes('vaultmanager');
  }

  /**
   * Enhance the schema with vault structure information
   * Adds vault context to relevant parameters and descriptions
   */
  async enhanceSchema(toolName: string, baseSchema: EnhancedJSONSchema): Promise<EnhancedJSONSchema> {
    return this.safeEnhance(async () => {
      const vaultInfo = await this.getVaultStructure();
      if (!vaultInfo) {
        return baseSchema;
      }

      // Deep clone to avoid modifying original using BaseSchemaProvider utility
      const enhanced = this.cloneSchema(baseSchema);

      // Enhance the schema based on available modes and properties
      this.enhanceSchemaWithVaultContext(enhanced, vaultInfo);
      
      // Log enhancement activity for debugging
      this.logEnhancement(toolName, 'Added vault structure context', {
        rootFolders: vaultInfo.rootFolders.length,
        totalFiles: vaultInfo.totalFiles
      });

      return enhanced;
    }, baseSchema, 'vault structure enhancement');
  }

  /**
   * Get vault structure information with caching
   * Limits depth to avoid schema bloat while providing useful context
   */
  private async getVaultStructure(): Promise<VaultStructureInfo | null> {
    try {
      // Check cache first
      const now = Date.now();
      if (this.cache && (now - this.cache.timestamp) < this.CACHE_DURATION_MS) {
        return this.cache.structure;
      }

      const markdownFiles = this.app.vault.getMarkdownFiles();
      const rootFolder = this.app.vault.getRoot();

      // Get root folders with file counts
      const rootFolders = rootFolder.children
        .filter(child => child instanceof TFolder)
        .slice(0, this.MAX_FOLDERS_TO_SHOW) // Limit to prevent schema bloat
        .map(folder => {
          const typedFolder = folder as TFolder;
          const filesInFolder = markdownFiles.filter(file => 
            file.path.startsWith(typedFolder.path + '/')
          ).length;

          const subfolderCount = typedFolder.children
            .filter(child => child instanceof TFolder)
            .length;

          return {
            name: typedFolder.name,
            fileCount: filesInFolder,
            subfolderCount
          };
        });

      // Get root files count
      const rootFileCount = markdownFiles.filter(file => !file.path.includes('/')).length;

      // Get recent files for examples
      const recentFiles = markdownFiles
        .sort((a, b) => b.stat.mtime - a.stat.mtime)
        .slice(0, this.MAX_FILES_TO_SHOW)
        .map(file => ({
          name: file.name,
          path: file.path,
          folder: file.path.includes('/') ? file.path.split('/')[0] : undefined
        }));

      const structure: VaultStructureInfo = {
        rootFolders,
        rootFileCount,
        totalFiles: markdownFiles.length,
        totalFolders: rootFolders.length,
        recentFiles
      };

      // Update cache
      this.cache = {
        structure,
        timestamp: now,
        vaultName: this.app.vault.getName()
      };

      return structure;
    } catch (error) {
      logger.systemError(error as Error, 'VaultSchemaProvider: Failed to get vault structure');
      return null;
    }
  }

  /**
   * Enhance schema with vault structure context
   * Adds contextual information to relevant parameters
   */
  private enhanceSchemaWithVaultContext(schema: EnhancedJSONSchema, vaultInfo: VaultStructureInfo): void {
    try {
      // Add vault structure information to the schema description
      if (schema.description) {
        const vaultContext = this.formatVaultStructureForDescription(vaultInfo);
        schema.description = `${schema.description}\n\n${vaultContext}`;
      }

      // Enhance properties based on their names and types
      if (schema.properties) {
        this.enhancePropertiesWithVaultContext(schema.properties, vaultInfo);
      }

      // Enhance conditional schemas in allOf array (used by ToolListService)
      if (schema.allOf && Array.isArray(schema.allOf)) {
        schema.allOf.forEach((condition) => {
          if (condition.then && typeof condition.then === 'object' && 'properties' in condition.then) {
            const thenSchema = condition.then as { properties: EnhancedJSONSchema['properties'] };
            if (thenSchema.properties) {
              this.enhancePropertiesWithVaultContext(thenSchema.properties, vaultInfo);
            }
          }
        });
      }
    } catch (error) {
      logger.systemWarn(`VaultSchemaProvider: Failed to enhance schema with vault context: ${String(error)}`);
    }
  }

  /**
   * Enhance individual properties with vault context
   */
  private enhancePropertiesWithVaultContext(properties: EnhancedJSONSchema['properties'], vaultInfo: VaultStructureInfo): void {
    if (!properties) return;
    Object.keys(properties).forEach(propName => {
      const prop = properties[propName] as EnhancedJSONSchema;

      // Enhance path-related properties
      if (this.isPathProperty(propName) && prop.type === 'string') {
        this.enhancePathProperty(prop, propName, vaultInfo);
      }

      // Enhance mode enum with contextual information
      if (propName === 'mode' && prop.enum && Array.isArray(prop.enum)) {
        this.enhanceModeProperty(prop, vaultInfo);
      }
    });
  }

  /**
   * Check if a property name indicates a file/folder path
   */
  private isPathProperty(propName: string): boolean {
    const pathKeywords = ['path', 'file', 'folder', 'directory', 'target', 'source', 'note'];
    return pathKeywords.some(keyword => propName.toLowerCase().includes(keyword));
  }

  /**
   * Enhance path properties with vault examples and context
   */
  private enhancePathProperty(prop: EnhancedJSONSchema, propName: string, vaultInfo: VaultStructureInfo): void {
    // Add vault-specific examples based on property type
    if (propName.toLowerCase().includes('folder') || propName.toLowerCase().includes('directory')) {
      // Folder-related properties
      const folderExamples = vaultInfo.rootFolders.slice(0, 3).map(f => f.name);
      if (folderExamples.length > 0) {
        prop.examples = folderExamples;
        
        prop.description = prop.description + 
          `\n\nAvailable folders: ${folderExamples.join(', ')}` +
          (vaultInfo.rootFolders.length > 3 ? ` (and ${vaultInfo.rootFolders.length - 3} more)` : '');
      }
    } else if (propName.toLowerCase().includes('file') || propName.toLowerCase().includes('note')) {
      // File-related properties
      const fileExamples = vaultInfo.recentFiles.slice(0, 3).map(f => f.path);
      if (fileExamples.length > 0) {
        prop.examples = fileExamples;
        
        prop.description = prop.description + 
          `\n\nRecent files: ${fileExamples.join(', ')}`;
      }
    } else {
      // General path properties (could be files or folders)
      const pathExamples = vaultInfo.rootFolders.slice(0, 2).map(f => f.name)
        .concat(vaultInfo.recentFiles.slice(0, 2).map(f => f.path));
      
      if (pathExamples.length > 0) {
        prop.examples = pathExamples.slice(0, 4);
        
        prop.description = prop.description + 
          `\n\nExample paths: ${pathExamples.slice(0, 3).join(', ')}`;
      }
    }
  }

  /**
   * Enhance mode property with contextual descriptions
   */
  private enhanceModeProperty(prop: EnhancedJSONSchema, vaultInfo: VaultStructureInfo): void {
    // Add vault context to mode description
    prop.description = prop.description + 
      `\n\nCurrent vault has ${vaultInfo.totalFiles} files in ${vaultInfo.totalFolders} folders.`;
  }

  /**
   * Format vault structure for schema description
   * Follows existing VaultManagerAgent.getVaultStructureSummary() pattern
   */
  private formatVaultStructureForDescription(structure: VaultStructureInfo): string {
    const summary = [
      `📁 Vault Structure: ${structure.totalFiles} files, ${structure.totalFolders} root folders`
    ];

    if (structure.rootFileCount > 0) {
      summary.push(`   └── / (${structure.rootFileCount} files in root)`);
    }

    // Add folder structure (limited to prevent schema bloat)
    structure.rootFolders.slice(0, 5).forEach(folder => {
      const subfolderText = folder.subfolderCount > 0 ? `, ${folder.subfolderCount} subfolders` : '';
      summary.push(`   └── ${folder.name}/ (${folder.fileCount} files${subfolderText})`);
    });

    if (structure.rootFolders.length > 5) {
      summary.push(`   └── ... and ${structure.rootFolders.length - 5} more folders`);
    }

    // Add recent files as examples
    if (structure.recentFiles.length > 0) {
      summary.push(`\n📄 Recent files: ${structure.recentFiles.slice(0, 4).map(f => f.name).join(', ')}`);
    }

    return summary.join('\n');
  }

  /**
   * Clear cache (useful for testing or vault changes)
   */
  clearCache(): void {
    this.cache = null;
  }
}