// Location: src/services/helpers/WorkspaceNormalizer.ts
// Workspace data normalization logic — migrates legacy formats to current schema.
// Extracted from WorkspaceService to isolate migration/normalization concerns.
// Used by: WorkspaceService

import { IndividualWorkspace } from '../../types/storage/StorageTypes';
import * as HybridTypes from '../../types/storage/HybridStorageTypes';
import type { WorkflowSchedule, WorkspaceWorkflow } from '../../database/types/workspace/WorkspaceTypes';
import { fnv1aHex } from '../skills/skillHash';
import { normalizeWorkflowAttachments } from '../workflows/workflowAttachments';

/**
 * Migrate legacy array-based workflow steps to string format
 * @param workspace Workspace to migrate (mutated in place)
 * @returns true if migration was performed, false otherwise
 */
export function normalizeWorkspaceData(workspace: IndividualWorkspace): boolean {
  if (!workspace.context?.workflows || workspace.context.workflows.length === 0) {
    return false;
  }

  const normalized = normalizeWorkspaceContext(workspace.context);
  workspace.context = {
    ...workspace.context,
    ...normalized.context
  };
  return normalized.changed;
}

/**
 * Normalize a workspace context object: assign workflow IDs, convert array steps
 * to strings, and normalize schedule fields.
 */
export function normalizeWorkspaceContext(context: HybridTypes.WorkspaceContext): { context: HybridTypes.WorkspaceContext; changed: boolean } {
  if (!context.workflows || context.workflows.length === 0) {
    return { context, changed: false };
  }

  let changed = false;
  const workflows = context.workflows.map((workflow, index) => {
    let nextWorkflow = workflow as WorkspaceWorkflow & { steps: string | string[] };

    if (Array.isArray(nextWorkflow.steps)) {
      nextWorkflow = { ...nextWorkflow, steps: nextWorkflow.steps.join('\n') };
      changed = true;
    }

    if (!nextWorkflow.id) {
      // Stable on passive reads until the next explicit edit persists the ID.
      // The index distinguishes duplicate definitions within a workspace.
      nextWorkflow = { ...nextWorkflow, id: `workflow_${index}_${fnv1aHex(JSON.stringify([nextWorkflow.name, nextWorkflow.when]))}` };
      changed = true;
    }

    const normalizedSchedule = normalizeWorkflowSchedule(nextWorkflow.schedule);
    if (normalizedSchedule !== nextWorkflow.schedule) {
      nextWorkflow = { ...nextWorkflow, schedule: normalizedSchedule };
      changed = true;
    }

    // Validate only new attachment fields; keep malformed legacy definitions
    // readable so explicit preparation can report the affected workflow.
    try {
      const normalized = normalizeWorkflowAttachments([nextWorkflow])[0];
      if (JSON.stringify(normalized) !== JSON.stringify(nextWorkflow)) changed = true;
      nextWorkflow = normalized;
    } catch { /* Preserve invalid data for the editor and preparation error. */ }
    return nextWorkflow;
  });

  return {
    context: {
      ...context,
      workflows
    },
    changed
  };
}

/**
 * Normalize a workflow schedule: clamp numeric fields to valid ranges,
 * default enabled to true, default catchUp to 'skip'.
 */
export function normalizeWorkflowSchedule(schedule?: WorkflowSchedule): WorkflowSchedule | undefined {
  if (!schedule) {
    return undefined;
  }

  const normalized: WorkflowSchedule = {
    enabled: schedule.enabled !== false,
    frequency: schedule.frequency,
    catchUp: schedule.catchUp || 'skip'
  };

  if (schedule.intervalHours !== undefined) {
    normalized.intervalHours = Math.max(1, Math.min(24, Number(schedule.intervalHours) || 1));
  }
  if (schedule.hour !== undefined) {
    normalized.hour = Math.max(0, Math.min(23, Number(schedule.hour) || 0));
  }
  if (schedule.minute !== undefined) {
    normalized.minute = Math.max(0, Math.min(59, Number(schedule.minute) || 0));
  }
  if (schedule.dayOfWeek !== undefined) {
    normalized.dayOfWeek = Math.max(0, Math.min(6, Number(schedule.dayOfWeek) || 0));
  }
  if (schedule.dayOfMonth !== undefined) {
    normalized.dayOfMonth = Math.max(1, Math.min(31, Number(schedule.dayOfMonth) || 1));
  }

  return normalized;
}
