/**
 * tests/eval/EvalToolExecutorRecovery.test.ts — fast, model-free coverage of
 * the mock executor's context-contract enforcement + recovery tracking.
 *
 * Simulates the orchestrator calling executeToolCalls round-by-round and
 * asserts the steering/recovery stats, so the recovery feature is covered
 * without running a live model.
 */
import { EvalToolExecutor } from './EvalToolExecutor';
import { NEXUS_TOOLS } from './fixtures/tools';
import type { ToolCall } from '../../src/services/llm/adapters/types';

function useToolsCall(id: string, args: Record<string, unknown>): ToolCall {
  return {
    id,
    type: 'function',
    function: { name: 'useTools', arguments: JSON.stringify(args) },
  } as ToolCall;
}

function domainCall(id: string, name: string, args: Record<string, unknown>): ToolCall {
  return {
    id,
    type: 'function',
    function: { name, arguments: JSON.stringify(args) },
  } as ToolCall;
}

describe('EvalToolExecutor — context-contract recovery', () => {
  it('forceContextSteering rejects the first useTools call, then records recovery on a valid retry', async () => {
    const ex = new EvalToolExecutor();
    ex.setDomainTools(NEXUS_TOOLS);
    ex.setForceContextSteering(1);
    ex.resetCalls();

    // Round 1 — forced steering regardless of (here, valid) input.
    const r1 = await ex.executeToolCalls([
      useToolsCall('c1', { memory: 'a summary', goal: 'read it', tool: 'content read --path notes/a.md' }),
    ]);
    expect(r1[0].success).toBe(false);
    expect(r1[0].error).toMatch(/Context incomplete/);
    expect(ex.getContextContractStats()).toMatchObject({ steeringErrors: 1, recovered: false });

    // Round 2 — model re-issues; forced budget spent, valid context executes.
    const r2 = await ex.executeToolCalls([
      useToolsCall('c2', { memory: 'a summary', goal: 'read it', tool: 'content read --path notes/a.md' }),
    ]);
    expect(r2[0].success).toBe(true);
    expect(ex.getContextContractStats()).toMatchObject({ enforced: true, steeringErrors: 1, recovered: true });
  });

  it('enforceContextContract steers empty memory and does not mark recovery without a valid retry', async () => {
    const ex = new EvalToolExecutor();
    ex.setDomainTools(NEXUS_TOOLS);
    ex.setEnforceContextContract(true);
    ex.resetCalls();

    const r = await ex.executeToolCalls([
      useToolsCall('c1', { memory: '', goal: 'g', tool: 'content read --path a.md' }),
    ]);
    expect(r[0].success).toBe(false);
    expect(r[0].error).toMatch(/memory/i);
    expect(ex.getContextContractStats()).toMatchObject({ steeringErrors: 1, recovered: false });
  });

  it('enforceContextContract also catches dismissive memory ("N/A (First turn)")', async () => {
    const ex = new EvalToolExecutor();
    ex.setDomainTools(NEXUS_TOOLS);
    ex.setEnforceContextContract(true);
    ex.resetCalls();

    const r = await ex.executeToolCalls([
      useToolsCall('c1', { memory: 'N/A (First turn)', goal: 'read it', tool: 'content read --path a.md' }),
    ]);
    expect(r[0].success).toBe(false);
    expect(ex.getContextContractStats().steeringErrors).toBe(1);
  });

  it('does not enforce when neither mode is enabled (empty context tolerated)', async () => {
    const ex = new EvalToolExecutor();
    ex.setDomainTools(NEXUS_TOOLS);
    ex.resetCalls();

    const r = await ex.executeToolCalls([
      useToolsCall('c1', { memory: '', goal: '', tool: 'content read --path a.md' }),
    ]);
    expect(r[0].success).toBe(true);
    expect(ex.getContextContractStats()).toMatchObject({ enforced: false, steeringErrors: 0 });
  });

  it('resetCalls restores the forced-steering budget for the next exchange', async () => {
    const ex = new EvalToolExecutor();
    ex.setDomainTools(NEXUS_TOOLS);
    ex.setForceContextSteering(1);

    ex.resetCalls();
    const a = await ex.executeToolCalls([useToolsCall('a', { memory: 'm', goal: 'g', tool: 'content read --path a.md' })]);
    expect(a[0].success).toBe(false); // steered

    ex.resetCalls(); // new exchange — budget refilled
    const b = await ex.executeToolCalls([useToolsCall('b', { memory: 'm', goal: 'g', tool: 'content read --path a.md' })]);
    expect(b[0].success).toBe(false); // steered again
    expect(ex.getContextContractStats().steeringErrors).toBe(1);
  });
});

describe('EvalToolExecutor — sequential (per-round) responses', () => {
  it('consumes FIFO: same tool returns error then success across rounds', async () => {
    const ex = new EvalToolExecutor();
    ex.setSequentialResponses(true);
    ex.resetCalls(); // mirror EvalRunner: reset, then register the rounds
    ex.registerStaticResponse('contentManager_read', { success: false, error: 'Permission denied' });
    ex.registerStaticResponse('contentManager_read', { success: true, result: { content: 'ok' } });

    const r1 = await ex.executeToolCalls([domainCall('d1', 'contentManager_read', { path: 'a.md' })]);
    expect(r1[0].success).toBe(false);
    expect(r1[0].error).toBe('Permission denied');

    const r2 = await ex.executeToolCalls([domainCall('d2', 'contentManager_read', { path: 'a.md' })]);
    expect(r2[0].success).toBe(true);

    // Once exhausted, the last response is reused (clamped).
    const r3 = await ex.executeToolCalls([domainCall('d3', 'contentManager_read', { path: 'a.md' })]);
    expect(r3[0].success).toBe(true);
  });

  it('default (non-sequential) mode is unchanged: last registration wins for all calls', async () => {
    const ex = new EvalToolExecutor();
    ex.resetCalls();
    ex.registerStaticResponse('contentManager_read', { success: false, error: 'first' });
    ex.registerStaticResponse('contentManager_read', { success: true, result: { content: 'ok' } });

    const r1 = await ex.executeToolCalls([domainCall('d1', 'contentManager_read', { path: 'a.md' })]);
    const r2 = await ex.executeToolCalls([domainCall('d2', 'contentManager_read', { path: 'a.md' })]);
    expect(r1[0].success).toBe(true); // last-write-wins
    expect(r2[0].success).toBe(true);
  });

  it('resetCalls clears the queue so the next exchange re-registers from scratch', async () => {
    const ex = new EvalToolExecutor();
    ex.setSequentialResponses(true);
    ex.resetCalls();
    ex.registerStaticResponse('contentManager_read', { success: false, error: 'e1' });
    await ex.executeToolCalls([domainCall('d1', 'contentManager_read', { path: 'a.md' })]);

    ex.resetCalls(); // new exchange — queue cleared
    ex.registerStaticResponse('contentManager_read', { success: true, result: { content: 'fresh' } });
    const r = await ex.executeToolCalls([domainCall('d2', 'contentManager_read', { path: 'a.md' })]);
    expect(r[0].success).toBe(true);
  });
});
