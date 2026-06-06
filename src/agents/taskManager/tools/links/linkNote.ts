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
import { ToolStatusTense } from '../../../interfaces/ITool';
import { verbs, labelFileOp } from '../../../utils/toolStatusLabels';

export class LinkNoteTool extends BaseTool<LinkNoteParameters, LinkNoteResult> {
  constructor(private taskService: TaskService) {
    super(
      'linkNote',
      'Link Note',
      'Create or remove a bidirectional link between a vault note and a task. Accepts either the internal taskId or short taskRef. Link types: input (task depends on / consumes the note — a required source / precondition, forms a data-flow edge), output (task produces the note — the artifact/result, forms a data-flow edge), reference (related/contextual note the task does NOT consume — association only, not part of the data flow). Use action=unlink to remove an existing link.',
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
        taskId: { type: 'string', description: 'Task ID or short taskRef to link the note to (REQUIRED — from createTask or listTasks)' },
        notePath: { type: 'string', description: 'Vault note path, e.g. "folder/note.md" (REQUIRED)' },
        linkType: {
          type: 'string',
          enum: ['reference', 'output', 'input'],
          description: 'Type of link (default: reference). input=the task DEPENDS ON / CONSUMES this note (required source material; a precondition — forms a data-flow edge). output=the task PRODUCES this note (the artifact/result — forms a data-flow edge). reference=related/contextual note the task does NOT consume (association only, not part of the data flow).'
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

  getStatusLabel(params: Record<string, unknown> | undefined, tense: ToolStatusTense): string | undefined {
    const isUnlink = params?.action === 'unlink';
    const v = isUnlink
      ? verbs('Unlinking note', 'Unlinked note', 'Failed to unlink note')
      : verbs('Linking note', 'Linked note', 'Failed to link note');
    return labelFileOp(v, params, tense, { keys: ['notePath'] });
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
