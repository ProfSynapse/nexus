import { SessionContextManager } from '../../src/services/SessionContextManager';
import { SessionWorkflowService } from '../../src/services/workflows/SessionWorkflowService';
import type { PersistedSessionBindings } from '../../src/services/session/SessionBindingsStore';
import type { PreparedWorkflow } from '../../src/services/instructions/types';

const bundle = (id = 'outline', skill = 'draft'): PreparedWorkflow => ({
  id, name: id, when: 'Write fiction', steps: ['Outline scenes'], revision: `${id}-1`, preloadedTools: [],
  skills: [{ reference: { type: 'skill', provider: 'nexus', name: skill }, name: skill,
    instructions: 'Draft the scene', toolSelectors: [], contentHash: 'hash' }],
});
function setup(initial?: PersistedSessionBindings) {
  let disk = initial ?? { handles: {}, handleWorkspace: {}, cliCurrentSession: null };
  const store = { load: jest.fn(async () => disk), save: jest.fn(async (doc: PersistedSessionBindings) => { disk = structuredClone(doc); }) };
  const sessions = new SessionContextManager(); sessions.setBindingsStore(store);
  const prepare = jest.fn(async () => ({ ok: true as const, value: bundle() }));
  const getWorkspace = jest.fn(async () => ({ context: {} }));
  const recordLoaded = jest.fn(async () => undefined);
  const workflows = new SessionWorkflowService({ sessions, prepare, getWorkspace, recordLoaded });
  return { sessions, workflows, store, prepare, getWorkspace, recordLoaded, disk: () => disk };
}

describe('SessionWorkflowService deliberate selection', () => {
  it('persists selection and binding together, then restores context without stamping recency', async () => {
    const fixture = setup(); const { workflows, sessions, disk } = fixture;
    sessions.addActiveSkill('s-chat', 'codex/review');
    expect((await workflows.commit('s-chat', 'ws-fiction', bundle(), workflows.begin('s-chat', 'ws-fiction'))).ok).toBe(true);
    expect(disk().handleWorkspace['s-chat']).toBe('ws-fiction');
    expect(disk().workflowSelections?.['s-chat']).toEqual({ workspaceId: 'ws-fiction', workflowId: 'outline', revision: 'outline-1' });
    expect(workflows.getActiveSkills('s-chat')).toEqual(['codex/review', 'nexus/draft']);
    const restored = setup(disk()); expect((await restored.workflows.restore('s-chat')).ok).toBe(true);
    expect(restored.workflows.getActiveSkills('s-chat')).toEqual(['nexus/draft']);
    expect(restored.recordLoaded).not.toHaveBeenCalled();
  });
  it('a plain load clears managed skills while preserving individually loaded skills', async () => {
    const { workflows, sessions } = setup(); sessions.addActiveSkill('s-chat', 'nexus/draft');
    await workflows.commit('s-chat', 'ws-fiction', bundle(), workflows.begin('s-chat', 'ws-fiction'));
    await workflows.commit('s-chat', 'ws-other', null, workflows.begin('s-chat', 'ws-other'));
    expect(workflows.getSelection('s-chat')).toBeNull();
    expect(workflows.getActiveSkills('s-chat')).toEqual(['nexus/draft']);
  });
  it('failed persistence leaves selection, workspace binding, and usage unchanged', async () => {
    const { workflows, store, recordLoaded, disk } = setup();
    await workflows.commit('s-chat', 'ws-fiction', bundle(), workflows.begin('s-chat', 'ws-fiction'));
    const before = disk(); recordLoaded.mockClear(); store.save.mockRejectedValueOnce(new Error('Disk full'));
    const result = await workflows.commit('s-chat', 'ws-other', bundle('image', 'paint'), workflows.begin('s-chat', 'ws-other'));
    expect(result).toMatchObject({ ok: false, error: { code: 'persistence' } });
    expect(disk()).toEqual(before); expect(workflows.getSelection('s-chat')?.workflowId).toBe('outline');
    expect(workflows.getActiveSkills('s-chat')).toEqual(['nexus/draft']); expect(recordLoaded).not.toHaveBeenCalled();
  });
  it('rejects an occupied target handle partition before writing or stamping', async () => {
    const { workflows, sessions, store, recordLoaded } = setup({ handles: {
      'default::writer': { id: 's-source', displaySessionId: 'writer', workspaceId: 'default' },
      'ws-fiction::writer': { id: 's-destination', displaySessionId: 'writer', workspaceId: 'ws-fiction' },
    }, handleWorkspace: { writer: 'default' }, cliCurrentSession: null });
    const result = await workflows.commit('s-source', 'ws-fiction', bundle(), workflows.begin('s-source', 'ws-fiction'));
    expect(result).toMatchObject({ ok: false, error: { code: 'ambiguous' } });
    expect(sessions.resolveHandleWorkspace('writer')).toBe('default');
    expect(store.save).not.toHaveBeenCalled(); expect(recordLoaded).not.toHaveBeenCalled();
  });
  it('aliases an empty target partition so subsequent calls keep the activated session', async () => {
    const { workflows, sessions, disk } = setup({ handles: {
      'default::writer': { id: 's-source', displaySessionId: 'writer', workspaceId: 'default' },
    }, handleWorkspace: {}, cliCurrentSession: null });
    expect((await workflows.commit('s-source', 'ws-fiction', bundle(), workflows.begin('s-source', 'ws-fiction'))).ok).toBe(true);
    expect(disk().handles['ws-fiction::writer'].id).toBe('s-source');
    expect((await sessions.validateSessionId('writer', undefined, 'ws-fiction')).id).toBe('s-source');
  });
  it('newer loads win even while an earlier persistence write is pending', async () => {
    const { workflows, store, disk, recordLoaded } = setup();
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    store.save.mockImplementationOnce(async () => { await gate; });
    const old = workflows.commit('s-chat', 'ws-old', bundle(), workflows.begin('s-chat', 'ws-old'));
    while (!store.save.mock.calls.length) await Promise.resolve();
    const latest = workflows.commit('s-chat', 'ws-new', bundle('image', 'paint'), workflows.begin('s-chat', 'ws-new'));
    release(); expect(await old).toMatchObject({ ok: false, error: { code: 'superseded' } });
    expect((await latest).ok).toBe(true); expect(workflows.getSelection('s-chat')?.workspaceId).toBe('ws-new');
    expect(disk().workflowSelections?.['s-chat']?.workflowId).toBe('image'); expect(recordLoaded).toHaveBeenCalledTimes(1);
  });
  it('passive restore reports missing dependencies and does not fall back or clear selection', async () => {
    const { workflows, prepare, sessions } = setup();
    await workflows.commit('s-chat', 'ws-fiction', bundle(), workflows.begin('s-chat', 'ws-fiction'));
    prepare.mockResolvedValueOnce({ ok: false, error: { code: 'archived', message: 'Archived skill' } } as never);
    expect(await workflows.restore('s-chat')).toMatchObject({ ok: false, error: { code: 'archived' } });
    sessions.updateFromResult('s-chat', { success: false, workspaceContext: { workspaceId: 'ws-other' } });
    expect(workflows.getSelection('s-chat')?.workspaceId).toBe('ws-fiction');
  });
});
