import type { App } from 'obsidian';
import { MemoryManagerAgent } from '../../src/agents/memoryManager/memoryManager';
import { SessionContextManager } from '../../src/services/SessionContextManager';
import { SessionWorkflowService } from '../../src/services/workflows/SessionWorkflowService';
import { WorkflowPreparationService } from '../../src/services/workflows/WorkflowPreparationService';
import { WorkspaceIntegrationService } from '../../src/ui/chat/services/WorkspaceIntegrationService';
import { ModelAgentWorkspaceContextService } from '../../src/ui/chat/services/ModelAgentWorkspaceContextService';
import { SystemPromptBuilder } from '../../src/ui/chat/services/SystemPromptBuilder';
import { ModelAgentPromptContextAssembler, type ModelAgentPromptContextSnapshot } from '../../src/ui/chat/services/ModelAgentPromptContextAssembler';
import type { LoadWorkspaceResult } from '../../src/database/types/workspace/ParameterTypes';
import type { PreparedInstruction, ServiceResult } from '../../src/services/instructions/types';

function fixture() {
  const workflow = { id: 'outline', name: 'Outline', when: 'Drafting fiction', steps: 'SELECTED STEPS', promptId: 'p-outline', skills: [{ provider: 'nexus', name: 'draft' }], tools: ['content read'] };
  const hidden = { id: 'paint', name: 'Paint', when: 'Illustrating', steps: 'INACTIVE STEPS' };
  const skill: PreparedInstruction = { reference: { type: 'skill', provider: 'nexus', name: 'draft' }, name: 'Draft', instructions: 'SKILL BODY', contentHash: 'h', toolSelectors: ['content read'] };
  const prompt: PreparedInstruction = { reference: { type: 'prompt', id: 'p-outline' }, name: 'Outline', instructions: 'WORKFLOW PROMPT', contentHash: 'p', toolSelectors: [] };
  const schema = { agent: 'contentManager', tool: 'read', command: 'content read', description: 'SCHEMA MARKER' };
  const instructions = { preparePrompt: jest.fn(async (): Promise<ServiceResult<PreparedInstruction>> => ({ ok: true, value: prompt })), prepareSkills: jest.fn(async () => ({ ok: true as const, value: [skill] })) };
  const preparation = new WorkflowPreparationService(instructions, { resolve: () => ({ ok: true, value: [schema] }) });
  const sessions = new SessionContextManager();
  const store = { load: async () => null, save: jest.fn(async () => undefined) }; sessions.setBindingsStore(store);
  const recordLoaded = jest.fn(async () => undefined);
  const workspace = { id: 'ws-fiction', context: { workflows: [workflow, hidden] } };
  const activation = new SessionWorkflowService({ sessions, getWorkspace: async () => workspace, prepare: (value, id) => preparation.prepare(value, id), recordLoaded });
  const memory = Object.create(MemoryManagerAgent.prototype) as MemoryManagerAgent;
  const briefing = { success: true, workspaceContext: { workspaceId: workspace.id }, data: { context: { name: 'Fiction' }, workflowDefinitions: workspace.context.workflows, workflows: ['INACTIVE STEPS'], availableWorkflows: [{ id: workflow.id, name: workflow.name }], workspaceStructure: [], prompt: { id: 'p-base', name: 'Base', systemPrompt: 'WORKSPACE PROMPT' } } } as unknown as LoadWorkspaceResult;
  const reader = jest.fn(async () => briefing); memory.readWorkspaceBriefing = reader;
  memory.executeTool = jest.fn();
  const registry: Record<string, unknown> = { agentManager: { getAgent: () => memory }, workflowPreparationService: preparation, sessionWorkflowService: activation, sessionContextManager: sessions };
  const app = { plugins: { getPlugin: () => ({ getService: async (name: string) => registry[name] ?? null }) } } as unknown as App;
  const integration = new WorkspaceIntegrationService(app);
  return { integration, activation, sessions, instructions, recordLoaded, reader, memory, schema, skill, store };
}
const snapshot: ModelAgentPromptContextSnapshot = {
  selectedModel: { providerId: 'openai', providerName: 'OpenAI', modelId: 'model', modelName: 'Model', contextWindow: 20000 },
  selectedWorkspaceId: 'ws-fiction', workspaceContext: null, loadedWorkspaceData: null, contextNotes: [], messageEnhancement: null,
  currentSystemPrompt: 'INDEPENDENT CHAT PROMPT', thinkingSettings: { enabled: false, effort: 'medium' }, temperature: 0.5,
  imageProvider: 'openai', imageModel: 'image', transcriptionProvider: null, transcriptionModel: null,
  contextTokenTracker: null, compactionFrontier: [], latestCompactionRecord: null,
};

describe('Native workflow integration', () => {
  it('passive reads use canonical workspace argument and never public execution, binding, or recency', async () => {
    const { integration, reader, memory, store, recordLoaded } = fixture();
    expect((await integration.loadWorkspace('ws-fiction'))?.id).toBe('ws-fiction');
    expect(reader).toHaveBeenCalledWith(expect.objectContaining({ workspace: 'ws-fiction' }));
    expect(memory.executeTool).not.toHaveBeenCalled(); expect(store.save).not.toHaveBeenCalled(); expect(recordLoaded).not.toHaveBeenCalled();
    const context = new ModelAgentWorkspaceContextService(integration); await context.restoreWorkspace('ws-fiction', 's-chat');
    expect(store.save).not.toHaveBeenCalled();
  });
  it('explicit activation composes selected bodies and schemas once and preserves independent prompt after clear', async () => {
    const { integration, activation, skill, schema, recordLoaded } = fixture();
    const data = await integration.activateWorkspace('ws-fiction', 's-chat', 'Outline', { maxTokens: 10000 });
    const builder = new SystemPromptBuilder(async () => '');
    const assembler = new ModelAgentPromptContextAssembler({ systemPromptBuilder: builder, getSessionId: async () => 's-chat', restoreWorkflow: session => activation.restore(session), prepareIndividualSkills: async () => ({ skills: [skill], tools: [schema] }) });
    const text = await assembler.buildSystemPrompt({ ...snapshot, loadedWorkspaceData: data });
    for (const marker of ['SKILL BODY', 'WORKFLOW PROMPT', 'SCHEMA MARKER', 'SELECTED STEPS']) expect(text?.split(marker).length).toBe(2);
    expect(text).not.toContain('INACTIVE STEPS'); expect(text).not.toContain('INDEPENDENT CHAT PROMPT'); expect(text).not.toContain('WORKSPACE PROMPT');
    expect(recordLoaded).toHaveBeenCalledTimes(1);
    await integration.activateWorkspace('ws-fiction', 's-chat');
    const plain = await assembler.buildSystemPrompt({ ...snapshot, loadedWorkspaceData: data });
    expect(plain).toContain('INDEPENDENT CHAT PROMPT'); expect(plain).not.toContain('SELECTED STEPS');
    expect(snapshot.currentSystemPrompt).toBe('INDEPENDENT CHAT PROMPT'); expect(recordLoaded).toHaveBeenCalledTimes(1);
  });
  it('rejects actual escaped native composition before commit and preserves previous selection', async () => {
    const { integration, activation, instructions, store, recordLoaded } = fixture();
    await integration.activateWorkspace('ws-fiction', 's-chat', 'Outline');
    const previous = activation.getSelection('s-chat'); const writes = store.save.mock.calls.length;
    instructions.preparePrompt.mockResolvedValueOnce({ ok: true, value: { reference: { type: 'prompt', id: 'p-outline' }, name: 'Outline', instructions: '&'.repeat(6000), toolSelectors: [], contentHash: 'large' } });
    const assembler = new ModelAgentPromptContextAssembler({ systemPromptBuilder: new SystemPromptBuilder(async () => ''), getSessionId: async () => 's-chat', restoreWorkflow: session => activation.restore(session) });
    await expect(integration.activateWorkspace('ws-fiction', 's-chat', 'Outline', { maxTokens: 10000 }, async (bundle, briefing) => {
      try {
        await assembler.buildSystemPrompt({ ...snapshot, selectedModel: { ...snapshot.selectedModel!, contextWindow: 6000 }, loadedWorkspaceData: briefing.data }, bundle);
        return { ok: true, value: undefined };
      } catch (error) { return { ok: false, error: { code: 'invalid', message: error instanceof Error ? error.message : String(error) } }; }
    })).rejects.toThrow('context budget');
    expect(activation.getSelection('s-chat')).toEqual(previous); expect(store.save).toHaveBeenCalledTimes(writes); expect(recordLoaded).toHaveBeenCalledTimes(1);
  });
  it('missing/oversized selection fails before binding and restore errors block native composition', async () => {
    const { integration, activation, instructions, store } = fixture();
    await expect(integration.activateWorkspace('ws-fiction', 's-chat', 'missing')).rejects.toThrow('not found');
    await expect(integration.activateWorkspace('ws-fiction', 's-chat', 'Outline', { maxTokens: 0 })).rejects.toThrow('context budget');
    expect(store.save).not.toHaveBeenCalled();
    await integration.activateWorkspace('ws-fiction', 's-chat', 'Outline');
    instructions.preparePrompt.mockResolvedValueOnce({ ok: false, error: { code: 'archived', message: 'Outline prompt is archived' } });
    const assembler = new ModelAgentPromptContextAssembler({ systemPromptBuilder: new SystemPromptBuilder(async () => ''), getSessionId: async () => 's-chat', restoreWorkflow: session => activation.restore(session) });
    await expect(assembler.buildSystemPrompt(snapshot)).rejects.toThrow('archived');
  });
});
