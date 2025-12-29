import { App, TFile, TFolder } from 'obsidian';
import { BaseDirectoryTool } from './baseDirectory';
import { ListParams, ListResult } from '../types';
import { createErrorMessage } from '../../../utils/errorUtils';
import { filterByName, FILTER_DESCRIPTION } from '../../../utils/filterUtils';

/**
 * Location: src/agents/storageManager/tools/list.ts
 * Purpose: List files and folders in a directory with optional filtering
 * Relationships: Uses BaseDirectoryTool for common directory operations
 */

/**
 * Tool to list directory contents
 */
export class ListTool extends BaseDirectoryTool<ListParams, ListResult> {

  /**
   * Create a new ListTool
   * @param app Obsidian app instance
   */
  constructor(app: App) {
    super(
      'list',
      'List',
      'List contents of a directory',
      '1.0.0',
      app
    );
  }

  /**
   * Execute the tool
   * @param params Tool parameters
   * @returns Promise resolving to the result
   */
  async execute(params: ListParams): Promise<ListResult> {
    try {
      // Default to vault root if no path provided
      const path = params.path ?? '';

      // Get the folder using base class method
      const parentFolder = await this.getFolder(path);
      const normalizedPath = this.normalizeDirectoryPath(path);

      // Get contents (depth 0 = current folder only)
      const allFiles = this.getFilesRecursively(parentFolder, 0);
      const allFolders = this.getFoldersRecursively(parentFolder, 0);

      // Apply filter if provided
      let filteredFiles = allFiles;
      let filteredFolders = allFolders;

      if (params.filter) {
        filteredFiles = filterByName(allFiles, params.filter);
        filteredFolders = filterByName(allFolders, params.filter);
      }

      // Prepare result data
      const result: any = {};

      // Map files to required format
      const fileData = filteredFiles.map(file => ({
        name: file.name,
        path: file.path,
        size: file.stat.size,
        created: file.stat.ctime,
        modified: file.stat.mtime
      }));

      // Sort files by modified date (newest first)
      fileData.sort((a, b) => b.modified - a.modified);
      result.files = fileData;

      // Map folders to required format
      const folderData = filteredFolders.map(folder => ({
        name: folder.name,
        path: folder.path
      }));

      // Sort folders alphabetically
      folderData.sort((a, b) => a.name.localeCompare(b.name));
      result.folders = folderData;

      // Add summary
      result.summary = {
        fileCount: filteredFiles.length,
        folderCount: filteredFolders.length,
        totalItems: filteredFiles.length + filteredFolders.length
      };

      // Generate helpful message
      const message = this.getRootDirectoryMessage(normalizedPath, 'Listing directory contents');

      return this.prepareResult(
        true,
        result,
        message
      );

    } catch (error) {
      return this.prepareResult(false, undefined, createErrorMessage('Failed to list directory contents: ', error));
    }
  }

  /**
   * Recursively get files up to specified depth
   * @param folder The folder to start from
   * @param depth The maximum depth to traverse (0 = current folder only)
   * @returns Array of files
   */
  private getFilesRecursively(folder: TFolder, depth: number): TFile[] {
    const result: TFile[] = [];

    // Get direct children that are files
    const childFiles = (folder.children || []).filter(child => child instanceof TFile) as TFile[];
    result.push(...childFiles);

    // If depth > 0, recursively get files from subfolders
    if (depth > 0) {
      const childFolders = (folder.children || []).filter(child => child instanceof TFolder) as TFolder[];
      for (const childFolder of childFolders) {
        const subFiles = this.getFilesRecursively(childFolder, depth - 1);
        result.push(...subFiles);
      }
    }

    return result;
  }

  /**
   * Recursively get folders up to specified depth
   * @param folder The folder to start from
   * @param depth The maximum depth to traverse (0 = current folder only)
   * @returns Array of folders
   */
  private getFoldersRecursively(folder: TFolder, depth: number): TFolder[] {
    const result: TFolder[] = [];

    // Get direct children that are folders
    const childFolders = (folder.children || []).filter(child => child instanceof TFolder) as TFolder[];
    result.push(...childFolders);

    // If depth > 0, recursively get subfolders
    if (depth > 0) {
      for (const childFolder of childFolders) {
        const subfolders = this.getFoldersRecursively(childFolder, depth - 1);
        result.push(...subfolders);
      }
    }

    return result;
  }

  /**
   * Get the parameter schema
   */
  getParameterSchema(): any {
    const toolSchema = {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Directory path (optional). Use empty string (""), "/" or "." for vault root. Defaults to vault root.',
          default: ''
        },
        filter: {
          type: 'string',
          description: FILTER_DESCRIPTION
        }
      },
      required: []
    };

    return this.getMergedSchema(toolSchema);
  }

  /**
   * Get the result schema
   */
  getResultSchema(): any {
    const baseSchema = super.getResultSchema();

    // Extend the base schema to include our specific data
    baseSchema.properties.data = {
      type: 'object',
      properties: {
        files: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              path: { type: 'string' },
              size: { type: 'number' },
              created: { type: 'number' },
              modified: { type: 'number' }
            }
          }
        },
        folders: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              path: { type: 'string' }
            }
          }
        },
        summary: {
          type: 'object',
          properties: {
            fileCount: { type: 'number' },
            folderCount: { type: 'number' },
            totalItems: { type: 'number' }
          }
        }
      }
    };

    return baseSchema;
  }
}
