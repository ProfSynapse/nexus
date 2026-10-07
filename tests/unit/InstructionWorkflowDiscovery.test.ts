/** Live nested workflows must refresh under an unchanged workspace name; timeouts are not empty truth. */
import { GetToolsTool } from '../../src/agents/toolManager/tools/getTools';
import { BaseAgent } from '../../src/agents/baseAgent';
import type { ITool } from '../../src/agents/interfaces/ITool';
import { WorkspaceSummaryService } from '../../src/services/workspace/WorkspaceSummaryService';
import type { ProjectWorkspace } from '../../src/database/types/workspace/WorkspaceTypes';

class DiscoveryAgent extends BaseAgent {
  constructor(){super('memoryManager','Memory','1');this.registerTool({slug:'loadWorkspace',name:'Load',description:'Preload',version:'1',execute:async()=>({success:true}),getParameterSchema:()=>({type:'object',properties:{workspace:{type:'string'},workflow:{type:'string'}},required:['workspace']}),getResultSchema:()=>({type:'object'})} as ITool);}
}
describe('nested workflow discovery',()=>{
  test('shows workflow choices with canonical IDs and heals details after a workflow-only edit',async()=>{
    const workspace:ProjectWorkspace={id:'ws-id',name:'Same name',created:1,lastAccessed:1,rootFolder:'Root',context:{workflows:[{id:'flow-id',name:'Research',when:'Requested',steps:'No discovery body'}]}};
    const summary=new WorkspaceSummaryService();
    const provider=jest.fn(async()=>[summary.summarize(workspace)]);
    const tool=new GetToolsTool(new Map([['memoryManager',new DiscoveryAgent()]]),{workspaces:[],customAgents:[],vaultRoot:[]},provider);
    const first=await tool.execute({tool:'memory load-workspace'});
    expect(first.data?.workspaceDetails?.[0].workflows[0]).toMatchObject({id:'flow-id',name:'Research',loadCommand:'memory load-workspace "ws-id" --workflow "flow-id"'});
    expect(first.data?.tools[0].arguments?.some(arg=>arg.name==='workflow')).toBe(true);
    workspace.context!.workflows![0].name='Updated';
    tool.invalidateWorkspaceCache();
    const second=await tool.execute({tool:'memory'});
    expect(second.data?.workspaceDetails?.[0].workflows[0].name).toBe('Updated');
    expect(tool.description).toContain('"Updated" (id "flow-id")');
    expect(tool.description).not.toContain('"Research" (id "flow-id")');
    expect(JSON.stringify(second)).not.toContain('No discovery body');
  });
  test('failed live provider keeps cached choices but explicitly denies completeness',async()=>{
    const tool=new GetToolsTool(new Map([['memoryManager',new DiscoveryAgent()]]),{workspaces:[{name:'Snapshot'}],customAgents:[],vaultRoot:[]},async()=>{throw new Error('Still rebuilding');});
    const result=await tool.execute({tool:'memory'});
    expect(result.data?.workspaces).toEqual(['default','Snapshot']);
    expect(result.data?.workspaceStatus).toBe('unavailable');
    expect(result.data?.workspacesNote).toContain('may be incomplete');
    expect(result.data?.workspacesNote).not.toContain('only workspaces');
  });
});
