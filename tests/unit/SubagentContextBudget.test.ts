/**
 * The subagent context window budgets inherited context.
 *
 * Defect this buys: a subagent inherited every context note and the whole
 * workspace into its system prompt regardless of its context window, so a
 * small subagent model could be handed more context than it can hold. Whole
 * items beyond the budget must be dropped and named in one line.
 */
import { SubagentExecutor } from '../../src/services/chat/SubagentExecutor';
import {
  fitInheritedContext,
  formatTokenCount,
  inheritedContextBudget
} from '../../src/services/chat/subagentContextBudget';
import type { ChatMessage } from '../../src/types/chat/ChatTypes';
import type { SubagentParams } from '../../src/types/branch/BranchTypes';

const FILES: Record<string, string> = {
  'small-a.md': 'A'.repeat(8_000),   // ~2,000 tokens
  'huge-b.md': 'B'.repeat(40_000),   // ~10,000 tokens
  'small-c.md': 'C'.repeat(4_000)    // ~1,000 tokens
};

async function systemPromptFor(params: Partial<SubagentParams>): Promise<string> {
  const messages: ChatMessage[] = [];
  const executor = new SubagentExecutor({
    branchService: {
      createSubagentBranch: jest.fn(async () => 'branch_1'),
      addMessageToBranch: jest.fn(async (_id: string, message: ChatMessage) => { messages.push(message); }),
      getBranch: jest.fn(async () => ({ branch: { messages: [...messages] }, parentMessageId: 'm' })),
      updateMessageInBranch: jest.fn(async () => undefined),
      updateBranchState: jest.fn(async () => undefined)
    } as never,
    messageQueueService: { enqueue: jest.fn(async () => undefined) } as never,
    directToolExecutor: {
      executeToolCalls: jest.fn(async (calls: Array<{ function: { arguments: string } }>) => {
        const { filePath } = JSON.parse(calls[0].function.arguments) as { filePath: string };
        return [{ success: true, result: { content: FILES[filePath] } }];
      })
    } as never,
    streamingGenerator: async function* () {
      yield { type: 'turn.completed' as const };
    }
  });
  const finished = new Promise<void>(resolve => executor.setEventHandlers({ onSubagentComplete: () => resolve() }));
  await executor.executeSubagent({
    task: 'Do the task',
    parentConversationId: 'conv_1',
    parentMessageId: 'msg_1',
    contextFiles: Object.keys(FILES),
    ...params
  });
  await finished;
  const system = messages.find(message => message.role === 'system');
  return system?.content ?? '';
}

describe('subagent inherited context budget', () => {
  it('drops whole files beyond the context window and names them', async () => {
    const prompt = await systemPromptFor({ contextWindow: 8_192 });

    expect(prompt).toContain(FILES['small-a.md']);
    expect(prompt).toContain(FILES['small-c.md']);
    expect(prompt).not.toContain('BBBB');
    expect(prompt).toContain("Omitted to fit this subagent's 8K context window: huge-b.md.");
  });

  it('keeps everything when no context window is set', async () => {
    const prompt = await systemPromptFor({});

    expect(prompt).toContain(FILES['huge-b.md']);
    expect(prompt).not.toContain('Omitted to fit');
  });

  it('drops the workspace context whole when it does not fit', async () => {
    const prompt = await systemPromptFor({
      contextWindow: 8_192,
      contextFiles: [],
      workspaceData: { name: 'Big workspace', context: { purpose: 'P'.repeat(60_000) } }
    });

    expect(prompt).not.toContain('## Workspace Context');
    expect(prompt).toContain('Omitted to fit');
    expect(prompt).toContain('workspace context');
  });
});

describe('fitInheritedContext', () => {
  it('reserves a quarter of the window, at least 4,096 tokens', () => {
    expect(inheritedContextBudget(8_192)).toBe(4_096);
    expect(inheritedContextBudget(200_000)).toBe(150_000);
    expect(inheritedContextBudget(2_048)).toBe(0);
  });

  it('keeps order and tries later, smaller items after a skip', () => {
    const fitted = fitInheritedContext([
      { label: 'a', text: 'x'.repeat(8_000) },
      { label: 'b', text: 'x'.repeat(40_000) },
      { label: 'c', text: 'x'.repeat(4_000) }
    ], 8_192);
    expect(fitted.included.map(item => item.label)).toEqual(['a', 'c']);
    expect(fitted.omitted).toEqual(['b']);
  });

  it('formats token counts like the settings readout', () => {
    expect(formatTokenCount(32_000)).toBe('32K');
    expect(formatTokenCount(1_000_000)).toBe('1M');
    expect(formatTokenCount(1_048_576)).toBe('1M');
    expect(formatTokenCount(1_500_000)).toBe('1.5M');
  });
});
