/**
 * Location: src/agents/taskManager/tools/links/linkNote.ts
 * Purpose: Tool to link or unlink a vault note to/from a task (bidirectional linking).
 *
 * Used by: TaskManagerAgent (via lazy tool registration)
 * Dependencies: TaskService
 */

import { BaseTool } from '../../../baseTool';
import { TaskService } from '../../services/TaskService';
import { LinkNoteParameters, LinkNoteResult } from '../../types';
import { JSONSchema } from '../../../../types/schema/JSONSchemaTypes';
import { createErrorMessage } from '../../../../utils/errorUtils';

export class LinkNoteTool extends BaseTool<LinkNoteParameters, LinkNoteResult> {
  constructor(private taskService: TaskService) {
    super(
      'linkNote',
      'Link Note',
      'Link or unlink a vault note to/from a task',
      '1.0.0'
    );
  }

  async execute(params: LinkNoteParameters): Promise<LinkNoteResult> {
    try {
      if (!params.taskId) {
        return this.prepareResult(false, undefined, 'taskId is required');
      }
      if (!params.notePath) {
        return this.prepareResult(false, undefined, 'notePath is required');
      }

      const action = params.action ?? 'link';

      if (action === 'unlink') {
        await this.taskService.unlinkNote(params.taskId, params.notePath);
      } else {
        const linkType = params.linkType ?? 'reference';
        await this.taskService.linkNote(params.taskId, params.notePath, linkType);
      }

      return { success: true };
    } catch (error) {
      return { success: false, error: createErrorMessage('Failed to link note: ', error) };
    }
  }

  getParameterSchema(): JSONSchema {
    return this.getMergedSchema({
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Task ID to link the note to (REQUIRED)' },
        notePath: { type: 'string', description: 'Vault note path (REQUIRED)' },
        linkType: {
          type: 'string',
          enum: ['reference', 'output', 'input'],
          description: 'Type of link (default: reference). reference=related note, output=task produces this note, input=task consumes this note'
        },
        action: {
          type: 'string',
          enum: ['link', 'unlink'],
          description: 'Action to perform (default: link)'
        }
      },
      required: ['taskId', 'notePath']
    });
  }

  getResultSchema(): JSONSchema {
    return {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        error: { type: 'string' }
      }
    };
  }
}
