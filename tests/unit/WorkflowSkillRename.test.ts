import { updateWorkflowSkillReferences } from '../../src/services/workflows/updateWorkflowSkillReferences';
import type { IndividualWorkspace } from '../../src/types/storage/StorageTypes';

function setup() {
  const original = { id: 'flow', name: 'Review', when: 'Requested', steps: 'Read evidence', skills: [
    { provider: 'nexus', name: 'review' }, { provider: 'codex', name: 'review' }
  ], tools: ['content read'], promptId: 'p-stable', extension: { retained: true } };
  const rows = new Map<string, IndividualWorkspace>([
    ['ws-one', { id: 'ws-one', name: 'One', created: 1, lastAccessed: 1, sessions: {}, rootFolder: 'One', context: { purpose: 'Research', workflows: [original] } }],
    ['ws-two', { id: 'ws-two', name: 'Two', created: 1, lastAccessed: 1, sessions: {}, rootFolder: 'Two', isArchived: true, context: { workflows: [{ ...original }] } }]
  ]);
  const updateWorkspace = jest.fn(async (id: string, updates: Partial<IndividualWorkspace>) => { rows.set(id, { ...rows.get(id)!, ...updates }); });
  const workspaces = { listWorkspaceDiscovery: async () => [...rows.values()], getWorkspace: async (id: string) => rows.get(id) ?? null, updateWorkspace };
  return { rows, workspaces, updateWorkspace };
}

describe('qualified skill rename references', () => {
  it('updates current and archived workspace attachments while retaining other providers and workflow fields', async () => {
    const { workspaces, rows } = setup();
    expect((await updateWorkflowSkillReferences(workspaces, { provider: 'nexus', name: 'review' }, { provider: 'nexus', name: 'check' })).ok).toBe(true);
    for (const workspace of rows.values()) expect(workspace.context?.workflows?.[0]).toMatchObject({
      skills: [{ provider: 'nexus', name: 'check' }, { provider: 'codex', name: 'review' }],
      tools: ['content read'], promptId: 'p-stable', extension: { retained: true }
    });
    expect(rows.get('ws-one')?.context?.purpose).toBe('Research');
  });
  it('reports partial persistence failure with the new identity and still updates other workspaces', async () => {
    const { workspaces, updateWorkspace, rows } = setup();
    updateWorkspace.mockRejectedValueOnce(new Error('Storage unavailable'));
    expect(await updateWorkflowSkillReferences(workspaces, { provider: 'nexus', name: 'review' }, { provider: 'nexus', name: 'check' })).toMatchObject({
      ok: false, error: { code: 'persistence', message: expect.stringContaining('One: Storage unavailable'), reference: { type: 'skill', provider: 'nexus', name: 'check' } }
    });
    expect(rows.get('ws-two')?.context?.workflows?.[0].skills?.[0].name).toBe('check');
    expect(rows.get('ws-one')?.context?.workflows?.[0].skills?.[0].name).toBe('review');
  });
});
