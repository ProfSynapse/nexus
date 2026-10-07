/** Real discovery → CLI normalization → activation → inherited execution must keep one session and choice. */
import type { App } from 'obsidian';
import { BaseAgent } from '../../src/agents/baseAgent';
import { MemoryManagerAgent } from '../../src/agents/memoryManager/memoryManager';
import { ToolManagerAgent } from '../../src/agents/toolManager/toolManager';
import { ToolCatalogService } from '../../src/agents/toolManager/services/ToolCatalogService';
import { CustomPromptStorageService } from '../../src/agents/promptManager/services/CustomPromptStorageService';
import { InstructionLibraryService } from '../../src/services/instructions/InstructionLibraryService';
import { InstructionMetadataService } from '../../src/services/instructions/InstructionMetadataService';
import { WorkflowPreparationService } from '../../src/services/workflows/WorkflowPreparationService';
import { SessionWorkflowService } from '../../src/services/workflows/SessionWorkflowService';
import { WorkspaceSummaryService } from '../../src/services/workspace/WorkspaceSummaryService';
import { ToolExecutionStrategy } from '../../src/handlers/strategies/ToolExecutionStrategy';
import type { InstructionSkillPort, InstructionLibrarySettings } from '../../src/services/instructions/types';
import type { CustomPrompt } from '../../src/types';
import type { Settings } from '../../src/settings';
import type { ProjectWorkspace } from '../../src/database/types/workspace/WorkspaceTypes';
import { makeManager, makeDeps, MemoryBindingsStore, getToolsRequest, useToolsRequest, type Captured } from './helpers/sessionStickyFixtures';

class FixtureContentAgent extends BaseAgent {
  readonly read = jest.fn(async (params: Record<string, unknown>) => ({success:true,data:{observedContext:params.context,path:params.path}}));
  constructor(){super('contentManager','Content','1');this.registerTool({slug:'read',name:'Read',description:'Read a note',version:'1',execute:this.read,getParameterSchema:()=>({type:'object',properties:{path:{type:'string'},startLine:{type:'number'}},required:['path','startLine']}),getResultSchema:()=>({type:'object'})});}
}

function setup(){
  const store=new MemoryBindingsStore();
  const {manager:sessions,sessionService}=makeManager({store});
  const workspace:ProjectWorkspace={id:'ws-blog-id',name:'Blog',rootFolder:'Blog',created:1,lastAccessed:1,context:{purpose:'Review published information',workflows:[{id:'flow-review',name:'Review evidence',when:'Before publishing',steps:'Check claims.',promptId:'prompt-review',skills:[{provider:'nexus',name:'source-review'}],tools:['content read']}]}};
  const research:ProjectWorkspace={...workspace,id:'ws-research-id',name:'Research',rootFolder:'Research',context:{}};
  const workspaces=[workspace,research];
  const workspaceService={
    listWorkspaces:jest.fn(async()=>workspaces.map(item=>({...item,sessionCount:0,traceCount:0}))),
    listWorkspaceDiscovery:jest.fn(async()=>workspaces),
    getWorkspaceByNameOrId:jest.fn(async(identifier:string)=>workspaces.find(item=>item.id===identifier||item.name.toLowerCase()===identifier.toLowerCase())??null),
    getWorkspace:jest.fn(async(id:string)=>workspaces.find(item=>item.id===id)??null),
    isSystemWorkspaceId:()=>false,updateLastAccessed:jest.fn(async()=>undefined)
  };
  sessions.setWorkspaceResolver(workspaceService);
  const prompt:CustomPrompt={id:'prompt-review',name:'Claim reviewer',description:'Review evidence',prompt:'Distinguish claims and evidence.',isEnabled:true};
  const prompts=new CustomPromptStorageService(null,{settings:{customPrompts:{enabled:true,prompts:[prompt]}},saveSettings:async()=>undefined} as unknown as Settings);
  let metadata:InstructionLibrarySettings={version:1,items:{}};
  const organization=new InstructionMetadataService({getSettings:()=>metadata,setSettings:value=>{metadata=value;},saveSettings:async()=>undefined});
  const skills:InstructionSkillPort={list:async()=>({ok:true,value:[]}),getDetail:async()=>({ok:false,error:{code:'not-found',message:'Not needed for prep'}}),prepareMany:async refs=>({ok:true,value:refs.map(ref=>({reference:{type:'skill',...ref},name:ref.name,instructions:'Read sources before writing.',toolSelectors:['content read'],contentHash:'skill-content',resourceRoot:'Configured/skills/nexus/source-review',resources:['SKILL.md']}))})};
  const library=new InstructionLibraryService(prompts,skills,organization);
  const content=new FixtureContentAgent();
  const registry=new Map<string,BaseAgent>();
  const catalog=new ToolCatalogService(()=>registry);
  const preparation=new WorkflowPreparationService(library,catalog);
  const recordLoaded=jest.fn(async()=>undefined);
  const workflows=new SessionWorkflowService({sessions,getWorkspace:workspaceService.getWorkspace,prepare:(target,id)=>preparation.prepare(target,id),recordLoaded});
  const run=jest.fn(async()=>{throw new Error('A preload must not run an LLM workflow');});
  const plugin={services:{workspaceService},getService:async(name:string)=>name==='sessionContextManager'?sessions:name==='workflowRunService'?{start:run}:null,getServiceIfReady:()=>null};
  const app={vault:{getName:()=>'Protocol test',getAbstractFileByPath:()=>null},plugins:{getPlugin:()=>plugin}} as unknown as App;
  const emptyPage={items:[],page:0,pageSize:5,totalItems:0,totalPages:0,hasNextPage:false,hasPreviousPage:false};
  const memoryService={getMemoryTraces:jest.fn(async()=>emptyPage),getSessions:jest.fn(async()=>emptyPage),getStates:jest.fn(async()=>emptyPage)};
  const memory=new MemoryManagerAgent(app,plugin as never,memoryService as never,workspaceService as never,prompts);
  memory.setWorkflowServices(preparation,workflows);
  registry.set('memoryManager',memory);registry.set('contentManager',content);
  const summary=new WorkspaceSummaryService();
  const tools=new ToolManagerAgent(app,registry,{workspaces:[],customAgents:[],vaultRoot:[]},async()=>summary.summarizeMany(workspaces));
  const captured:Captured={};
  const strategy=new ToolExecutionStrategy(makeDeps(captured),()=>tools,sessions);
  return {sessions,sessionService,store,workspace,prompt,content,workflows,recordLoaded,run,strategy,captured};
}

describe('workflow preload through the real two-tool protocol',()=>{
  test('discovered command loads the bundle and the next inherited call keeps the canonical session and workflow',async()=>{
    const state=setup();
    await state.strategy.handle(getToolsRequest({tool:'memory load-workspace'}));
    const discovery=state.captured.result as unknown as {data:{workspaceDetails:Array<{workflows:Array<{loadCommand:string}>}>}};
    const command=discovery.data.workspaceDetails[0].workflows[0].loadCommand;
    const discoveredSession=state.captured.sessionInfo?.sessionId;
    await state.strategy.handle(useToolsRequest({tool:command}));
    expect(state.captured.result?.success).toBe(true);
    const loadedSession=state.captured.sessionInfo?.sessionId;
    expect(loadedSession).toBe(discoveredSession);
    expect(state.workflows.getSelection(loadedSession!)).toMatchObject({workspaceId:'ws-blog-id',workflowId:'flow-review'});
    expect(state.workflows.getActiveSkills(loadedSession!)).toEqual(['nexus/source-review']);
    const payload=state.captured.result as unknown as {preloadedTools:Array<{usage:string}>;loadedWorkflow:{prompt:{instructions:string}}};
    expect(payload.preloadedTools[0].usage).toContain('content read');
    expect(payload.loadedWorkflow.prompt.instructions).toBe('Distinguish claims and evidence.');
    await state.strategy.handle(useToolsRequest({tool:'content read --path Blog/sources.md --start-line 1'}));
    expect(state.captured.result?.success).toBe(true);
    expect(state.captured.sessionInfo?.sessionId).toBe(loadedSession);
    expect(state.content.read.mock.calls[0][0]).toMatchObject({sessionId:loadedSession,workspaceId:'ws-blog-id'});
    expect(state.sessionService.createSession).toHaveBeenCalledTimes(1);
    expect(state.workflows.getSelection(loadedSession!)?.workflowId).toBe('flow-review');
    expect(state.recordLoaded).toHaveBeenCalledTimes(1);
    expect(state.run).not.toHaveBeenCalled();
  });
  test('failed preparation preserves the prior committed selection and stamps no usage',async()=>{
    const state=setup();
    await state.strategy.handle(useToolsRequest({tool:'memory load-workspace Blog --workflow flow-review'}));
    const id=state.captured.sessionInfo!.sessionId;
    const before=state.workflows.getSelection(id);
    const commit=jest.spyOn(state.workflows,'commit');
    state.prompt.isEnabled=false;
    await state.strategy.handle(useToolsRequest({tool:'memory load-workspace Blog --workflow flow-review'}));
    expect(state.captured.result?.success).toBe(false);
    expect(state.captured.result?.error).toContain('archived');
    expect(commit).not.toHaveBeenCalled();
    expect(state.workflows.getSelection(id)).toEqual(before);
    expect(state.recordLoaded).toHaveBeenCalledTimes(1);
    expect(state.run).not.toHaveBeenCalled();
  });
  test('successful search auto-load marker wins over a conflicting envelope when target matches the prior binding',async()=>{
    const state=setup();
    await state.strategy.handle(useToolsRequest({tool:'memory load-workspace Blog --workflow flow-review'}));
    const id=state.captured.sessionInfo!.sessionId;
    expect(state.sessions.resolveHandleWorkspace(id)).toBe('ws-blog-id');
    // Use the existing canonical ID so an explicit envelope does not manufacture
    // another friendly-handle session partition before the search chooses Blog.
    await state.strategy.handle(useToolsRequest({sessionId:id,workspaceId:'Research',tool:'memory search-workspaces Blog --load'}));
    expect(state.captured.result?.success).toBe(true);
    expect(state.captured.result).toMatchObject({autoLoaded:true,workspace:{success:true,data:{workflowActivation:{workspaceId:'ws-blog-id',selection:null}}}});
    expect(state.sessions.resolveHandleWorkspace(id)).toBe('ws-blog-id');
    expect(state.sessions.resolveHandleWorkspace('nexus-cli')).toBe('ws-blog-id');
    expect(state.workflows.getSelection(id)).toBeNull();
    expect(state.workflows.getActiveSkills(id)).toEqual([]);
    expect(state.run).not.toHaveBeenCalled();
  });
});
