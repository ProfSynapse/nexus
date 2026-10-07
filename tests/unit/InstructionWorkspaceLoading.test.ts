/** Failed preparation/passive refresh must never clear or replace a deliberate session setup. */
import { WorkspaceLoadService } from '../../src/services/workspace/WorkspaceLoadService';
import { WorkflowPreparationService } from '../../src/services/workflows/WorkflowPreparationService';
import type { LoadWorkspaceParameters, LoadWorkspaceResult } from '../../src/database/types/workspace/ParameterTypes';
import type { SessionWorkflowPort, PreparedWorkflow, WorkflowSelection, ServiceResult } from '../../src/services/instructions/types';

function setup() {
  const params: LoadWorkspaceParameters = {workspace:'Display Name',workflow:'Review',context:{sessionId:'canonical-session-id',workspaceId:'previous-workspace',memory:'Evidence',goal:'Inspect'}};
  const result: LoadWorkspaceResult = {success:true,workspaceContext:{workspaceId:'canonical-workspace-id',workspacePath:[]},data:{context:{name:'Display Name',rootFolder:'Root',recentActivity:[]},workflows:[],workflowDefinitions:[{id:'workflow-id',name:'Review',when:'Requested',steps:'Review evidence.',promptId:'prompt-id'}],workspaceStructure:[],recentFiles:[],keyFiles:{},preferences:'',sessions:[],states:[],prompt:{id:'workspace-prompt',name:'Workspace prompt',systemPrompt:'Should be replaced once.'}}};
  let generation=0;
  let selection:WorkflowSelection|null={workspaceId:'previous-workspace',workflowId:'previous-flow',revision:'old'};
  const activation:SessionWorkflowPort={
    begin:jest.fn(()=>++generation),
    commit:jest.fn(async(_session:string,workspaceId:string,bundle:PreparedWorkflow|null,token:number):Promise<ServiceResult<{selection:WorkflowSelection|null;previousSelection:WorkflowSelection|null;activeSkills:string[]}>>=>{
      if(token!==generation)return {ok:false,error:{code:'superseded',message:'Superseded load'}};
      const previousSelection=selection;
      selection=bundle?{workspaceId,workflowId:bundle.id,revision:bundle.revision}:null;
      return {ok:true,value:{selection,previousSelection,activeSkills:[]}};
    }),
    getSelection:()=>selection,getActiveSkills:()=>[],restore:async()=>({ok:true,value:null}),subscribe:()=>()=>undefined
  };
  const read=jest.fn(async()=>result);
  const preparation=new WorkflowPreparationService({preparePrompt:async()=>({ok:true,value:{reference:{type:'prompt',id:'prompt-id'},name:'Review',instructions:'Check sources.',toolSelectors:[],contentHash:'hash'}}),prepareSkills:async()=>({ok:true,value:[]})},{resolve:()=>({ok:true,value:[]})});
  return {params,result,read,activation,preparation,service:new WorkspaceLoadService(read,preparation,activation)};
}

describe('explicit workspace preload versus passive reading',()=>{
  test('read is passive; selected loading prepares then commits canonical IDs and exposes prompt/schema content once',async()=>{
    const state=setup();
    await state.service.read(state.params);
    expect(state.activation.begin).not.toHaveBeenCalled();
    expect(state.activation.commit).not.toHaveBeenCalled();
    const loaded=await state.service.load(state.params);
    expect(loaded.success).toBe(true);
    expect(state.activation.commit).toHaveBeenCalledWith('canonical-session-id','canonical-workspace-id',expect.objectContaining({id:'workflow-id'}),1);
    expect(loaded.data.loadedWorkflow).toMatchObject({id:'workflow-id',prompt:{instructions:'Check sources.'}});
    expect(loaded.data.loadedWorkflow).not.toHaveProperty('preloadedTools');
    expect(loaded.data.prompt).toBeUndefined();
    expect(loaded.data.preloadedTools).toEqual([]);
  });
  test('plain explicit load clears the selection after a successful read',async()=>{
    const state=setup();delete state.params.workflow;
    expect(await state.service.load(state.params)).toMatchObject({success:true,data:{loadedWorkflow:null,workflowActivation:{selection:null,previousSelection:{workflowId:'previous-flow'}}}});
    expect(state.activation.commit).toHaveBeenCalledWith('canonical-session-id','canonical-workspace-id',null,1);
  });
  test('missing dependency and failed read leave the prior selection intact',async()=>{
    const state=setup();state.params.workflow='Unknown';
    expect(await state.service.load(state.params)).toMatchObject({success:false,error:expect.stringContaining('not found')});
    expect(state.activation.commit).not.toHaveBeenCalled();
    state.read.mockResolvedValue({...state.result,success:false,error:'Read failed'});
    expect(await state.service.load(state.params)).toMatchObject({success:false,error:'Read failed'});
    expect(state.activation.getSelection('canonical-session-id')?.workflowId).toBe('previous-flow');
  });
  test('blank explicit workflows and missing canonical sessions fail before reads',async()=>{
    const state=setup();state.params.workflow=' ';
    expect(await state.service.load(state.params)).toMatchObject({success:false});
    state.params.context.sessionId='';
    expect(await state.service.load(state.params)).toMatchObject({success:false});
    expect(state.read).not.toHaveBeenCalled();
  });
  test('generation begins before asynchronous reads so stale loads cannot replace a newer selection',async()=>{
    const state=setup();
    let resolveFirst:(result:LoadWorkspaceResult)=>void=()=>undefined;
    state.read.mockImplementationOnce(()=>new Promise<LoadWorkspaceResult>(resolve=>{resolveFirst=resolve;}));
    const first=state.service.load(state.params);
    const newer=await state.service.load({...state.params,workflow:undefined});
    expect(newer.success).toBe(true);
    resolveFirst(state.result);
    expect(await first).toMatchObject({success:false,error:'Superseded load'});
    expect(state.activation.getSelection('canonical-session-id')).toBeNull();
  });
});
