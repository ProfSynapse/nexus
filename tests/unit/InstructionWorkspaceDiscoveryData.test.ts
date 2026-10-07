/** Discovery must retain workflow context without loading session/state payloads or a cold legacy snapshot. */
import { WorkspaceService } from '../../src/services/WorkspaceService';
import { createMockAdapter, createMockFileSystem, createMockIndexManager, createMockPlugin } from '../helpers/mockFactories';

describe('workspace discovery metadata data source',()=>{
  test('paginates lightweight adapter metadata and preserves stable workflow definitions',async()=>{
    const adapter=createMockAdapter(true);
    const first={id:'ws-1',name:'Research',rootFolder:'Root',created:1,lastAccessed:1,context:{workflows:[{name:'Review',when:'Requested',steps:'Review claims'}]}};
    const second={...first,id:'ws-2',name:'Operations'};
    adapter.getWorkspaces.mockResolvedValueOnce({items:[first],hasNextPage:true}).mockResolvedValueOnce({items:[second],hasNextPage:false});
    const files=createMockFileSystem();
    const service=new WorkspaceService(createMockPlugin(),files as never,createMockIndexManager() as never,adapter);
    const result=await service.listWorkspaceDiscovery();
    expect(result).toHaveLength(2);
    expect(result[0].context?.workflows?.[0]).toMatchObject({name:'Review',id:expect.any(String)});
    expect(adapter.getWorkspaces).toHaveBeenNthCalledWith(2,expect.objectContaining({page:1,pageSize:100}));
    expect(adapter.getSessions).not.toHaveBeenCalled();
    expect(adapter.getTraces).not.toHaveBeenCalled();
    expect(files.readWorkspace).not.toHaveBeenCalled();
    adapter.getWorkspaces.mockResolvedValueOnce({items:[first],hasNextPage:false});
    expect((await service.listWorkspaceDiscovery())[0].context?.workflows?.[0].id).toBe(result[0].context?.workflows?.[0].id);
  });
  test('cold adapter throws unavailable instead of pretending the stale empty legacy index is truth',async()=>{
    const adapter=createMockAdapter(false);
    const index=createMockIndexManager();
    const service=new WorkspaceService(createMockPlugin(),createMockFileSystem() as never,index as never,adapter);
    await expect(service.listWorkspaceDiscovery()).rejects.toThrow('initializing');
    expect(index.loadWorkspaceIndex).not.toHaveBeenCalled();
  });
  test('legacy file projection strips sessions while retaining context definitions',async()=>{
    const files=createMockFileSystem();const index=createMockIndexManager();
    const workspace={id:'legacy-id',name:'Legacy',rootFolder:'Legacy',created:1,lastAccessed:1,context:{workflows:[{id:'flow-id',name:'Review',when:'Requested',steps:'Review'}]},sessions:{'session-id':{memoryTraces:{private:'trace'},states:{private:'state'}}}};
    index.loadWorkspaceIndex.mockResolvedValue({workspaces:{'legacy-id':workspace},byName:{},byDescription:{},byFolder:{}});
    files.readWorkspace.mockResolvedValue(workspace);
    const service=new WorkspaceService(createMockPlugin(),files as never,index as never);
    const result=await service.listWorkspaceDiscovery();
    expect(result[0]).not.toHaveProperty('sessions');
    expect(result[0].context?.workflows?.[0].id).toBe('flow-id');
  });
});
