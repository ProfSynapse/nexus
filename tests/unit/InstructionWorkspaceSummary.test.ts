/** Discovery must retain workflow changes under unchanged workspace names and inert quoted literals. */
import { tokenize } from '../../src/agents/toolManager/services/ToolCliNormalizer';
import { WorkspaceSummaryService,quoteWorkflowCliLiteral } from '../../src/services/workspace/WorkspaceSummaryService';
import type { ProjectWorkspace } from '../../src/database/types/workspace/WorkspaceTypes';
import type { LoadWorkspaceResult } from '../../src/database/types/workspace/ParameterTypes';
import { safeStringify } from '../../src/utils/jsonUtils';

describe('workspace workflow discovery',()=>{
  test.each(['quotes "double" and \'single\'','comma, separator','multi\nline','$(touch /tmp/example) `echo hello` $HOME','C:\\temp\\notes'])('roundtrips quoted CLI literal: %s',name=>{
    expect(tokenize(quoteWorkflowCliLiteral(name))).toEqual([name]);
  });
  test('bounds metadata summaries and makes the full list available for specific load',()=>{
    const workspace:ProjectWorkspace={id:'workspace-id',name:'Arbitrary research',rootFolder:'Research',created:1,lastAccessed:1,context:{purpose:'Purpose '.repeat(100),workflows:Array.from({length:10},(_,i)=>({id:`flow-${i}`,name:`Workflow ${i}`,when:'Requested',steps:'Must never appear in discovery',skills:Array.from({length:10},(_,j)=>({provider:'nexus',name:`package-${j}`}))}))}};
    const service=new WorkspaceSummaryService();
    const summary=service.summarize(workspace);
    expect(summary.workflows).toHaveLength(8);
    expect(summary).toMatchObject({workflowCount:10,workflowsTruncated:true});
    expect(summary.workflows[0]).toMatchObject({skillCount:10,skillsTruncated:true});
    expect(summary.workflows[0].skills).toHaveLength(8);
    expect(JSON.stringify(summary)).not.toContain('Must never appear');
    expect(service.summarize(workspace,true).workflows).toHaveLength(10);
    const previous=JSON.stringify(summary);
    workspace.context!.workflows![0].name='Changed workflow';
    expect(JSON.stringify(service.summarize(workspace))).not.toBe(previous);
  });
  test('loading commands preserve exact unusual workflow names and canonical workspace ID',()=>{
    const name='Research, "claims"\nwith $dollars and `backticks`';
    const workspace:ProjectWorkspace={id:'stable-workspace-id',name:'Display name',rootFolder:'Research',created:1,lastAccessed:1,context:{workflows:[{id:'workflow-id',name,when:'Requested',steps:''}]}};
    expect(tokenize(new WorkspaceSummaryService().summarize(workspace).workflows[0].loadCommand)).toEqual(['memory','load-workspace','stable-workspace-id','--workflow','workflow-id']);
  });
  test.each([false, true])('full load serialization preserves repeated qualified skill references (full summaries: %s)',fullWorkflows=>{
    const reference={provider:'nexus',name:'evidence-review'};
    const definitions=['review','verify'].map(id=>({id,name:id,when:'Requested',steps:'Check evidence',skills:[{...reference}]}));
    const workspace:ProjectWorkspace={id:'ws-research',name:'Research',rootFolder:'Research',created:1,lastAccessed:1,context:{workflows:definitions}};
    const availableWorkflows=new WorkspaceSummaryService().summarize(workspace,fullWorkflows).workflows;
    const result:LoadWorkspaceResult={success:true,workspaceContext:{workspaceId:workspace.id},data:{context:{name:workspace.name,rootFolder:workspace.rootFolder,recentActivity:[]},workflows:[],workflowDefinitions:definitions,availableWorkflows,workspaceStructure:[],recentFiles:[],keyFiles:{},preferences:'',sessions:[],states:[]}};
    const serialized=safeStringify(result);
    expect(serialized).not.toContain('[Circular Reference]');
    const decoded:LoadWorkspaceResult=JSON.parse(serialized);
    expect(decoded.data.availableWorkflows?.map(workflow=>workflow.skills)).toEqual([[reference],[reference]]);
    expect(decoded.data.workflowDefinitions?.map(workflow=>workflow.skills)).toEqual([[reference],[reference]]);
    expect(availableWorkflows[0].skills[0]).not.toBe(definitions[0].skills[0]);
  });
});
