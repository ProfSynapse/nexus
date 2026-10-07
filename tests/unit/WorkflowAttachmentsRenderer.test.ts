/** UI callbacks mutate only explicit attachments; the real catalog decides the preload union. */
import { Component, DropdownComponent, Setting, createMockElement } from 'obsidian';
import { WorkflowAttachmentsRenderer } from '../../src/components/workspace/WorkflowAttachmentsRenderer';
import { InstructionLibraryService } from '../../src/services/instructions/InstructionLibraryService';
import { InstructionMetadataService } from '../../src/services/instructions/InstructionMetadataService';
import { CustomPromptStorageService } from '../../src/agents/promptManager/services/CustomPromptStorageService';
import { ToolCatalogService } from '../../src/agents/toolManager/services/ToolCatalogService';
import { BaseAgent } from '../../src/agents/baseAgent';
import { CONSERVATIVE_TOOL_EXECUTION_POLICY } from '../../src/agents/policy/ToolExecutionPolicy';
import { encodeInstructionReference } from '../../src/services/instructions/InstructionReferenceCodec';
import type { ITool } from '../../src/agents/interfaces/ITool';
import type { WorkspaceWorkflow } from '../../src/database/types/workspace/WorkspaceTypes';
import type { InstructionLibrarySettings, InstructionSkillPort } from '../../src/services/instructions/types';
import type { Settings } from '../../src/settings';

class TestAgent extends BaseAgent {
  constructor(tools: ITool[]) { super('contentManager', 'Fixture', '1.0.0'); tools.forEach(tool => this.registerTool(tool)); }
}
function makeTool(slug: string): ITool {
  return { slug, name: slug, version: '1', description: slug,
    execute: jest.fn(async () => ({ success: true })), getExecutionPolicy: () => CONSERVATIVE_TOOL_EXECUTION_POLICY,
    getParameterSchema: () => ({ type: 'object', properties: {} }), getResultSchema: () => ({ type: 'object' }) };
}
async function setup(workflow: WorkspaceWorkflow) {
  let metadata: InstructionLibrarySettings = { version: 1, items: {} };
  const organization = new InstructionMetadataService({ getSettings: () => metadata, setSettings: value => { metadata = value; }, saveSettings: async () => undefined });
  const settings = { settings: { customPrompts: { enabled: true, prompts: [] } }, saveSettings: async () => undefined } as unknown as Settings;
  const skillPort: InstructionSkillPort = {
    list: async () => ({ ok: true, value: [{ id: 'id', provider: 'codex', name: 'Review', description: '', vaultPath: 'Root/skills/codex/Review', contentHash: 'hash', isArchived: false, created: 1, updated: 1 }] }),
    getDetail: async () => ({ ok: false, error: { code: 'not-found', message: 'No detail required for preview' } }),
    prepareMany: jest.fn(async references => ({ ok: true, value: references.map(reference => ({ reference: { type: 'skill' as const, ...reference }, name: reference.name, instructions: 'Inspect sources.', toolSelectors: ['contentManager read'], contentHash: 'hash' })) }))
  };
  const library = new InstructionLibraryService(new CustomPromptStorageService(null, settings), skillPort, organization);
  const read = makeTool('read'), write = makeTool('write');
  const catalog = new ToolCatalogService(() => new Map([['contentManager', new TestAgent([read, write])]]));
  const renderer = new WorkflowAttachmentsRenderer(workflow, { getLibrary: async () => library, getCatalog: async () => catalog }, new Component());
  const container = createMockElement('div');
  await renderer['load'](container, container.createEl('p'));
  return { renderer, skillPort, read, write };
}
function commands(preview: HTMLElement): string[] {
  return (preview.createDiv as jest.Mock).mock.results.map(result => {
    const row = result.value as HTMLElement;
    return (row.createEl as jest.Mock).mock.calls.find(([tag]) => tag === 'code')?.[1].text;
  }).filter(Boolean);
}

describe('WorkflowAttachmentsRenderer', () => {
  const dropdowns = new Map<string, (value: string) => void>();
  let name = '';
  beforeEach(() => {
    dropdowns.clear();
    jest.spyOn(Setting.prototype, 'setName').mockImplementation(function (value) { name = value; return this; });
    jest.spyOn(DropdownComponent.prototype, 'onChange').mockImplementation(function (callback) { dropdowns.set(name, callback); return this; });
  });
  afterEach(() => jest.restoreAllMocks());

  it('adds qualified skills once and deduplicates their required tools with extra aliases without executing', async () => {
    const workflow: WorkspaceWorkflow = { id: 'workflow', name: 'Review', when: 'Before publication', steps: 'Inspect evidence.', tools: ['content read'] };
    const state = await setup(workflow);
    const choose = dropdowns.get('Add skill');
    const reference = encodeInstructionReference({ type: 'skill', provider: 'codex', name: 'Review' });
    choose?.(reference); choose?.(reference);
    dropdowns.get('Add tool')?.('content write');
    const preview = state.renderer['preview'];
    if (!preview) throw new Error('Expected preview');
    (preview.createDiv as jest.Mock).mockClear();
    await state.renderer['refreshPreview']();
    expect(workflow.skills).toEqual([{ provider: 'codex', name: 'Review' }]);
    expect(workflow.tools).toEqual(['content read', 'content write']);
    expect(commands(preview)).toEqual(['content read', 'content write']);
    expect(state.skillPort.prepareMany).toHaveBeenCalledWith([{ provider: 'codex', name: 'Review' }]);
    expect(state.read.execute).not.toHaveBeenCalled(); expect(state.write.execute).not.toHaveBeenCalled();
    state.renderer.destroy();
  });

  it('retains missing attachments and legacy prompt names while surfacing unavailable tool errors', async () => {
    const workflow: WorkspaceWorkflow = { id: 'workflow', name: 'Legacy', when: '', steps: '', promptName: 'Old prompt', skills: [{ provider: 'missing', name: 'Absent' }], tools: ['web open'] };
    const state = await setup(workflow);
    const preview = state.renderer['preview'];
    if (!preview) throw new Error('Expected preview');
    (preview.createEl as jest.Mock).mockClear();
    await state.renderer['refreshPreview']();
    expect(workflow).toMatchObject({ promptName: 'Old prompt', skills: [{ provider: 'missing', name: 'Absent' }], tools: ['web open'] });
    expect((preview.createEl as jest.Mock).mock.calls).toEqual(expect.arrayContaining([['p', expect.objectContaining({ cls: 'nexus-instruction-error', text: expect.stringContaining('web') })]]));
    expect(state.read.execute).not.toHaveBeenCalled();
    state.renderer.destroy();
  });
});
