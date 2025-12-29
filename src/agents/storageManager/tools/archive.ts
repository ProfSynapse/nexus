import { JSONSchema } from '../../../types/schema/JSONSchemaTypes';
import { App, TFile, TFolder } from 'obsidian';
import { BaseTool } from '../../baseTool';
import { ArchiveParams, ArchiveResult } from '../types';
import { FileOperations } from '../utils/FileOperations';
import { createErrorMessage } from '../../../utils/errorUtils';
import { normalizePath } from '../../../utils/pathUtils';

/**
 * Location: src/agents/storageManager/tools/archive.ts
 * Purpose: Safely archive files and folders with timestamp preservation
 * Relationships: Uses FileOperations for move logic
 */

/**
 * Tool for archiving files and folders (moves to .archive/ with timestamp)
 */
export class ArchiveTool extends BaseTool<ArchiveParams, ArchiveResult> {
  private app: App;

  /**
   * Create a new ArchiveTool
   * @param app Obsidian app instance
   */
  constructor(app: App) {
    super(
      'archive',
      'Archive',
      'Safely archive a file or folder (moves to .archive/ with timestamp)',
      '1.0.0'
    );

    this.app = app;
  }

  /**
   * Execute the tool
   * @param params Tool parameters
   * @returns Promise that resolves with the result of archiving
   */
  async execute(params: ArchiveParams): Promise<ArchiveResult> {
    const { path } = params;

    try {
      // Normalize path
      const normalizedPath = normalizePath(path);

      // Check if source exists and determine type
      const sourceItem = this.app.vault.getAbstractFileByPath(normalizedPath);
      if (!sourceItem) {
        return this.prepareResult(
          false,
          undefined,
          `File or folder not found: "${path}". Use list to see available items, or searchContent to find files by name.`
        );
      }

      // Generate timestamp for archive folder
      const now = new Date();
      const timestamp = this.formatTimestamp(now);

      // Construct archive path: .archive/[YYYY-MM-DD_HH-mm-ss]/[original-path]
      const archivePath = `.archive/${timestamp}/${normalizedPath}`;

      // Ensure .archive directory exists
      await FileOperations.ensureFolder(this.app, '.archive');

      // Move item to archive (auto-detects file vs folder)
      if (sourceItem instanceof TFile) {
        await FileOperations.moveNote(this.app, normalizedPath, archivePath, false);
      } else if (sourceItem instanceof TFolder) {
        await FileOperations.moveFolder(this.app, normalizedPath, archivePath, false);
      } else {
        return this.prepareResult(false, undefined, `Unknown item type at path: ${path}`);
      }

      // Success - LLM already knows the path it passed
      return this.prepareResult(true);
    } catch (error) {
      return this.prepareResult(false, undefined, createErrorMessage('Failed to archive: ', error));
    }
  }

  /**
   * Format timestamp for archive folder name
   * @param date Date to format
   * @returns Formatted timestamp string (YYYY-MM-DD_HH-mm-ss)
   */
  private formatTimestamp(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');

    return `${year}-${month}-${day}_${hours}-${minutes}-${seconds}`;
  }

  /**
   * Get the JSON schema for the tool's parameters
   * @returns JSON schema object
   */
  getParameterSchema(): JSONSchema {
    const toolSchema = {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path to file or folder to archive'
        }
      },
      required: ['path'],
      description: 'Archive a file or folder by moving it to .archive/[YYYY-MM-DD_HH-mm-ss]/[original-path]. Auto-detects file vs folder. Creates .archive/ if needed.'
    };

    // Merge with common schema (sessionId and context)
    return this.getMergedSchema(toolSchema);
  }

  getResultSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        success: { type: 'boolean', description: 'Whether the operation succeeded' },
        error: { type: 'string', description: 'Error message if failed (includes recovery guidance)' }
      },
      required: ['success']
    };
  }
}
