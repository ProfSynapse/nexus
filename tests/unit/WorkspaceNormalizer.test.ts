/**
 * Unit tests for WorkspaceNormalizer
 *
 * Tests edge cases in workspace data normalization: boundary clamping,
 * missing fields, null context, array-to-string step migration, schedule normalization.
 */

import {
  normalizeWorkflowSchedule,
  normalizeWorkspaceContext,
  normalizeWorkspaceData,
} from '../../src/services/helpers/WorkspaceNormalizer';
import type { WorkflowSchedule } from '../../src/database/types/workspace/WorkspaceTypes';
import type { IndividualWorkspace } from '../../src/types/storage/StorageTypes';
import type { WorkspaceContext } from '../../src/types/storage/HybridStorageTypes';

function expectDefined<T>(value: T | null | undefined): T {
  expect(value).toBeDefined();
  return value as T;
}

function makeWorkspace(data: Partial<IndividualWorkspace> & { context?: WorkspaceContext }): IndividualWorkspace {
  return data as IndividualWorkspace;
}

// ============================================================================
// normalizeWorkflowSchedule
// ============================================================================

describe('normalizeWorkflowSchedule', () => {
  it('returns undefined for undefined schedule', () => {
    expect(normalizeWorkflowSchedule(undefined)).toBeUndefined();
  });

  it('defaults enabled to true when not explicitly false', () => {
    const result = normalizeWorkflowSchedule({ frequency: 'daily', catchUp: 'skip' } as WorkflowSchedule);
    expect(expectDefined(result).enabled).toBe(true);
  });

  it('preserves enabled=false when explicitly set', () => {
    const result = normalizeWorkflowSchedule({
      enabled: false,
      frequency: 'daily',
      catchUp: 'skip',
    });
    expect(expectDefined(result).enabled).toBe(false);
  });

  it('defaults catchUp to "skip" when falsy', () => {
    const result = normalizeWorkflowSchedule({
      enabled: true,
      frequency: 'daily',
      catchUp: '' as unknown as WorkflowSchedule['catchUp'],
    });
    expect(expectDefined(result).catchUp).toBe('skip');
  });

  it('preserves valid catchUp value', () => {
    const result = normalizeWorkflowSchedule({
      enabled: true,
      frequency: 'daily',
      catchUp: 'all',
    });
    expect(expectDefined(result).catchUp).toBe('all');
  });

  describe('intervalHours clamping', () => {
    it('clamps 0 to 1 (minimum)', () => {
      const result = normalizeWorkflowSchedule({
        enabled: true,
        frequency: 'hourly',
        catchUp: 'skip',
        intervalHours: 0,
      });
      expect(expectDefined(result).intervalHours).toBe(1);
    });

    it('clamps 25 to 24 (maximum)', () => {
      const result = normalizeWorkflowSchedule({
        enabled: true,
        frequency: 'hourly',
        catchUp: 'skip',
        intervalHours: 25,
      });
      expect(expectDefined(result).intervalHours).toBe(24);
    });

    it('clamps NaN to 1 (Number(NaN) || 1 = 1)', () => {
      const result = normalizeWorkflowSchedule({
        enabled: true,
        frequency: 'hourly',
        catchUp: 'skip',
        intervalHours: NaN,
      });
      expect(expectDefined(result).intervalHours).toBe(1);
    });

    it('preserves valid intervalHours', () => {
      const result = normalizeWorkflowSchedule({
        enabled: true,
        frequency: 'hourly',
        catchUp: 'skip',
        intervalHours: 12,
      });
      expect(expectDefined(result).intervalHours).toBe(12);
    });

    it('clamps negative value to 1', () => {
      const result = normalizeWorkflowSchedule({
        enabled: true,
        frequency: 'hourly',
        catchUp: 'skip',
        intervalHours: -5,
      });
      expect(expectDefined(result).intervalHours).toBe(1);
    });
  });

  describe('hour clamping', () => {
    it('clamps -1 to 0', () => {
      const result = normalizeWorkflowSchedule({
        enabled: true,
        frequency: 'daily',
        catchUp: 'skip',
        hour: -1,
      });
      expect(expectDefined(result).hour).toBe(0);
    });

    it('clamps 24 to 23', () => {
      const result = normalizeWorkflowSchedule({
        enabled: true,
        frequency: 'daily',
        catchUp: 'skip',
        hour: 24,
      });
      expect(expectDefined(result).hour).toBe(23);
    });

    it('clamps NaN to 0 (Number(NaN) || 0 = 0)', () => {
      const result = normalizeWorkflowSchedule({
        enabled: true,
        frequency: 'daily',
        catchUp: 'skip',
        hour: NaN,
      });
      expect(expectDefined(result).hour).toBe(0);
    });
  });

  describe('minute clamping', () => {
    it('clamps -1 to 0', () => {
      const result = normalizeWorkflowSchedule({
        enabled: true,
        frequency: 'daily',
        catchUp: 'skip',
        minute: -1,
      });
      expect(expectDefined(result).minute).toBe(0);
    });

    it('clamps 60 to 59', () => {
      const result = normalizeWorkflowSchedule({
        enabled: true,
        frequency: 'daily',
        catchUp: 'skip',
        minute: 60,
      });
      expect(expectDefined(result).minute).toBe(59);
    });
  });

  describe('dayOfWeek clamping', () => {
    it('clamps -1 to 0', () => {
      const result = normalizeWorkflowSchedule({
        enabled: true,
        frequency: 'weekly',
        catchUp: 'skip',
        dayOfWeek: -1,
      });
      expect(expectDefined(result).dayOfWeek).toBe(0);
    });

    it('clamps 7 to 6', () => {
      const result = normalizeWorkflowSchedule({
        enabled: true,
        frequency: 'weekly',
        catchUp: 'skip',
        dayOfWeek: 7,
      });
      expect(expectDefined(result).dayOfWeek).toBe(6);
    });
  });

  describe('dayOfMonth clamping', () => {
    it('clamps 0 to 1', () => {
      const result = normalizeWorkflowSchedule({
        enabled: true,
        frequency: 'monthly',
        catchUp: 'skip',
        dayOfMonth: 0,
      });
      expect(expectDefined(result).dayOfMonth).toBe(1);
    });

    it('clamps 32 to 31', () => {
      const result = normalizeWorkflowSchedule({
        enabled: true,
        frequency: 'monthly',
        catchUp: 'skip',
        dayOfMonth: 32,
      });
      expect(expectDefined(result).dayOfMonth).toBe(31);
    });

    it('clamps NaN to 1 (Number(NaN) || 1 = 1)', () => {
      const result = normalizeWorkflowSchedule({
        enabled: true,
        frequency: 'monthly',
        catchUp: 'skip',
        dayOfMonth: NaN,
      });
      expect(expectDefined(result).dayOfMonth).toBe(1);
    });
  });

  it('does not set optional fields when not present in input', () => {
    const result = normalizeWorkflowSchedule({
      enabled: true,
      frequency: 'daily',
      catchUp: 'skip',
    });
    expect(expectDefined(result).intervalHours).toBeUndefined();
    expect(expectDefined(result).hour).toBeUndefined();
    expect(expectDefined(result).minute).toBeUndefined();
    expect(expectDefined(result).dayOfWeek).toBeUndefined();
    expect(expectDefined(result).dayOfMonth).toBeUndefined();
  });
});

// ============================================================================
// normalizeWorkspaceContext
// ============================================================================

describe('normalizeWorkspaceContext', () => {
  it('returns unchanged context when no workflows', () => {
    const context: WorkspaceContext = { purpose: 'test' };
    const result = normalizeWorkspaceContext(context);
    expect(result.changed).toBe(false);
    expect(result.context).toBe(context); // same reference
  });

  it('returns unchanged context when workflows is empty array', () => {
    const context: WorkspaceContext = { purpose: 'test', workflows: [] };
    const result = normalizeWorkspaceContext(context);
    expect(result.changed).toBe(false);
  });

  it('converts array steps to newline-joined string', () => {
    const context: WorkspaceContext = {
      workflows: [{
        id: 'wf-1',
        name: 'Test',
        when: 'daily',
        steps: ['Step 1', 'Step 2'] as unknown as string,
      }],
    };
    const result = normalizeWorkspaceContext(context);
    expect(result.changed).toBe(true);
    expect(expectDefined(expectDefined(result.context.workflows)[0]).steps).toBe('Step 1\nStep 2');
  });

  it('assigns ID to workflow when missing', () => {
    const context: WorkspaceContext = {
      workflows: [{
        id: '',
        name: 'No ID',
        when: 'manual',
        steps: 'do something',
      }],
    };
    const result = normalizeWorkspaceContext(context);
    expect(result.changed).toBe(true);
    const workflow = expectDefined(result.context.workflows)[0];
    expect(workflow.id).toBeTruthy();
    expect(workflow.id.length).toBeGreaterThan(0);
  });

  it('does not reassign ID when already present', () => {
    const context: WorkspaceContext = {
      workflows: [{
        id: 'existing-id',
        name: 'Has ID',
        when: 'manual',
        steps: 'do something',
      }],
    };
    const result = normalizeWorkspaceContext(context);
    expect(expectDefined(result.context.workflows)[0].id).toBe('existing-id');
  });

  it('normalizes schedule within workflow', () => {
    const context: WorkspaceContext = {
      workflows: [{
        id: 'wf-1',
        name: 'Scheduled',
        when: 'hourly',
        steps: 'run',
        schedule: {
          enabled: true,
          frequency: 'hourly',
          intervalHours: 0, // should be clamped to 1
          catchUp: 'skip',
        },
      }],
    };
    const result = normalizeWorkspaceContext(context);
    expect(result.changed).toBe(true);
    expect(expectDefined(expectDefined(result.context.workflows)[0].schedule).intervalHours).toBe(1);
  });

  it('marks changed when schedule present (normalizeWorkflowSchedule always returns new object)', () => {
    const schedule: WorkflowSchedule = {
      enabled: true,
      frequency: 'daily',
      catchUp: 'skip',
      hour: 9,
    };
    const context: WorkspaceContext = {
      workflows: [{
        id: 'wf-1',
        name: 'Already good',
        when: 'daily',
        steps: 'run',
        schedule,
      }],
    };
    const result = normalizeWorkspaceContext(context);
    // normalizeWorkflowSchedule always creates a new object, so reference
    // comparison (normalizedSchedule !== workflow.schedule) is always true
    expect(result.changed).toBe(true);
    // Values should be preserved though
    const scheduleResult = expectDefined(expectDefined(result.context.workflows)[0].schedule);
    expect(scheduleResult.hour).toBe(9);
    expect(scheduleResult.enabled).toBe(true);
  });
});

// ============================================================================
// normalizeWorkspaceData
// ============================================================================

describe('normalizeWorkspaceData', () => {
  it('returns false when context is missing', () => {
    const workspace = makeWorkspace({ id: 'ws-1' });
    expect(normalizeWorkspaceData(workspace)).toBe(false);
  });

  it('returns false when context has no workflows', () => {
    const workspace = makeWorkspace({ id: 'ws-1', context: { purpose: 'test' } });
    expect(normalizeWorkspaceData(workspace)).toBe(false);
  });

  it('returns false when workflows is empty array', () => {
    const workspace = makeWorkspace({ id: 'ws-1', context: { workflows: [] } });
    expect(normalizeWorkspaceData(workspace)).toBe(false);
  });

  it('returns true and mutates workspace when normalization occurs', () => {
    const workspace = {
      id: 'ws-1',
      context: {
        purpose: 'test',
        workflows: [{
          id: '',
          name: 'Test',
          when: 'daily',
          steps: ['a', 'b'] as unknown as string,
        }],
      },
    };

    const result = normalizeWorkspaceData(workspace);
    expect(result).toBe(true);
    // Steps should be converted
    expect(workspace.context.workflows[0].steps).toBe('a\nb');
    // ID should be assigned
    expect(workspace.context.workflows[0].id).toBeTruthy();
  });

  it('preserves other context fields during normalization', () => {
    const workspace = {
      id: 'ws-1',
      context: {
        purpose: 'research',
        keyFiles: ['/readme.md'],
        workflows: [{
          id: '',
          name: 'WF',
          when: 'manual',
          steps: 'step',
        }],
      },
    };

    normalizeWorkspaceData(workspace);
    expect(workspace.context.purpose).toBe('research');
    expect(workspace.context.keyFiles).toEqual(['/readme.md']);
  });
});
