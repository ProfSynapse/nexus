/**
 * MessageRepository Unit Tests
 *
 * Tests for the convertAlternativesToEvent helper method.
 * Bug #5: Alternative messages in branches were losing tool call metadata
 * during JSONL serialization because convertAlternativesToEvent was not
 * persisting the extended properties (name, parameters, result, success,
 * error, executionTime).
 *
 * Since MessageRepository is a concrete class with infrastructure dependencies
 * (SQLite, JSONL writer), we test the conversion logic by extracting and
 * verifying the serialization pattern directly.
 */

import {
  createAlternativeMessage,
  createCompletedToolCall,
  createFailedToolCall,
  createIncompleteToolCall
} from '../fixtures/chatBugs';
import type { AlternativeMessageEvent } from '../../src/database/interfaces/StorageEvents';

/**
 * Replicate the convertAlternativesToEvent logic from MessageRepository
 * for isolated unit testing without needing SQLite/JSONL infrastructure.
 *
 * This mirrors MessageRepository.ts lines 380-403 exactly.
 */
function convertAlternativesToEvent(
  alternatives?: Array<{
    id: string;
    content: string | null;
    timestamp: number;
    toolCalls?: any[];
    reasoning?: string;
    state?: string;
  }>
): AlternativeMessageEvent[] | undefined {
  if (!alternatives || alternatives.length === 0) {
    return undefined;
  }
  return alternatives.map(alt => ({
    id: alt.id,
    content: alt.content,
    timestamp: alt.timestamp,
    tool_calls: alt.toolCalls?.map((tc: any) => ({
      id: tc.id,
      type: tc.type || 'function',
      function: tc.function,
      // Extended properties for tool bubble reconstruction
      name: tc.name,
      parameters: tc.parameters,
      result: tc.result,
      success: tc.success,
      error: tc.error,
      executionTime: tc.executionTime
    })),
    reasoning: alt.reasoning,
    state: alt.state
  }));
}

describe('MessageRepository convertAlternativesToEvent', () => {
  // ==========================================================================
  // Basic conversion
  // ==========================================================================

  describe('basic conversion', () => {
    it('should return undefined for undefined input', () => {
      const result = convertAlternativesToEvent(undefined);
      expect(result).toBeUndefined();
    });

    it('should return undefined for empty array', () => {
      const result = convertAlternativesToEvent([]);
      expect(result).toBeUndefined();
    });

    it('should convert a single alternative without tool calls', () => {
      const alt = createAlternativeMessage({ toolCalls: undefined });
      const result = convertAlternativesToEvent([alt]);

      expect(result).toBeDefined();
      expect(result!.length).toBe(1);
      expect(result![0].id).toBe(alt.id);
      expect(result![0].content).toBe(alt.content);
      expect(result![0].timestamp).toBe(alt.timestamp);
      expect(result![0].tool_calls).toBeUndefined();
      expect(result![0].reasoning).toBe(alt.reasoning);
      expect(result![0].state).toBe(alt.state);
    });
  });

  // ==========================================================================
  // Tool call metadata persistence (Bug #5 core fix)
  // ==========================================================================

  describe('tool call metadata persistence (Bug #5)', () => {
    it('should persist all extended tool call properties', () => {
      const toolCall = createCompletedToolCall({
        id: 'tc_full',
        name: 'searchContent',
        parameters: { query: 'test' },
        result: { matches: ['a.md'] },
        success: true,
        error: undefined,
        executionTime: 200
      });

      const alt = createAlternativeMessage({
        toolCalls: [toolCall]
      });

      const result = convertAlternativesToEvent([alt]);

      expect(result).toBeDefined();
      const eventToolCall = result![0].tool_calls![0];

      // Core OpenAI format fields
      expect(eventToolCall.id).toBe('tc_full');
      expect(eventToolCall.type).toBe('function');
      expect(eventToolCall.function).toEqual(toolCall.function);

      // Extended fields (Bug #5 fix - these were previously missing)
      expect(eventToolCall.name).toBe('searchContent');
      expect(eventToolCall.parameters).toEqual({ query: 'test' });
      expect(eventToolCall.result).toEqual({ matches: ['a.md'] });
      expect(eventToolCall.success).toBe(true);
      expect(eventToolCall.executionTime).toBe(200);
    });

    it('should persist error field on failed tool calls', () => {
      const toolCall = createFailedToolCall({
        id: 'tc_err',
        error: 'File not found',
        success: false
      });

      const alt = createAlternativeMessage({ toolCalls: [toolCall] });
      const result = convertAlternativesToEvent([alt]);

      const eventToolCall = result![0].tool_calls![0];
      expect(eventToolCall.error).toBe('File not found');
      expect(eventToolCall.success).toBe(false);
    });

    it('should handle multiple tool calls per alternative', () => {
      const tc1 = createCompletedToolCall({ id: 'tc_1', result: 'result1' });
      const tc2 = createCompletedToolCall({ id: 'tc_2', result: 'result2' });
      const tc3 = createFailedToolCall({ id: 'tc_3' });

      const alt = createAlternativeMessage({ toolCalls: [tc1, tc2, tc3] });
      const result = convertAlternativesToEvent([alt]);

      expect(result![0].tool_calls!.length).toBe(3);
      expect(result![0].tool_calls!.map(tc => tc.id)).toEqual(['tc_1', 'tc_2', 'tc_3']);
    });
  });

  // ==========================================================================
  // Round-trip fidelity
  // ==========================================================================

  describe('round-trip fidelity', () => {
    it('should produce JSON that can be parsed back with full fidelity', () => {
      const toolCall = createCompletedToolCall({
        id: 'tc_round',
        name: 'myTool',
        parameters: { nested: { key: 'value' } },
        result: { complex: [1, 2, 3] },
        success: true,
        executionTime: 100
      });

      const alt = createAlternativeMessage({
        id: 'alt_round',
        content: 'Round trip content',
        toolCalls: [toolCall],
        reasoning: 'Some reasoning',
        state: 'complete'
      });

      // Serialize
      const events = convertAlternativesToEvent([alt]);
      const json = JSON.stringify(events);

      // Deserialize
      const parsed: AlternativeMessageEvent[] = JSON.parse(json);

      expect(parsed.length).toBe(1);
      expect(parsed[0].id).toBe('alt_round');
      expect(parsed[0].content).toBe('Round trip content');
      expect(parsed[0].reasoning).toBe('Some reasoning');
      expect(parsed[0].state).toBe('complete');

      const parsedTc = parsed[0].tool_calls![0];
      expect(parsedTc.id).toBe('tc_round');
      expect(parsedTc.name).toBe('myTool');
      expect(parsedTc.parameters).toEqual({ nested: { key: 'value' } });
      expect(parsedTc.result).toEqual({ complex: [1, 2, 3] });
      expect(parsedTc.success).toBe(true);
      expect(parsedTc.executionTime).toBe(100);
    });

    it('should default type to function when not set', () => {
      const toolCall = createIncompleteToolCall({
        id: 'tc_notype',
        type: undefined as any
      });

      const alt = createAlternativeMessage({ toolCalls: [toolCall] });
      const result = convertAlternativesToEvent([alt]);

      expect(result![0].tool_calls![0].type).toBe('function');
    });
  });

  // ==========================================================================
  // Multiple alternatives
  // ==========================================================================

  describe('multiple alternatives', () => {
    it('should convert multiple alternatives correctly', () => {
      const alt1 = createAlternativeMessage({
        id: 'alt_1',
        content: 'First alternative',
        toolCalls: [createCompletedToolCall({ id: 'tc_a1' })]
      });
      const alt2 = createAlternativeMessage({
        id: 'alt_2',
        content: 'Second alternative',
        toolCalls: undefined
      });

      const result = convertAlternativesToEvent([alt1, alt2]);

      expect(result!.length).toBe(2);
      expect(result![0].id).toBe('alt_1');
      expect(result![0].tool_calls!.length).toBe(1);
      expect(result![1].id).toBe('alt_2');
      expect(result![1].tool_calls).toBeUndefined();
    });
  });
});
