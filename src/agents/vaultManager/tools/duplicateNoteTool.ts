import { App, Plugin } from 'obsidian';
import { BaseTool } from '../../baseTool';
import { DuplicateNoteParams, DuplicateNoteResult } from '../types';
import { FileOperations } from '../utils/FileOperations';
import { MemoryService } from "../../memoryManager/services/MemoryService";
import { parseWorkspaceContext } from '../../../utils/contextUtils';
import { createErrorMessage } from '../../../utils/errorUtils';
import { addRecommendations, Recommendation } from '../../../utils/recommendationUtils';
import { NudgeHelpers } from '../../../utils/nudgeHelpers';
import { getNexusPlugin } from '../../../utils/pluginLocator';

/**
 * Interface for a plugin with services
 */
interface PluginWithServices extends Plugin {
  services?: {
    memoryService?: MemoryService;
  };
}

/**
 * Tool for duplicating a note
 */
export class DuplicateNoteTool extends BaseTool<DuplicateNoteParams, DuplicateNoteResult> {
  private app: App;
  private memoryService: MemoryService | null = null;

  /**
   * Create a new DuplicateNoteTool
   * @param app Obsidian app instance
   * @param memoryService Optional memory service for activity recording
   */
  constructor(app: App, memoryService?: MemoryService | null) {
    super(
      'duplicateNote',
      'Duplicate Note',
      'Create a duplicate of an existing note',
      '1.0.0'
    );

    this.app = app;
    this.memoryService = memoryService || null;

    // Try to get memory service from plugin if not provided
    if (!this.memoryService) {
      try {
        const plugin = getNexusPlugin<PluginWithServices>(this.app);
        if (plugin?.services?.memoryService) {
          this.memoryService = plugin.services.memoryService;
        }
      } catch (error) {
        console.error('Failed to get memory service:', error);
      }
    }
  }

  /**
   * Execute the tool
   * @param params Tool parameters
   * @returns Promise that resolves with the result of duplicating the note
   */
  async execute(params: DuplicateNoteParams): Promise<DuplicateNoteResult> {
    try {
      // Validate parameters
      if (!params.sourcePath) {
        return this.prepareResult(false, undefined, 'Source path is required');
      }

      if (!params.targetPath) {
        return this.prepareResult(false, undefined, 'Target path is required');
      }

      // Perform the duplication
      const result = await FileOperations.duplicateNote(
        this.app,
        params.sourcePath,
        params.targetPath,
        params.overwrite || false,
        params.autoIncrement || false
      );

      // Record activity in workspace memory if applicable
      await this.recordActivity(params, result);

      const response = this.prepareResult(true, {
        sourcePath: result.sourcePath,
        targetPath: result.targetPath,
        wasAutoIncremented: result.wasAutoIncremented,
        wasOverwritten: result.wasOverwritten
      });

      // Generate nudges for duplicate operations
      const nudges = this.generateDuplicateNudges();

      return addRecommendations(response, nudges);
    } catch (error) {
      return this.prepareResult(false, undefined, createErrorMessage('Failed to duplicate note: ', error));
    }
  }

  /**
   * Record note duplication activity in workspace memory
   * @param params Params used for note duplication
   * @param result Result of duplication operation
   */
  private async recordActivity(
    params: DuplicateNoteParams,
    result: {
      sourcePath: string;
      targetPath: string;
      wasAutoIncremented: boolean;
      wasOverwritten: boolean;
    }
  ): Promise<void> {
    // Parse workspace context
    const parsedContext = parseWorkspaceContext(params.workspaceContext);

    if (!parsedContext?.workspaceId || !this.memoryService) {
      return; // Skip if no workspace context or memory service
    }

    try {
      // Create a descriptive content about this operation
      let action = 'Duplicated';
      if (result.wasOverwritten) {
        action += ' (overwritten target)';
      } else if (result.wasAutoIncremented) {
        action += ' (auto-incremented name)';
      }

      const content = `${action} note from ${result.sourcePath} to ${result.targetPath}`;

      // Record the activity using memory service
      await this.memoryService.recordActivityTrace({
        workspaceId: parsedContext.workspaceId,
        type: 'research', // Using supported activity type
        content,
        timestamp: Date.now(),
          metadata: {
            tool: 'DuplicateNoteTool',
            params: {
              sourcePath: params.sourcePath,
              targetPath: params.targetPath,
              overwrite: params.overwrite,
              autoIncrement: params.autoIncrement
            },
            result: {
              finalTargetPath: result.targetPath,
              wasAutoIncremented: result.wasAutoIncremented,
              wasOverwritten: result.wasOverwritten
            },
            relatedFiles: [result.sourcePath, result.targetPath]
          },
          sessionId: params.context.sessionId
        }
      );
    } catch (error) {
      // Log but don't fail the main operation
      console.error('Failed to record note duplication activity:', createErrorMessage('', error));

      // Try to get memory service from plugin if not available
      if (!this.memoryService) {
        try {
          const plugin = getNexusPlugin<PluginWithServices>(this.app);
          if (plugin?.services?.memoryService) {
            this.memoryService = plugin.services.memoryService;
            // Try again with the newly found service
            await this.recordActivity(params, result);
          }
        } catch (retryError) {
          console.error('Error accessing memory service for retry:', createErrorMessage('', retryError));
        }
      }
    }
  }

  /**
   * Get the JSON schema for the tool's parameters
   * @returns JSON schema object
   */
  getParameterSchema(): any {
    // Create the tool-specific schema
    const toolSchema = {
      type: 'object',
      properties: {
        sourcePath: {
          type: 'string',
          description: 'Path to the source note to duplicate (REQUIRED)'
        },
        targetPath: {
          type: 'string',
          description: 'Path for the duplicate note (REQUIRED)'
        },
        overwrite: {
          type: 'boolean',
          description: 'Whether to overwrite if target already exists',
          default: false
        },
        autoIncrement: {
          type: 'boolean',
          description: 'Whether to auto-increment filename if target exists (takes precedence over overwrite)',
          default: false
        }
      },
      required: ['sourcePath', 'targetPath']
    };

    // Merge with common schema (workspace context)
    return this.getMergedSchema(toolSchema);
  }

  /**
   * Get the result schema
   */
  getResultSchema(): Record<string, any> {
    const baseSchema = super.getResultSchema();

    // Extend the base schema to include our specific data
    baseSchema.properties.data = {
      type: 'object',
      properties: {
        sourcePath: {
          type: 'string',
          description: 'Path of the source note'
        },
        targetPath: {
          type: 'string',
          description: 'Final path of the duplicated note'
        },
        wasAutoIncremented: {
          type: 'boolean',
          description: 'Whether the filename was auto-incremented due to conflicts'
        },
        wasOverwritten: {
          type: 'boolean',
          description: 'Whether an existing file was overwritten'
        }
      }
    };

    return baseSchema;
  }

  /**
   * Generate nudges for duplicate operations
   */
  private generateDuplicateNudges(): Recommendation[] {
    const nudges: Recommendation[] = [];

    // Always suggest customization after duplicating files
    nudges.push(NudgeHelpers.suggestCustomization());

    return nudges;
  }
}
