/**
 * Regression coverage for selector-insensitive outer useTools mocks.
 *
 * If a scenario scripts the final action on `useTools` itself, a legitimate
 * preparatory read/list receives that action's success payload and the model is
 * falsely told the work is done. These tests load the real YAML fixtures and
 * prove responses are dispatched by the unwrapped domain command instead.
 */
import { EvalToolExecutor } from './EvalToolExecutor';
import { loadScenarios } from './ScenarioLoader';
import { NEXUS_TOOLS } from './fixtures/tools';
import type { ToolCall } from '../../src/services/llm/adapters/types';
import type { EvalScenario } from './types';

function useToolsCall(command: string): ToolCall {
  return {
    id: `call_${command.replace(/\W+/g, '_')}`,
    type: 'function',
    function: {
      name: 'useTools',
      arguments: JSON.stringify({
        workspaceId: 'default',
        sessionId: 'eval_session_001',
        memory: 'Fixture response-routing regression test',
        goal: 'Execute the requested fixture command',
        tool: command,
      }),
    },
  } as ToolCall;
}

async function loadScenario(file: string, name: string): Promise<EvalScenario> {
  const scenarios = await loadScenarios(`tests/eval/scenarios/${file}`);
  const scenario = scenarios.find((candidate) => candidate.name === name);
  if (!scenario) {
    throw new Error(`Missing scenario ${name} in ${file}`);
  }
  return scenario;
}

function executorFor(scenario: EvalScenario): EvalToolExecutor {
  const executor = new EvalToolExecutor();
  executor.setDomainTools(NEXUS_TOOLS);
  executor.setSequentialResponses(scenario.sequentialMockResponses ?? false);
  for (const turn of scenario.turns) {
    executor.registerTurnResponses(turn.mockResponses ?? {});
  }
  return executor;
}

async function executeCommand(
  executor: EvalToolExecutor,
  command: string,
): Promise<unknown> {
  const [outerResult] = await executor.executeToolCalls([useToolsCall(command)]);
  expect(outerResult.success).toBe(true);

  const payload = outerResult.result as {
    results?: Array<{ success: boolean; result?: unknown; error?: string }>;
  };
  expect(payload.results).toHaveLength(1);
  expect(payload.results?.[0]).toEqual(expect.objectContaining({ success: true }));
  return payload.results?.[0].result;
}

describe('eval scenario response routing', () => {
  it('keeps search and read responses attached to their domain commands', async () => {
    const scenario = await loadScenario('search-variations.eval.yaml', 'search-then-read-chain');
    const executor = executorFor(scenario);

    await expect(executeCommand(executor, 'search content --query "quarterly budget"')).resolves.toEqual({
      results: [{ path: 'finance/q2-budget.md', score: 0.94 }],
    });
    await expect(executeCommand(executor, 'content read --path finance/q2-budget.md --start-line 1')).resolves.toEqual({
      content: expect.stringContaining('# Q2 Budget'),
    });
  });

  it('does not report replacement success for a preparatory read', async () => {
    const scenario = await loadScenario('content-operations.eval.yaml', 'replace-content');
    const executor = executorFor(scenario);

    await expect(executeCommand(executor, 'content read --path notes/config.md --start-line 1')).resolves.toEqual({
      content: expect.stringContaining('environment: staging'),
    });
    await expect(executeCommand(
      executor,
      'content replace --path notes/config.md --start "environment: staging" --end "deployTarget: staging" --content "environment: production\\napiBaseUrl: https://production.example.com\\ndeployTarget: production"',
    )).resolves.toEqual(expect.objectContaining({ linesDelta: 0, totalLines: 5 }));
  });

  it('does not report copy success for a preparatory folder listing', async () => {
    const scenario = await loadScenario('tool-discovery.eval.yaml', 'expand-toolset-mid-conversation');
    const executor = executorFor(scenario);

    await expect(executeCommand(executor, 'storage list --path ""')).resolves.toEqual({
      items: [{ name: 'backup', type: 'folder' }],
    });
    await expect(executeCommand(
      executor,
      'storage copy --path notes/readme.md --new-path backup/readme.md',
    )).resolves.toEqual({ newPath: 'backup/readme.md' });
  });

  it('does not report copy success before copy-and-rename executes', async () => {
    const scenario = await loadScenario('storage-operations.eval.yaml', 'copy-and-rename');
    const executor = executorFor(scenario);

    await expect(executeCommand(executor, 'storage list --path notes')).resolves.toEqual({
      message: 'Mock response for storageManager_list',
    });
    await expect(executeCommand(
      executor,
      'storage copy --path templates/weekly-review.md --new-path notes/this-week.md',
    )).resolves.toEqual({ newPath: 'notes/this-week.md' });
  });

  it('routes each all-agent response to the command that produced it', async () => {
    const scenario = await loadScenario('tool-discovery.eval.yaml', 'all-agents-conversation');
    const executor = executorFor(scenario);

    await expect(executeCommand(executor, 'search content --query "product launch"')).resolves.toEqual({
      results: [{ path: 'marketing/launch-plan.md', score: 0.93 }],
    });
    await expect(executeCommand(
      executor,
      'content read --path marketing/launch-plan.md --start-line 1',
    )).resolves.toEqual({ content: expect.stringContaining('# Launch Plan') });
    await expect(executeCommand(executor, 'storage list --path archive')).resolves.toEqual({
      message: 'Mock response for storageManager_list',
    });
    await expect(executeCommand(
      executor,
      'storage move --path marketing/launch-plan.md --new-path archive/launch-plan.md',
    )).resolves.toEqual({ newPath: 'archive/launch-plan.md' });
  });
});
