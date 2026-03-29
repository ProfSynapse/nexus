/**
 * Location: src/agents/contentManager/tools/insert.ts
 *
 * Insert tool for ContentManager.
 * Adds new content at a specific position without modifying existing content.
 * Supports prepend (startLine=1), append (startLine=-1), and positional insert.
 *
 * Relationships:
 * - Paired with replace.ts (replace handles modifying existing content; this handles adding new)
 * - Uses generateUnifiedDiff for diff output
 * - Part of ContentManager agent (registered in contentManager.ts)
 */
import { App, TFile } from 'obsidian';
import { BaseTool } from '../../baseTool';
import { InsertParams, InsertResult } from '../types';
import { createErrorMessage } from '../../../utils/errorUtils';
import { generateUnifiedDiff } from '../utils/unifiedDiff';

export class InsertTool extends BaseTool<InsertParams, InsertResult> {
  private app: App;

  constructor(app: App) {
    super(
      'insert',
      'Insert',
      'Insert new content into a note at a specific position. Does not modify or replace existing content — use the replace tool for that.',
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
  ): InsertResult {
    const diff = generateUnifiedDiff(oldLines, newLines);
    return {
      success: true,
      linesDelta: delta,
      totalLines: newLines.length,
      diff
    };
  }

  async execute(params: InsertParams): Promise<InsertResult> {
    try {
      const { path, content, startLine } = params;

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

      // APPEND mode: startLine === -1
      if (startLine === -1) {
        const needsNewline = existingContent.length > 0 && !existingContent.endsWith('\n');
        newContent = existingContent + (needsNewline ? '\n' : '') + content;
        await this.app.vault.modify(file, newContent);

        const newLines = newContent.split('\n');
        const linesAdded = newLines.length - oldLines.length;
        return this.buildResult(oldLines, newLines, linesAdded);
      }

      // Validate startLine
      if (startLine < 1) {
        return this.prepareResult(false, undefined,
          `Invalid startLine: ${startLine}. Line numbers are 1-based. Use -1 to append to the end of the file.`
        );
      }

      if (startLine > totalLines + 1) {
        return this.prepareResult(false, undefined,
          `startLine ${startLine} is beyond file length (${totalLines} lines). Use -1 to append to the end, or use read to view the file first.`
        );
      }

      // INSERT at position: pushes existing content down
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

    } catch (error) {
      return this.prepareResult(false, undefined, createErrorMessage('Error inserting content: ', error));
    }
  }

  getParameterSchema(): Record<string, unknown> {
    const toolSchema = {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path to the note to modify (e.g. "folder/note.md"). Do not include a leading slash.'
        },
        content: {
          type: 'string',
          description: 'The text to insert into the note. For multi-line content, use newline characters (\\n). This content is added without modifying any existing text.'
        },
        startLine: {
          type: 'number',
          description: 'Where to insert the content (1-indexed). Use -1 to append to the end of the note. Use 1 to prepend at the beginning. Any other number inserts before that line, pushing existing content down.'
        }
      },
      required: ['path', 'content', 'startLine']
    };

    return this.getMergedSchema(toolSchema);
  }

  getResultSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        success: {
          type: 'boolean',
          description: 'Whether the insertion succeeded'
        },
        linesDelta: {
          type: 'number',
          description: 'Number of lines added to the file (always positive for insert).'
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
