/** Guards missing capability discovery and delegations landing in a newly selected chat. */
import { SystemPromptBuilder } from '../../../src/ui/chat/services/SystemPromptBuilder';
import { SubagentTool } from '../../../src/agents/promptManager/tools/subagent';
import type { SubagentToolParams } from '../../../src/agents/promptManager/tools/subagent';
import type { RemoteAgentJobService } from '../../../src/services/remoteAgents/RemoteAgentJobService';
import type { SubagentExecutor } from '../../../src/services/chat/SubagentExecutor';

const task = (values: Partial<SubagentToolParams> = {}): SubagentToolParams => ({
  task: 'Organize the project',
  context: { workspaceId: 'workspace', sessionId: 'session', memory: 'Testing delegation', goal: 'Verify origin' },
  ...values,
});

it('omits remote instructions when no agents are available and includes only display fields', async () => {
  const builder = new SystemPromptBuilder(async () => '');
  expect(await builder.build({})).not.toContain('<remote_agents>');
  const connection = { id: 'remote-home', displayName: 'Home agent', description: '', apiKey: 'secret-value', baseUrl: 'https://private.example/v1' };
  const prompt = await builder.build({ remoteAgents: [connection] });
  expect(prompt).toContain('Home agent');
  expect(prompt).toContain('remote-home');
  expect(prompt).toContain('general-purpose');
  expect(prompt).toContain('--task-context');
  expect(prompt).toContain('Do not submit the same task again');
  expect(prompt).not.toContain('secret-value');
  expect(prompt).not.toContain('private.example');
  expect(await builder.build({ remoteAgents: [] })).not.toContain('<remote_agents>');
});

it('delegates without a local executor and pins origin to the runtime rather than current view', async () => {
  const tool = new SubagentTool();
  const executeSubagent = jest.fn().mockResolvedValue({ subagentId: 'job', branchId: 'branch' });
  tool.setRemoteAgentJobs({ executeSubagent } as unknown as RemoteAgentJobService);
  tool.setContextProvider(() => ({ conversationId: 'new-chat', messageId: 'new-message', source: 'internal', contextNotes: ['private-note.md'], agentPrompt: 'Do not forward this prompt' }));
  const result = await tool.execute(task({ target: 'remote-home', taskContext: 'Only this context' }), {
    conversationId: 'original-chat', messageId: 'original-message', source: 'internal',
  });
  expect(result.success).toBe(true);
  expect(executeSubagent).toHaveBeenCalledWith(expect.objectContaining({
    target: 'remote-home', parentConversationId: 'original-chat', parentMessageId: 'original-message', context: 'Only this context',
  }));
  expect(executeSubagent.mock.calls[0][0].contextFiles).toBeUndefined();
  expect(executeSubagent.mock.calls[0][0].agentPrompt).toBeUndefined();
});

it('keeps local dispatch and rejects incompatible remote flags, MCP and nested delegation', async () => {
  const tool = new SubagentTool();
  const local = jest.fn().mockResolvedValue({ subagentId: 'local', branchId: 'branch' });
  const remote = jest.fn();
  tool.setSubagentExecutor({ executeSubagent: local } as unknown as SubagentExecutor);
  tool.setRemoteAgentJobs({ executeSubagent: remote } as unknown as RemoteAgentJobService);
  tool.setContextProvider(() => ({ conversationId: 'chat', messageId: 'msg', source: 'internal', provider: 'configured', model: 'chosen' }));
  expect((await tool.execute(task())).success).toBe(true);
  expect(local).toHaveBeenCalledWith(expect.objectContaining({ provider: 'configured', model: 'chosen' }));
  expect((await tool.execute(task({ target: 'home', contextFiles: ['note.md'] }))).success).toBe(false);
  expect((await tool.execute(task({ target: 'home' }), { conversationId: 'chat', messageId: 'msg', source: 'mcp' })).success).toBe(false);
  expect((await tool.execute(task({ target: 'home' }), { conversationId: 'chat', messageId: 'msg', source: 'internal', isSubagentBranch: true })).success).toBe(false);
  expect(remote).not.toHaveBeenCalled();
});
