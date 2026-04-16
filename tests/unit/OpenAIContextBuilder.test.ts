/**
 * OpenAIContextBuilder — tool_call id synthesis tests (PR #142, F5)
 *
 * When upstream tool calls arrive with missing or empty ids, buildToolContinuation
 * and appendToolExecution must synthesize an id AND propagate the same id to the
 * matching tool result message. Mismatched assistant tool_calls[i].id vs
 * tool message tool_call_id is the original Azure-via-OpenRouter bug class.
 */

import { OpenAIContextBuilder } from '../../src/services/chat/builders/OpenAIContextBuilder';
import type { LLMToolCall, ToolExecutionResult } from '../../src/services/chat/builders/IContextBuilder';

type OpenAIMessageObserved = {
  role: string;
  content?: unknown;
  tool_calls?: Array<{ id: string }>;
  tool_call_id?: string;
};

function toolCall(id: string, name = 'f'): LLMToolCall {
  return { id, type: 'function', function: { name, arguments: '{}' } };
}

function toolResult(id: string): ToolExecutionResult {
  return { id, success: true, result: { ok: true } };
}

describe('OpenAIContextBuilder — synthesis paths (F5)', () => {
  let builder: OpenAIContextBuilder;

  beforeEach(() => {
    builder = new OpenAIContextBuilder();
  });

  describe('buildToolContinuation', () => {
    it('synthesizes `call_synth_continuation_*` ids when missing/empty and matches assistant→tool ids', () => {
      const calls: LLMToolCall[] = [
        toolCall('', 'a'),
        // missing id entirely (cast away — runtime path exercises the `|| synth` branch)
        { type: 'function', function: { name: 'b', arguments: '{}' } } as LLMToolCall,
      ];
      const results: ToolExecutionResult[] = [toolResult('should_be_overridden_0'), toolResult('should_be_overridden_1')];

      const out = builder.buildToolContinuation('user msg', calls, results) as OpenAIMessageObserved[];

      const assistant = out.find((m) => m.role === 'assistant')!;
      const toolMsgs = out.filter((m) => m.role === 'tool');

      expect(assistant.tool_calls).toHaveLength(2);
      expect(toolMsgs).toHaveLength(2);

      // Prefix + uniqueness
      const ids = assistant.tool_calls!.map((tc) => tc.id);
      for (const id of ids) expect(id).toMatch(/^call_synth_continuation_/);
      expect(new Set(ids).size).toBe(2);

      // The assistant's tool_calls[i].id MUST equal tool result's tool_call_id
      // at the same index (original bug: mismatch → Azure 400).
      expect(toolMsgs[0].tool_call_id).toBe(ids[0]);
      expect(toolMsgs[1].tool_call_id).toBe(ids[1]);
    });

    it('keeps existing ids as-is when provided', () => {
      const calls: LLMToolCall[] = [toolCall('call_existing_xyz')];
      const out = builder.buildToolContinuation('u', calls, [toolResult('ignored')]) as OpenAIMessageObserved[];

      const assistant = out.find((m) => m.role === 'assistant')!;
      const toolMsg = out.find((m) => m.role === 'tool')!;
      expect(assistant.tool_calls![0].id).toBe('call_existing_xyz');
      expect(toolMsg.tool_call_id).toBe('call_existing_xyz');
    });
  });

  describe('appendToolExecution', () => {
    it('synthesizes `call_synth_append_*` ids and matches assistant→tool ids', () => {
      const calls: LLMToolCall[] = [toolCall(''), toolCall('')];
      const results: ToolExecutionResult[] = [toolResult('x'), toolResult('y')];

      const out = builder.appendToolExecution(calls, results, []) as OpenAIMessageObserved[];

      const assistant = out.find((m) => m.role === 'assistant')!;
      const toolMsgs = out.filter((m) => m.role === 'tool');

      const ids = assistant.tool_calls!.map((tc) => tc.id);
      for (const id of ids) expect(id).toMatch(/^call_synth_append_/);
      expect(new Set(ids).size).toBe(2);
      expect(toolMsgs[0].tool_call_id).toBe(ids[0]);
      expect(toolMsgs[1].tool_call_id).toBe(ids[1]);
    });
  });
});
