import { App, TFile } from 'obsidian';
import { BaseTool } from '../../baseTool';
import { WriteParams, WriteResult } from '../types';
import { ContentOperations } from '../utils/ContentOperations';
import { createErrorMessage } from '../../../utils/errorUtils';
import type { ToolStatusTense } from '../../interfaces/ITool';
import { labelFileOp, verbs } from '../../utils/toolStatusLabels';

interface YamlParseError {
  message?: string;
  linePos?: Array<{ line: number; col: number }>;
}

/**
 * Validate leading Obsidian frontmatter without rewriting caller bytes.
 * A valid block is either empty or a YAML mapping/object; malformed YAML,
 * lists, and scalar document roots are rejected because Obsidian properties
 * are map-shaped.
 */
async function validateFrontmatter(content: string): Promise<string | null> {
  const withoutBom = content.replace(/^\uFEFF/, '');
  const match = withoutBom.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);

  if (!match) {
    return null;
  }

  const frontmatterBody = match[1];

  try {
    const { parse } = await import('yaml');
    const parsed: unknown = parse(frontmatterBody);

    if (parsed === null || parsed === undefined) {
      return null;
    }

    if (typeof parsed !== 'object' || Array.isArray(parsed)) {
      return 'Frontmatter must be a YAML mapping of property names to values. Use setProperty for metadata changes.';
    }

    return null;
  } catch (error) {
    return formatFrontmatterError(error, frontmatterBody);
  }
}

function formatFrontmatterError(error: unknown, frontmatterBody: string): string {
  const yamlError = error as YamlParseError;
  const pos = yamlError.linePos?.[0];
  const line = pos?.line ?? 1;
  const col = pos?.col ?? 1;
  const offendingLine = frontmatterBody.split('\n')[line - 1]?.slice(0, 120) ?? '';
  const message = yamlError.message ?? 'Parse error';

  return [
    `Frontmatter is invalid YAML at line ${line}, column ${col}: ${message}`,
    offendingLine ? `Offending line: ${offendingLine}` : null,
    'Hint: quote values that contain reserved YAML syntax such as ": ", "#", leading "- ", brackets, or unmatched quotes.',
  ].filter((part): part is string => part !== null).join('\n');
}

/**
 * Location: src/agents/contentManager/tools/write.ts
 *
 * Simplified write tool for ContentManager.
 * Creates a new file or overwrites an existing file.
 *
 * Key Design:
 * - Default behavior is safe (no overwrite)
 * - Explicit overwrite flag required to replace existing files
 * - Clear error messages guide recovery
 *
 * Relationships:
 * - Uses ContentOperations utility for file operations
 * - Part of CRUA architecture (Create operation)
 * - Follows write tool response stripping principle (returns { success: true } only)
 */
export class WriteTool extends BaseTool<WriteParams, WriteResult> {
  private app: App;

  /**
   * Create a new WriteTool
   * @param app Obsidian app instance
   */
  constructor(app: App) {
    super(
      'write',
      'Write',
      'Create a new file or overwrite existing file',
      '1.0.0'
    );

    this.app = app;
  }

  getStatusLabel(params: Record<string, unknown> | undefined, tense: ToolStatusTense): string | undefined {
    return labelFileOp(verbs('Updating', 'Updated', 'Failed to update'), params, tense);
  }

  /**
   * Execute the tool
   * @param params Tool parameters
   * @returns Promise that resolves with the creation result
   */
  async execute(params: WriteParams): Promise<WriteResult> {
    try {
      const { content, overwrite = false } = params;
      let { path } = params;

      // Reject empty/whitespace path explicitly. Silently rewriting '' to
      // untitled-<timestamp>.md in the vault root hid callers that had
      // dropped the path by mistake and left orphan files behind.
      if (typeof path !== 'string' || path.trim() === '') {
        return this.prepareResult(false, undefined,
          'path must be a non-empty string. Pass "/" or "." to let Obsidian pick a filename in the vault root.'
        );
      }

      // Normalize root/dot paths - generate a filename if only directory is specified
      if (path === '/' || path === '.') {
        const timestamp = Date.now();
        path = `untitled-${timestamp}.md`;
      } else if (path.endsWith('/') || path.endsWith('.')) {
        const dir = path.endsWith('.') ? '' : path.slice(0, -1);
        const timestamp = Date.now();
        path = dir ? `${dir}/untitled-${timestamp}.md` : `untitled-${timestamp}.md`;
      }

      if (content === undefined || content === null) {
        return this.prepareResult(false, undefined, 'Content is required');
      }

      const frontmatterError = await validateFrontmatter(content);
      if (frontmatterError) {
        return this.prepareResult(false, undefined, frontmatterError);
      }

      // Normalize path (remove leading slash)
      const normalizedPath = path.startsWith('/') ? path.slice(1) : path;
      const existingFile = this.app.vault.getAbstractFileByPath(normalizedPath);

      if (existingFile) {
        if (!overwrite) {
          return this.prepareResult(false, undefined,
            `File already exists: "${path}". Use read to inspect it, insert to add content, replace to edit validated ranges, or write with overwrite: true to replace it completely.`
          );
        }

        // Overwrite existing file
        if (!(existingFile instanceof TFile)) {
          return this.prepareResult(false, undefined,
            `Path is a folder, not a file: "${path}". Use storageManager.list to see its contents.`
          );
        }

        await this.app.vault.modify(existingFile, content);
      } else {
        // Create new file
        await ContentOperations.createContent(this.app, path, content);
      }

      // Success - LLM already knows the path and content it passed
      return this.prepareResult(true);
    } catch (error) {
      return this.prepareResult(false, undefined, createErrorMessage('Error writing file: ', error));
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
          description: 'Path to the file to create or overwrite'
        },
        content: {
          type: 'string',
          description: 'Content to write to the file'
        },
        overwrite: {
          type: 'boolean',
          description: 'Overwrite if file exists (default: false)',
          default: false
        }
      },
      required: ['path', 'content']
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
        error: {
          type: 'string',
          description: 'Error message if failed (includes recovery guidance)'
        }
      },
      required: ['success']
    };
  }
}
