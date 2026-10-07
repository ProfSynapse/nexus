/** Actual preparation must stop before activation on ambiguous or unavailable dependencies. */
import { WorkflowPreparationService } from '../../src/services/workflows/WorkflowPreparationService';
import type { Workspace, WorkspaceWorkflow } from '../../src/database/types/workspace/WorkspaceTypes';
import type { InstructionPreparationPort, ToolCatalogPort } from '../../src/services/instructions/types';

function setup() {
  const instructions: InstructionPreparationPort = {
    preparePrompt: jest.fn(async () => ({ ok: true, value: { reference: { type: 'prompt', id: 'prompt-id' }, name: 'Review', instructions: 'Check evidence.', toolSelectors: [], contentHash: 'prompt-hash' } })),
    prepareSkills: jest.fn(async refs => ({ ok: true, value: refs.map(ref => ({ reference: { type: 'skill', ...ref }, name: ref.name, instructions: 'Record decisions.', resourceRoot: `Root/skills/${ref.provider}/${ref.name}`, resources: ['SKILL.md','references/checks.md'], toolSelectors: ['content read'], contentHash: 'skill-hash' })) }))
  };
  const catalog: ToolCatalogPort = { resolve: jest.fn(selectors => ({ ok: true, value: selectors.map(selector => ({ agent: 'contentManager', tool: selector, description: 'Full schema', command: selector, usage: `${selector} --path <path>`, arguments: [] })) })) };
  const workflow: WorkspaceWorkflow = { id: 'workflow-id', name: 'Evidence review', when: 'Before publishing', steps: 'Inspect claims.', promptId: 'prompt-id', skills: [{ provider: 'nexus', name: 'minutes' }], tools: ['content read', 'content write'] };
  const workspace: Pick<Workspace,'context'> = { context: { workflows: [workflow] } };
  return { instructions, catalog, service: new WorkflowPreparationService(instructions,catalog), workflow, workspace };
}

describe('workflow preparation', () => {
  test('resolves ID first/full name, normalizes duplicate refs and unions required selectors once', async () => {
    const state = setup();
    state.workflow.skills?.push({ provider: 'nexus', name: 'minutes' });
    expect(await state.service.prepare(state.workspace,'evidence review')).toMatchObject({ ok: true, value: { id: 'workflow-id', steps: 'Inspect claims.', skills: [{ instructions: 'Record decisions.', resources: ['SKILL.md','references/checks.md'] }], preloadedTools: [{ usage: expect.any(String) },{ usage: expect.any(String) }], revision: expect.any(String) } });
    expect(state.instructions.prepareSkills).toHaveBeenCalledWith([{ provider: 'nexus', name: 'minutes' }]);
    expect(state.catalog.resolve).toHaveBeenCalledWith(['content read', 'content write']);
    expect(await state.service.prepare(state.workspace,'Evidence')).toMatchObject({ ok: false,error:{code:'not-found'} });
    state.workspace.context?.workflows?.push({ ...state.workflow,id:'other',name:'EVIDENCE REVIEW' });
    expect(await state.service.prepare(state.workspace,'Evidence review')).toMatchObject({ ok:false,error:{code:'ambiguous'} });
    expect(await state.service.prepare(state.workspace,'workflow-id')).toMatchObject({ok:true});
  });

  test('fails a missing/archived prompt without processing skills or tools', async () => {
    const state=setup();
    jest.mocked(state.instructions.preparePrompt).mockResolvedValue({ok:false,error:{code:'archived',message:'Restore prompt'}});
    expect(await state.service.prepare(state.workspace,'workflow-id')).toEqual({ok:false,error:{code:'archived',message:'Restore prompt'}});
    expect(state.instructions.prepareSkills).not.toHaveBeenCalled();
    expect(state.catalog.resolve).not.toHaveBeenCalled();
  });

  test('fails skill/tool dependency errors explicitly and does not return a partial bundle', async () => {
    const state=setup();
    jest.mocked(state.instructions.prepareSkills).mockResolvedValueOnce({ok:false,error:{code:'not-found',message:'Skill missing'}});
    expect(await state.service.prepare(state.workspace,'workflow-id')).toMatchObject({ok:false,error:{message:'Skill missing'}});
    expect(state.catalog.resolve).not.toHaveBeenCalled();
    jest.mocked(state.catalog.resolve).mockReturnValue({ok:false,error:{code:'unavailable',message:'Agent disabled'}});
    expect(await state.service.prepare(state.workspace,'workflow-id')).toMatchObject({ok:false,error:{message:'Agent disabled'}});
  });

  test('keeps steps-only workflows independent of unavailable optional services',async()=>{
    const state=setup();
    const definition={id:'simple',name:'Simple',when:'Requested',steps:'Think carefully.'};
    expect(await state.service.prepareDefinition(definition)).toMatchObject({ok:true,value:{skills:[],preloadedTools:[]}});
    expect(state.instructions.preparePrompt).not.toHaveBeenCalled();
    expect(state.instructions.prepareSkills).not.toHaveBeenCalled();
    expect(state.catalog.resolve).not.toHaveBeenCalled();
  });

  test('rejects malformed stored attachment payloads/blank identifiers before dependencies',async()=>{
    const state=setup();
    state.workflow.tools=['content read --path secrets'];
    expect(await state.service.prepare(state.workspace,'workflow-id')).toMatchObject({ok:false,error:{code:'invalid'}});
    expect(await state.service.prepare(state.workspace,' ')).toMatchObject({ok:false,error:{code:'invalid'}});
    expect(state.instructions.preparePrompt).not.toHaveBeenCalled();
  });

  test('revision changes for instruction contents/tool schema changes, and size budget fails before activation',async()=>{
    const state=setup();
    const first=await state.service.prepare(state.workspace,'workflow-id');
    if(!first.ok) throw new Error('Preparation failed');
    state.workflow.steps='Inspect different claims.';
    const next=await state.service.prepare(state.workspace,'workflow-id');
    if(!next.ok) throw new Error('Preparation failed');
    expect(next.value.revision).not.toBe(first.value.revision);
    const size=state.service.measure(next.value);
    expect(size.bytes).toBeGreaterThan(0);
    expect(size.estimatedTokens).toBeGreaterThan(0);
    expect(await state.service.prepare(state.workspace,'workflow-id',{maxTokens:1})).toMatchObject({ok:false,error:{code:'invalid',message:expect.stringContaining('tokens')}});
    expect(await state.service.prepare(state.workspace,'workflow-id',{maxBytes:1})).toMatchObject({ok:false});
  });
});
