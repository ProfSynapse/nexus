import type { App, Plugin } from 'obsidian';
import type { ChatService } from '../../src/services/chat/ChatService';
import type { WorkspaceService } from '../../src/services/WorkspaceService';
import { WorkflowRunService } from '../../src/services/workflows/WorkflowRunService';
import { WorkflowPreparationService } from '../../src/services/workflows/WorkflowPreparationService';
import { SessionWorkflowService } from '../../src/services/workflows/SessionWorkflowService';
import { SessionContextManager } from '../../src/services/SessionContextManager';
import { WorkspaceIntegrationService } from '../../src/ui/chat/services/WorkspaceIntegrationService';
import { ModelSelectionUtility } from '../../src/ui/chat/utils/ModelSelectionUtility';
import type { PreparedInstruction, ServiceResult } from '../../src/services/instructions/types';

function fixture(contextWindow = 20000) {
  const workflow = { id: 'outline', name: 'Outline', when: 'Writing', steps: 'Execute selected steps', promptId: 'p-draft', skills: [{ provider: 'nexus', name: 'draft' }] };
  const workspace = { id: 'ws-fiction', name: 'Fiction', rootFolder: '/', context: { workflows: [workflow] }, created: 1, lastAccessed: 1 };
  const preparePrompt = jest.fn(async (): Promise<ServiceResult<PreparedInstruction>> => ({ ok: true, value: { reference: { type: 'prompt', id: 'p-draft' }, name: 'Draft', instructions: 'PROMPT BODY', toolSelectors: [], contentHash: 'p' } }));
  const preparation = new WorkflowPreparationService({ preparePrompt, prepareSkills: async () => ({ ok: true, value: [{ reference: { type: 'skill', provider: 'nexus', name: 'draft' }, name: 'Draft', instructions: 'SKILL BODY', toolSelectors: ['content read'], contentHash: 'h' }] }) }, { resolve: () => ({ ok: true, value: [{ agent: 'contentManager', tool: 'read', command: 'content read', description: 'Read schema' }] }) });
  const sessions = new SessionContextManager(); const save = jest.fn(async () => undefined); sessions.setBindingsStore({ load: async () => null, save });
  const recordLoaded = jest.fn(async () => undefined);
  const selection = new SessionWorkflowService({ sessions, getWorkspace: async () => workspace, prepare: (value, id) => preparation.prepare(value, id), recordLoaded });
  const create = jest.fn(async () => ({ success: true, conversationId: 'c-run', sessionId: 's-run' }));
  const send = jest.fn(async () => ({ success: true }));
  const model = { providerId: 'openai', providerName: 'OpenAI', modelId: 'fiction-model', modelName: 'Fiction model', contextWindow };
  jest.spyOn(ModelSelectionUtility, 'getAvailableModels').mockResolvedValue([model]);
  jest.spyOn(ModelSelectionUtility, 'findDefaultModelOption').mockResolvedValue(model);
  jest.spyOn(WorkspaceIntegrationService.prototype, 'loadWorkspace').mockResolvedValue({ id: workspace.id, workflowDefinitions: workspace.context.workflows, context: { name: workspace.name } });
  jest.spyOn(WorkspaceIntegrationService.prototype, 'getBuiltInDocsWorkspaceInfo').mockResolvedValue(null);
  const run = new WorkflowRunService({ app: {} as App, plugin: {} as Plugin, workspaceService: { getWorkspace: async () => workspace } as unknown as WorkspaceService,
    chatService: { createConversation: create, sendMessage: send } as unknown as ChatService,
    workflowPreparation: preparation, sessionWorkflows: selection });
  return { run, create, send, preparePrompt, save, recordLoaded, sessions };
}

describe('Workflow run shared preparation', () => {
  afterEach(() => jest.restoreAllMocks());
  it('prepares and activates instructions before creating and executing the workflow conversation', async () => {
    const { run, create, send, sessions, recordLoaded } = fixture();
    await run.start({ workspaceId: 'ws-fiction', workflowId: 'outline', openInChat: false });
    expect(create).toHaveBeenCalledTimes(1); expect(send).toHaveBeenCalledTimes(1);
    const options = create.mock.calls[0][2];
    expect(options.systemPrompt).toContain('PROMPT BODY'); expect(options.systemPrompt).toContain('SKILL BODY');
    expect(options.workflowId).toBe('outline'); expect(options.promptId).toBeUndefined();
    expect(sessions.getWorkflowSelection(options.sessionId)?.workflowId).toBe('outline'); expect(recordLoaded).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][1]).toContain('Run workflow: Outline');
    expect((options.systemPrompt + send.mock.calls[0][1]).split('Execute selected steps')).toHaveLength(2);
  });
  it('unavailable instructions fail before session mutation, conversation creation, or execution', async () => {
    const { run, create, send, save, recordLoaded, preparePrompt } = fixture();
    preparePrompt.mockResolvedValueOnce({ ok: false, error: { code: 'archived', message: 'Draft prompt is archived' } });
    await expect(run.start({ workspaceId: 'ws-fiction', workflowId: 'outline', openInChat: false })).rejects.toThrow('archived');
    expect(save).not.toHaveBeenCalled(); expect(create).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled(); expect(recordLoaded).not.toHaveBeenCalled();
  });
  it('checks XML-expanded final run input before committing or sending', async () => {
    const { run, create, send, save, preparePrompt } = fixture(6000);
    preparePrompt.mockResolvedValueOnce({ ok: true, value: { reference: { type: 'prompt', id: 'p-draft' }, name: 'Draft', instructions: '&'.repeat(6000), toolSelectors: [], contentHash: 'expanded' } });
    await expect(run.start({ workspaceId: 'ws-fiction', workflowId: 'outline', openInChat: false })).rejects.toThrow('context budget');
    expect(save).not.toHaveBeenCalled(); expect(create).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
  });
  it('a small model budget fails before activation and execution', async () => {
    const { run, create, send, save } = fixture(100);
    await expect(run.start({ workspaceId: 'ws-fiction', workflowId: 'outline', openInChat: false })).rejects.toThrow('context budget');
    expect(save).not.toHaveBeenCalled(); expect(create).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
  });
});
