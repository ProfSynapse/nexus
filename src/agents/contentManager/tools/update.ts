import { App, TFile } from 'obsidian';
import { BaseTool } from '../../baseTool';
import { UpdateParams, UpdateResult } from '../types';
import { ContentOperations } from '../utils/ContentOperations';
import { WriteVerification } from '../types';
import { createErrorMessage } from '../../../utils/errorUtils';
import { addRecommendations, Recommendation } from '../../../utils/recommendationUtils';
import { NudgeHelpers } from '../../../utils/nudgeHelpers';

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
 * - Clear error messages guide recovery
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
      'Insert, replace, or delete content at specific line positions. Returns linesDelta showing net line change - use this to adjust subsequent line numbers in multi-operation workflows.',
      '1.0.0'
    );

    this.app = app;
  }

  /**
   * Compute verification fields for the content after an operation.
   */
  private async computeVerification(
    finalContent: string,
    affectedStart: number,
    affectedEnd: number
  ): Promise<WriteVerification> {
    const totalLines = finalContent.split('\n').length;
    const contentHash = await ContentOperations.computeContentHash(finalContent);
    return {
      totalLines,
      linesAffected: {
        start: affectedStart,
        end: affectedEnd,
        count: affectedEnd - affectedStart + 1
      },
      contentHash
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
      const lines = existingContent.split('\n');
      const totalLines = lines.length;

      let newContent: string;

      // Special case: startLine === -1 means APPEND to end of file
      if (startLine === -1) {
        // Add newline before appending if file doesn't end with one
        const needsNewline = existingContent.length > 0 && !existingContent.endsWith('\n');
        newContent = existingContent + (needsNewline ? '\n' : '') + content;
        await this.app.vault.modify(file, newContent);

        // Calculate linesDelta: number of lines added
        const linesAdded = content.split('\n').length;
        const newTotalLines = newContent.split('\n').length;
        const verification = await this.computeVerification(
          newContent,
          newTotalLines - linesAdded + 1,
          newTotalLines
        );
        // Append doesn't shift existing lines, so no hint needed
        return { success: true, linesDelta: linesAdded, ...verification };
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
        const beforeLines = lines.slice(0, startLine - 1);
        const afterLines = lines.slice(startLine - 1);
        const insertLines = content.split('\n');

        newContent = [
          ...beforeLines,
          ...insertLines,
          ...afterLines
        ].join('\n');

        await this.app.vault.modify(file, newContent);

        // Calculate linesDelta: number of lines inserted
        const delta = insertLines.length;
        const verification = await this.computeVerification(
          newContent,
          startLine,
          startLine + insertLines.length - 1
        );
        const result: UpdateResult = { success: true, linesDelta: delta, ...verification };

        // Add nudge if lines shifted
        const nudge = NudgeHelpers.checkLineShift(delta, startLine);
        return nudge ? addRecommendations(result, [nudge]) : result;
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
      const beforeLines = lines.slice(0, startLine - 1);
      const afterLines = lines.slice(endLine);
      const linesRemoved = endLine - startLine + 1;

      if (content === '') {
        // DELETE: Remove lines, don't insert anything
        newContent = [
          ...beforeLines,
          ...afterLines
        ].join('\n');

        await this.app.vault.modify(file, newContent);

        // Calculate linesDelta: negative (lines removed)
        const delta = -linesRemoved;
        const verification = await this.computeVerification(
          newContent,
          startLine,
          startLine  // After deletion, affected range collapses to the start point
        );
        const result: UpdateResult = { success: true, linesDelta: delta, ...verification };

        // Add nudge for line shift
        const nudge = NudgeHelpers.checkLineShift(delta, endLine);
        return nudge ? addRecommendations(result, [nudge]) : result;
      } else {
        // REPLACE: Remove lines and insert new content
        const replacementLines = content.split('\n');
        newContent = [
          ...beforeLines,
          ...replacementLines,
          ...afterLines
        ].join('\n');

        await this.app.vault.modify(file, newContent);

        // Calculate linesDelta: new lines minus removed lines
        const delta = replacementLines.length - linesRemoved;
        const verification = await this.computeVerification(
          newContent,
          startLine,
          startLine + replacementLines.length - 1
        );
        const result: UpdateResult = { success: true, linesDelta: delta, ...verification };

        // Add nudge if lines shifted
        const nudge = NudgeHelpers.checkLineShift(delta, endLine);
        return nudge ? addRecommendations(result, [nudge]) : result;
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
          description: 'Net change in line count. Positive = lines added, negative = lines removed. Use this to adjust subsequent line numbers in multi-operation workflows.'
        },
        totalLines: {
          type: 'number',
          description: 'Total line count of the file after the update'
        },
        linesAffected: {
          type: 'object',
          properties: {
            start: { type: 'number', description: 'First line affected (1-based)' },
            end: { type: 'number', description: 'Last line affected (1-based)' },
            count: { type: 'number', description: 'Number of lines affected' }
          },
          description: 'Range of lines affected by the operation'
        },
        contentHash: {
          type: 'string',
          description: 'SHA-256 hash of the full file content after updating (sha256:hex format). Use to verify content integrity without a follow-up read.'
        },
        recommendations: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string' },
              message: { type: 'string' }
            }
          },
          description: 'Recommendations for follow-up actions when line numbers have shifted.'
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
