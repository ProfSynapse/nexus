/**
 * tests/unit/cliGuidanceDrift.test.ts
 *
 * Pins every surface that teaches the useTools CLI string contract to the
 * canonical rule strings in src/agents/toolManager/guidance.ts:
 *
 *   - the useTools MCP surface (tool description + parameter schemas)
 *   - the native chat system prompt (SystemPromptBuilder — also what the
 *     eval harness serves, via tests/eval/fixtures/system-prompt.ts)
 *   - guide/native-chat-system-prompt.md, the hand-maintained mirror doc
 *
 * Why: guidance IS the interface for an AI caller (see
 * shippedGuidanceCommands.test.ts). Before this pin, the contract was stated
 * independently in each place; adding the `values` side-channel meant editing
 * five prose sites by hand, and missing one would teach MCP callers and chat
 * callers different contracts. If this test fails, either re-import the
 * canonical strings in the drifted surface or update the guide mirror to
 * match guidance.ts — never fork the wording.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  CLI_BATCHING_RULE,
  CLI_MULTILINE_RULE,
  CLI_MULTILINE_EXAMPLE,
  CLI_VALUES_RULE,
  CLI_VALUES_EXAMPLE,
} from '../../src/agents/toolManager/guidance';
import { UseToolTool } from '../../src/agents/toolManager/tools/useTools';
import type { ToolBatchExecutionService } from '../../src/agents/toolManager/services/ToolBatchExecutionService';
import type { ToolCliNormalizer } from '../../src/agents/toolManager/services/ToolCliNormalizer';
import { buildProductionSystemPrompt } from '../eval/fixtures/system-prompt';

const CANONICAL: Record<string, string> = {
  CLI_BATCHING_RULE,
  CLI_MULTILINE_RULE,
  CLI_MULTILINE_EXAMPLE,
  CLI_VALUES_RULE,
  CLI_VALUES_EXAMPLE,
};

function expectAllRules(surfaceName: string, text: string): void {
  const missing = Object.entries(CANONICAL)
    .filter(([, rule]) => !text.includes(rule))
    .map(([name]) => name);
  if (missing.length > 0) {
    throw new Error(
      `${surfaceName} is missing canonical CLI guidance: ${missing.join(', ')}. ` +
      'Embed the exported strings from src/agents/toolManager/guidance.ts verbatim.'
    );
  }
}

describe('CLI contract guidance stays single-sourced', () => {
  it('the useTools MCP surface embeds every canonical rule', () => {
    // The constructor only stores services; execute() is never called here.
    const tool = new UseToolTool(
      undefined as unknown as ToolBatchExecutionService,
      undefined as unknown as ToolCliNormalizer
    );
    const schema = tool.getParameterSchema() as {
      properties: Record<string, { description?: string }>;
    };
    const surface = [
      tool.description,
      schema.properties.tool?.description ?? '',
      schema.properties.values?.description ?? '',
    ].join('\n');
    expectAllRules('useTools description/schema', surface);
  });

  it('the native chat system prompt embeds every canonical rule', async () => {
    // The real production builder — the same code path the eval harness uses.
    const prompt = await buildProductionSystemPrompt();
    expectAllRules('SystemPromptBuilder output', prompt);
  });

  it('guide/native-chat-system-prompt.md mirrors the canonical rules verbatim', () => {
    const guide = fs.readFileSync(
      path.join(__dirname, '..', '..', 'guide', 'native-chat-system-prompt.md'),
      'utf8'
    );
    expectAllRules('guide/native-chat-system-prompt.md', guide);
  });
});
