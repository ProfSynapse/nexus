import { App, TFile, TFolder } from 'obsidian';
import { BaseAgent } from '../baseAgent';
import {
  ListTool,
  CreateFolderTool,
  MoveTool,
  CopyTool,
  ArchiveTool,
  OpenTool
} from './tools';
import { sanitizeVaultName } from '../../utils/vaultUtils';

/**
 * Agent for file system operations in storage
 * Environment-agnostic: works with Obsidian vault, filesystem, cloud storage, etc.
 */
export class StorageManagerAgent extends BaseAgent {
  private app: App;
  private vaultName: string;
  private isGettingDescription = false;

  /**
   * Create a new StorageManagerAgent
   * @param app Obsidian app instance
   */
  constructor(app: App) {
    super(
      'storageManager',
      'File system operations for storage',
      '1.0.0'
    );

    this.app = app;
    this.vaultName = sanitizeVaultName(app.vault.getName());

    // Register simplified CRUA tools - lazy loaded
    this.registerLazyTool({
      slug: 'list', name: 'List',
      description: 'List contents of a directory',
      version: '1.0.0',
      factory: () => new ListTool(app),
    });
    this.registerLazyTool({
      slug: 'createFolder', name: 'Create Folder',
      description: 'Create a new folder in the vault',
      version: '1.0.0',
      factory: () => new CreateFolderTool(app),
    });
    this.registerLazyTool({
      slug: 'move', name: 'Move',
      description: 'Move or rename a file or folder',
      version: '1.0.0',
      factory: () => new MoveTool(app),
    });
    this.registerLazyTool({
      slug: 'copy', name: 'Copy',
      description: 'Duplicate a file',
      version: '1.0.0',
      factory: () => new CopyTool(app),
    });
    this.registerLazyTool({
      slug: 'archive', name: 'Archive',
      description: 'Safely archive a file or folder (moves to .archive/ with timestamp)',
      version: '1.0.0',
      factory: () => new ArchiveTool(app),
    });
    this.registerLazyTool({
      slug: 'open', name: 'Open',
      description: 'Open a file in the editor',
      version: '1.0.0',
      factory: () => new OpenTool(app),
    });
  }

  /**
   * Dynamic description that includes current storage structure
   */
  get description(): string {
    const baseDescription = 'File system operations for storage';

    // Prevent infinite recursion
    if (this.isGettingDescription) {
      return `[${this.vaultName}] ${baseDescription}`;
    }

    this.isGettingDescription = true;
    try {
      const storageContext = this.getStorageStructureSummary();
      return `[${this.vaultName}] ${baseDescription}\n\n${storageContext}`;
    } finally {
      this.isGettingDescription = false;
    }
  }

  /**
   * Get a summary of the storage structure
   * @returns Formatted string with storage structure information
   * @private
   */
  private getStorageStructureSummary(): string {
    try {
      const markdownFiles = this.app.vault.getMarkdownFiles();
      const rootFolder = this.app.vault.getRoot();

      // Get root folders (folders directly in storage root)
      const rootFolders = rootFolder.children
        .filter(child => child instanceof TFolder)
        .map(folder => folder.name)
        .sort(); // Sort alphabetically for consistent display

      // Count files in each root folder
      const folderStructure: string[] = [];

      for (const folderName of rootFolders) {
        const filesInFolder = markdownFiles.filter(file =>
          file.path.startsWith(folderName + '/')
        ).length;
        folderStructure.push(`   └── ${folderName}/ (${filesInFolder} files)`);
      }

      // Count files in root
      const rootFiles = markdownFiles.filter(file =>
        !file.path.includes('/')
      ).length;

      const summary = [
        `📁 Storage Structure: ${markdownFiles.length} files, ${rootFolders.length} root folders`
      ];

      if (rootFiles > 0) {
        summary.push(`   └── / (${rootFiles} files in root)`);
      }

      summary.push(...folderStructure);

      return summary.join('\n');
    } catch (error) {
      return `📁 Storage Structure: Unable to load storage information (${error})`;
    }
  }
}
