import { App, TFile } from 'obsidian';
import { BaseTool } from '../../baseTool';
import { UpdateParams, UpdateResult } from '../types';
import { ContentOperations } from '../utils/ContentOperations';
import { createErrorMessage } from '../../../utils/errorUtils';
import { generateUnifiedDiff } from '../utils/unifiedDiff';

/**
 * Location: src/agents/contentManager/tools/update.ts
 *
 * Unified update tool for ContentManager.
 * Handles insert, replace, delete, append, and prepend operations.
 *
 * Behavior:
 * - startLine only → INSERT at that line (pushes existing content down)
 * - startLine + endLine → REPLACE that range
 * - content: "" with range → DELETE that range
 * - startLine: -1 → APPEND to end of file
 *
 * Key Design:
 * - Single tool replaces: appendContent, prependContent, replaceContent, replaceByLine, findReplaceContent, deleteContent
 * - Line-based operations are explicit and predictable
 * - Returns unified diff with context so subsequent edits can target correct line numbers without re-reading
 *
 * Relationships:
 * - Uses ContentOperations utility for file operations
 * - Part of CRUA architecture (Update operation)
 * - Follows write tool response stripping principle (returns { success: true } only)
 */
export class UpdateTool extends BaseTool<UpdateParams, UpdateResult> {
  private app: App;

  /**
   * Create a new UpdateTool
   * @param app Obsidian app instance
   */
  constructor(app: App) {
    super(
      'update',
      'Update',
      'Insert, replace, or delete content at specific line positions. Returns a unified diff with context lines showing what changed and the new line numbers — use the @@ headers to target subsequent edits without re-reading the file.',
      '1.0.0'
    );

    this.app = app;
  }

  /**
   * Build the result with diff, totalLines, and linesDelta.
   */
  private buildResult(
    oldLines: string[],
    newLines: string[],
    delta: number
  ): UpdateResult {
    const diff = generateUnifiedDiff(oldLines, newLines);
    return {
      success: true,
      linesDelta: delta,
      totalLines: newLines.length,
      diff
    };
  }

  /**
   * Execute the tool
   * @param params Tool parameters
   * @returns Promise that resolves with the update result
   */
  async execute(params: UpdateParams): Promise<UpdateResult> {
    try {
      const { path, content, startLine, endLine } = params;

      // Normalize path (remove leading slash)
      const normalizedPath = path.startsWith('/') ? path.slice(1) : path;
      const file = this.app.vault.getAbstractFileByPath(normalizedPath);

      if (!file) {
        return this.prepareResult(false, undefined,
          `File not found: "${path}". Use searchContent to find files by name, or storageManager.list to explore folders.`
        );
      }

      if (!(file instanceof TFile)) {
        return this.prepareResult(false, undefined,
          `Path is a folder, not a file: "${path}". Use storageManager.list to see its contents.`
        );
      }

      const existingContent = await this.app.vault.read(file);
      const oldLines = existingContent.split('\n');
      const totalLines = oldLines.length;

      let newContent: string;

      // Special case: startLine === -1 means APPEND to end of file
      if (startLine === -1) {
        // Add newline before appending if file doesn't end with one
        const needsNewline = existingContent.length > 0 && !existingContent.endsWith('\n');
        newContent = existingContent + (needsNewline ? '\n' : '') + content;
        await this.app.vault.modify(file, newContent);

        const newLines = newContent.split('\n');
        const linesAdded = newLines.length - oldLines.length;
        return this.buildResult(oldLines, newLines, linesAdded);
      }

      // Validate line numbers
      if (startLine < 1) {
        return this.prepareResult(false, undefined,
          `Invalid startLine: ${startLine}. Line numbers are 1-based. Use -1 to append to end of file.`
        );
      }

      if (startLine > totalLines + 1) {
        return this.prepareResult(false, undefined,
          `Start line ${startLine} is beyond file length (${totalLines} lines). Use read to view the file first.`
        );
      }

      // Case 1: INSERT (startLine only, no endLine)
      if (endLine === undefined) {
        // Insert content at startLine, pushing existing content down
        const beforeLines = oldLines.slice(0, startLine - 1);
        const afterLines = oldLines.slice(startLine - 1);
        const insertLines = content.split('\n');

        newContent = [
          ...beforeLines,
          ...insertLines,
          ...afterLines
        ].join('\n');

        await this.app.vault.modify(file, newContent);

        const newLines = newContent.split('\n');
        const delta = insertLines.length;
        return this.buildResult(oldLines, newLines, delta);
      }

      // Validate endLine
      if (endLine < startLine) {
        return this.prepareResult(false, undefined,
          `End line ${endLine} cannot be less than start line ${startLine}.`
        );
      }

      if (endLine > totalLines) {
        return this.prepareResult(false, undefined,
          `End line ${endLine} is beyond file length (${totalLines} lines). Use read to view the file first.`
        );
      }

      // Case 2: REPLACE (startLine + endLine with content)
      // Case 3: DELETE (startLine + endLine with empty content)
      const beforeLines = oldLines.slice(0, startLine - 1);
      const afterLines = oldLines.slice(endLine);
      const linesRemoved = endLine - startLine + 1;

      if (content === '') {
        // DELETE: Remove lines, don't insert anything
        newContent = [
          ...beforeLines,
          ...afterLines
        ].join('\n');

        await this.app.vault.modify(file, newContent);

        const newLines = newContent.split('\n');
        const delta = -linesRemoved;
        return this.buildResult(oldLines, newLines, delta);
      } else {
        // REPLACE: Remove lines and insert new content
        const replacementLines = content.split('\n');
        newContent = [
          ...beforeLines,
          ...replacementLines,
          ...afterLines
        ].join('\n');

        await this.app.vault.modify(file, newContent);

        const newLines = newContent.split('\n');
        const delta = replacementLines.length - linesRemoved;
        return this.buildResult(oldLines, newLines, delta);
      }

    } catch (error) {
      return this.prepareResult(false, undefined, createErrorMessage('Error updating file: ', error));
    }
  }

  /**
   * Get the JSON schema for the tool's parameters
   * @returns JSON schema object
   */
  getParameterSchema(): Record<string, unknown> {
    const toolSchema = {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path to the file to modify'
        },
        content: {
          type: 'string',
          description: 'Content to insert/replace (empty string to delete lines)'
        },
        startLine: {
          type: 'number',
          description: 'Start line (1-based). Use -1 to append to end of file. Use 1 to prepend to start.'
        },
        endLine: {
          type: 'number',
          description: 'End line (1-based, inclusive). Omit to INSERT at startLine. Provide to REPLACE range.'
        }
      },
      required: ['path', 'content', 'startLine']
    };

    return this.getMergedSchema(toolSchema);
  }

  /**
   * Get the JSON schema for the tool's result
   * @returns JSON schema object
   */
  getResultSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        success: {
          type: 'boolean',
          description: 'Whether the operation succeeded'
        },
        linesDelta: {
          type: 'number',
          description: 'Net change in line count. Positive = lines added, negative = lines removed.'
        },
        totalLines: {
          type: 'number',
          description: 'Total line count of the file after the operation.'
        },
        diff: {
          type: 'string',
          description: 'Unified diff showing what changed with context lines. The @@ headers contain new line numbers — use them to target subsequent edits without re-reading the file.'
        },
        error: {
          type: 'string',
          description: 'Error message if failed (includes recovery guidance)'
        }
      },
      required: ['success']
    };
  }
}
