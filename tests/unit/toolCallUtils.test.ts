/**
 * toolCallUtils Unit Tests
 *
 * Tests for filterCompletedToolCalls() utility function.
 * This utility is used by AbortHandler and MessageAlternativeService
 * to preserve tool calls that have completed execution while removing
 * incomplete/streaming ones.
 *
 * Bug #1: Stop button was wiping all tool calls (toolCalls = undefined)
 * instead of preserving completed ones.
 */

import { filterCompletedToolCalls } from '../../src/ui/chat/utils/toolCallUtils';
import {
  TOOL_CALLS,
  createCompletedToolCall,
  createIncompleteToolCall,
  createFailedToolCall
} from '../fixtures/chatBugs';

describe('filterCompletedToolCalls', () => {
  // ==========================================================================
  // Undefined / Empty Input
  // ==========================================================================

  describe('undefined and empty input', () => {
    it('should return undefined when input is undefined', () => {
      const result = filterCompletedToolCalls(undefined);
      expect(result).toBeUndefined();
    });

    it('should return undefined when input is an empty array', () => {
      const result = filterCompletedToolCalls([]);
      expect(result).toBeUndefined();
    });
  });

  // ==========================================================================
  // All Completed
  // ==========================================================================

  describe('all completed tool calls', () => {
    it('should preserve all tool calls when all have results', () => {
      const result = filterCompletedToolCalls(TOOL_CALLS.allCompleted);

      expect(result).toBeDefined();
      expect(result!.length).toBe(TOOL_CALLS.allCompleted.length);
    });

    it('should preserve a tool call with result set', () => {
      const tc = createCompletedToolCall({ id: 'tc_result', result: { data: 'yes' }, success: undefined });
      const result = filterCompletedToolCalls([tc]);

      expect(result).toBeDefined();
      expect(result!.length).toBe(1);
      expect(result![0].id).toBe('tc_result');
    });

    it('should preserve a tool call with success set (even if false)', () => {
      const tc = createFailedToolCall({ id: 'tc_failed', result: undefined, success: false });
      const result = filterCompletedToolCalls([tc]);

      expect(result).toBeDefined();
      expect(result!.length).toBe(1);
      expect(result![0].id).toBe('tc_failed');
    });

    it('should preserve a tool call with both result and success set', () => {
      const tc = createCompletedToolCall({ id: 'tc_both', result: 'done', success: true });
      const result = filterCompletedToolCalls([tc]);

      expect(result).toBeDefined();
      expect(result![0].id).toBe('tc_both');
    });
  });

  // ==========================================================================
  // All Incomplete
  // ==========================================================================

  describe('all incomplete tool calls', () => {
    it('should return undefined when all tool calls are incomplete', () => {
      const result = filterCompletedToolCalls(TOOL_CALLS.allIncomplete);
      expect(result).toBeUndefined();
    });

    it('should return undefined for a single incomplete tool call', () => {
      const result = filterCompletedToolCalls(TOOL_CALLS.singleIncomplete);
      expect(result).toBeUndefined();
    });
  });

  // ==========================================================================
  // Mixed Complete / Incomplete
  // ==========================================================================

  describe('mixed tool calls', () => {
    it('should keep only completed tool calls from a mixed array', () => {
      const result = filterCompletedToolCalls(TOOL_CALLS.mixed);

      expect(result).toBeDefined();
      // mixed has 2 completed (tc_mix_c1, tc_mix_c2) and 2 incomplete (tc_mix_i1, tc_mix_i2)
      expect(result!.length).toBe(2);

      const ids = result!.map(tc => tc.id);
      expect(ids).toContain('tc_mix_c1');
      expect(ids).toContain('tc_mix_c2');
      expect(ids).not.toContain('tc_mix_i1');
      expect(ids).not.toContain('tc_mix_i2');
    });

    it('should preserve all metadata on kept tool calls', () => {
      const original = createCompletedToolCall({
        id: 'tc_full',
        name: 'myTool',
        displayName: 'My Tool',
        technicalName: 'agent_myTool',
        parameters: { key: 'val' },
        result: { output: 'result' },
        success: true,
        executionTime: 250,
        error: undefined
      });
      const incomplete = createIncompleteToolCall({ id: 'tc_drop' });

      const result = filterCompletedToolCalls([original, incomplete]);

      expect(result).toBeDefined();
      expect(result!.length).toBe(1);

      const kept = result![0];
      expect(kept.id).toBe('tc_full');
      expect(kept.name).toBe('myTool');
      expect(kept.displayName).toBe('My Tool');
      expect(kept.technicalName).toBe('agent_myTool');
      expect(kept.parameters).toEqual({ key: 'val' });
      expect(kept.result).toEqual({ output: 'result' });
      expect(kept.success).toBe(true);
      expect(kept.executionTime).toBe(250);
    });
  });

  // ==========================================================================
  // Edge Cases
  // ==========================================================================

  describe('edge cases', () => {
    it('should treat result of null as defined (completed)', () => {
      // result is set to null explicitly, which is !== undefined
      const tc = createIncompleteToolCall({ id: 'tc_null_result', result: null as unknown });
      const result = filterCompletedToolCalls([tc]);

      expect(result).toBeDefined();
      expect(result!.length).toBe(1);
    });

    it('should treat result of empty string as defined (completed)', () => {
      const tc = createIncompleteToolCall({ id: 'tc_empty_result', result: '' });
      const result = filterCompletedToolCalls([tc]);

      expect(result).toBeDefined();
      expect(result!.length).toBe(1);
    });

    it('should treat result of false as defined (completed)', () => {
      const tc = createIncompleteToolCall({ id: 'tc_false_result', result: false });
      const result = filterCompletedToolCalls([tc]);

      expect(result).toBeDefined();
      expect(result!.length).toBe(1);
    });

    it('should not mutate the original array', () => {
      const original = [...TOOL_CALLS.mixed];
      const originalLength = original.length;

      filterCompletedToolCalls(original);

      expect(original.length).toBe(originalLength);
    });
  });
});
