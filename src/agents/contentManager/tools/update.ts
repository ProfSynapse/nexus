import { App, TFile } from 'obsidian';
import { BaseTool } from '../../baseTool';
import { UpdateParams, UpdateResult } from '../types';
import { ContentOperations } from '../utils/ContentOperations';
import { createErrorMessage } from '../../../utils/errorUtils';
import { addRecommendations, Recommendation } from '../../../utils/recommendationUtils';
import { NudgeHelpers } from '../../../utils/nudgeHelpers';

/**
 * Location: src/agents/contentManager/tools/update.ts
 *
 * Unified update tool for ContentManager.
 * Handles insert, replace, delete, append, prepend, and find-replace operations.
 *
 * Two mutually exclusive modes:
 *
 * **Line-based mode** (startLine present):
 * - startLine only → INSERT at that line (pushes existing content down)
 * - startLine + endLine → REPLACE that range
 * - content: "" with range → DELETE that range
 * - startLine: -1 → APPEND to end of file
 *
 * **Find-replace mode** (find present):
 * - find + replace → substitute text by content match
 * - occurrence: which occurrence to replace (default 1, or "all")
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
      'Update file content. Two modes: (1) Line-based: provide startLine, endLine, content to insert/replace/delete at specific lines. (2) Find-replace: provide find, replace to substitute text by content match. Use occurrence to target a specific match (default: 1) or "all".',
      '1.0.0'
    );

    this.app = app;
  }

  /**
   * Execute the tool
   * @param params Tool parameters
   * @returns Promise that resolves with the update result
   */
  async execute(params: UpdateParams): Promise<UpdateResult> {
    try {
      const { path } = params;
      const hasLineMode = params.startLine !== undefined;
      const hasFindMode = params.find !== undefined;

      // Validate mode: exactly one must be present
      if (hasLineMode && hasFindMode) {
        return this.prepareResult(false, undefined,
          'Cannot use both line-based (startLine) and find-replace (find) modes in the same call. Use one or the other.'
        );
      }

      if (!hasLineMode && !hasFindMode) {
        return this.prepareResult(false, undefined,
          'Must provide either startLine (line-based mode) or find (find-replace mode).'
        );
      }

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

      if (hasFindMode) {
        return this.executeFindReplace(params, file);
      }

      return this.executeLineBased(params, file);

    } catch (error) {
      return this.prepareResult(false, undefined, createErrorMessage('Error updating file: ', error));
    }
  }

  /**
   * Execute find-replace mode
   */
  private async executeFindReplace(params: UpdateParams, file: TFile): Promise<UpdateResult> {
    const { find, replace, occurrence = 1 } = params;

    if (find === undefined || replace === undefined) {
      return this.prepareResult(false, undefined,
        'Find-replace mode requires both "find" and "replace" parameters.'
      );
    }

    if (find === '') {
      return this.prepareResult(false, undefined,
        'The "find" parameter cannot be an empty string.'
      );
    }

    const fileContent = await this.app.vault.read(file);

    if (!fileContent.includes(find)) {
      return this.prepareResult(false, undefined,
        `String not found in file: "${params.path}". Verify the exact text (find is case-sensitive and whitespace-sensitive).`
      );
    }

    let result: string;
    let replacementCount: number;

    if (occurrence === 'all') {
      // Replace all occurrences using split/join (safe for special chars)
      const parts = fileContent.split(find);
      replacementCount = parts.length - 1;
      result = parts.join(replace);
    } else {
      // Replace the N-th occurrence
      if (typeof occurrence !== 'number' || occurrence < 1 || !Number.isInteger(occurrence)) {
        return this.prepareResult(false, undefined,
          `Invalid occurrence: ${occurrence}. Must be a positive integer or "all".`
        );
      }

      let count = 0;
      let replaced = false;
      const searchLen = find.length;
      let idx = 0;
      const segments: string[] = [];

      while (idx <= fileContent.length) {
        const nextIdx = fileContent.indexOf(find, idx);
        if (nextIdx === -1) {
          segments.push(fileContent.slice(idx));
          break;
        }
        count++;
        if (count === occurrence) {
          segments.push(fileContent.slice(idx, nextIdx));
          segments.push(replace);
          segments.push(fileContent.slice(nextIdx + searchLen));
          replaced = true;
          break;
        }
        segments.push(fileContent.slice(idx, nextIdx + searchLen));
        idx = nextIdx + searchLen;
      }

      if (!replaced) {
        return this.prepareResult(false, undefined,
          `Occurrence ${occurrence} not found (only ${count} occurrence${count !== 1 ? 's' : ''} exist).`
        );
      }

      result = segments.join('');
      replacementCount = 1;
    }

    await this.app.vault.modify(file, result);

    // Calculate linesDelta from the replacement
    const oldLineCount = fileContent.split('\n').length;
    const newLineCount = result.split('\n').length;
    const delta = newLineCount - oldLineCount;

    return { success: true, linesDelta: delta, replacementCount };
  }

  /**
   * Execute line-based mode (original behavior)
   */
  private async executeLineBased(params: UpdateParams, file: TFile): Promise<UpdateResult> {
    const { content, startLine, endLine } = params;

    // content is required for line-based mode
    if (content === undefined) {
      return this.prepareResult(false, undefined,
        'Line-based mode requires the "content" parameter. Use empty string to delete lines.'
      );
    }

    if (startLine === undefined) {
      return this.prepareResult(false, undefined,
        'Line-based mode requires the "startLine" parameter.'
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
      // Append doesn't shift existing lines, so no hint needed
      return { success: true, linesDelta: linesAdded };
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
      const result = { success: true, linesDelta: delta };

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
      const result = { success: true, linesDelta: delta };

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
      const result = { success: true, linesDelta: delta };

      // Add nudge if lines shifted
      const nudge = NudgeHelpers.checkLineShift(delta, endLine);
      return nudge ? addRecommendations(result, [nudge]) : result;
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
        // Line-based mode params
        content: {
          type: 'string',
          description: '[Line-based mode] Content to insert/replace (empty string to delete lines)'
        },
        startLine: {
          type: 'number',
          description: '[Line-based mode] Start line (1-based). Use -1 to append to end of file. Use 1 to prepend to start.'
        },
        endLine: {
          type: 'number',
          description: '[Line-based mode] End line (1-based, inclusive). Omit to INSERT at startLine. Provide to REPLACE range.'
        },
        // Find-replace mode params
        find: {
          type: 'string',
          description: '[Find-replace mode] Exact text to find (case-sensitive, plain text, may contain newlines for multi-line match)'
        },
        replace: {
          type: 'string',
          description: '[Find-replace mode] Text to replace with (empty string to delete matched text)'
        },
        occurrence: {
          oneOf: [
            { type: 'number', description: 'Which occurrence to replace (1-based, default: 1)' },
            { type: 'string', enum: ['all'], description: 'Replace all occurrences' }
          ],
          description: '[Find-replace mode] Which occurrence to replace. Default: 1 (first). Use "all" to replace every occurrence.'
        }
      },
      required: ['path']
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
        replacementCount: {
          type: 'number',
          description: '[Find-replace mode] Number of replacements made.'
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
