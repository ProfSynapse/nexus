/**
 * tests/eval/fixtures/catalog-parity.test.ts — the advertised surface and the
 * executable surface must be the same surface.
 *
 * The eval system prompt is built by the production SystemPromptBuilder from
 * DEFAULT_TOOL_CATALOG, so that catalog is the model's only statement of what
 * exists. The executor resolves CLI commands against NEXUS_TOOLS, and
 * assertNoHallucinatedTools accepts only names it can produce. When the two
 * disagree, a model that obeys its own system prompt is graded as hallucinating
 * a tool — silently, and on every scenario it happens in.
 *
 * These tests pin the invariant so the drift is caught at `npm test` rather than
 * discovered while attributing a bad grade.
 */

import { EvalToolExecutor } from '../EvalToolExecutor';
import { assertNoHallucinatedTools } from '../assertions';
import { NEXUS_TOOLS, META_TOOLS } from './tools';
import { DEFAULT_TOOL_CATALOG } from './system-prompt';
import type { ToolCall } from '../../../src/services/llm/adapters/types';

/** Mirror of toKebabCase in EvalToolExecutor — the alias the model types. */
function toKebabCase(value: string): string {
  return value
    .replace(/Manager$/i, '')
    .replace(/Agent$/i, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[_\s]+/g, '-')
    .replace(/--+/g, '-')
    .toLowerCase();
}

function cliForm(agent: string, tool: string): string {
  return `${toKebabCase(agent)} ${toKebabCase(tool)}`;
}

const advertisedCommands = DEFAULT_TOOL_CATALOG.flatMap((entry) =>
  entry.tools.map((tool) => cliForm(entry.agent, tool)),
);

const fixtureCommands = NEXUS_TOOLS.map((tool) => {
  const [agent, name] = (tool.function?.name ?? '').split('_');
  return cliForm(agent, name ?? '');
});

const validToolNames = [
  ...META_TOOLS.map((t) => t.function?.name),
  ...NEXUS_TOOLS.map((t) => t.function?.name),
].filter((name): name is string => Boolean(name));

function useToolsCall(command: string): ToolCall {
  return {
    id: `call_${command.replace(/\W+/g, '_')}`,
    type: 'function',
    function: {
      name: 'useTools',
      arguments: JSON.stringify({
        workspaceId: 'default',
        sessionId: 'eval_session_001',
        memory: 'parity check',
        goal: 'call an advertised command',
        tool: command,
      }),
    },
  } as ToolCall;
}

describe('eval fixture catalog parity', () => {
  it('advertises no command the executor cannot resolve', () => {
    const unbacked = advertisedCommands.filter((command) => !fixtureCommands.includes(command));
    expect(unbacked).toEqual([]);
  });

  it('defines no fixture tool the prompt never advertises', () => {
    const unadvertised = fixtureCommands.filter((command) => !advertisedCommands.includes(command));
    expect(unadvertised).toEqual([]);
  });

  it('has no duplicate fixture tool names', () => {
    expect(new Set(fixtureCommands).size).toBe(fixtureCommands.length);
  });

  it('grades every advertised command as a real call, not a hallucination', async () => {
    const executor = new EvalToolExecutor();
    executor.setDomainTools(NEXUS_TOOLS);

    for (const command of advertisedCommands) {
      await executor.executeToolCalls([useToolsCall(command)]);
    }

    const captured = executor.getCapturedCalls();
    const assertion = assertNoHallucinatedTools(captured, validToolNames);
    expect(assertion.errors).toEqual([]);
    expect(assertion.passed).toBe(true);

    // Every advertised command must also have produced an inner domain call —
    // a command that resolves to nothing is captured as useTools alone and
    // would fail its scenario's expected-tool assertion instead.
    const innerNames = captured.filter((call) => call.name !== 'useTools').map((call) => call.name);
    expect(innerNames).toHaveLength(advertisedCommands.length);
  });

  it('exposes every advertised command through getTools discovery', async () => {
    const executor = new EvalToolExecutor();
    executor.setDomainTools(NEXUS_TOOLS);

    const agents = [...new Set(DEFAULT_TOOL_CATALOG.map((entry) => toKebabCase(entry.agent)))];
    const [result] = await executor.executeToolCalls([
      {
        id: 'call_discovery',
        type: 'function',
        function: {
          name: 'getTools',
          arguments: JSON.stringify({
            workspaceId: 'default',
            sessionId: 'eval_session_001',
            memory: 'parity check',
            goal: 'discover everything advertised',
            tool: agents.join(', '),
          }),
        },
      } as ToolCall,
    ]);

    const tools = (result.result as { tools: Array<{ command: string }> }).tools;
    const discovered = tools.map((entry) => entry.command);
    expect(discovered.sort()).toEqual([...advertisedCommands].sort());
  });
});
