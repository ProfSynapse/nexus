/** Strict prompt lookup must fail on ambiguity/disabled content rather than load a substitute. */
import { InstructionLibraryService } from '../../src/services/instructions/InstructionLibraryService';
import { InstructionMetadataService } from '../../src/services/instructions/InstructionMetadataService';
import type { CustomPrompt } from '../../src/types';
import type { InstructionLibrarySettings, InstructionSkillMutationPort, InstructionSkillPort, SkillDetail } from '../../src/services/instructions/types';
import { CustomPromptStorageService } from '../../src/agents/promptManager/services/CustomPromptStorageService';
import type { Settings } from '../../src/settings';

function setup() {
  let metadata: InstructionLibrarySettings = { version: 1, items: {} };
  const prompts: CustomPrompt[] = [
    { id: 'primary-id', name: 'Review', description: 'Examine sources', prompt: 'Review each claim.', isEnabled: true },
    { id: 'disabled-id', name: 'Archived', description: '', prompt: 'Do not load.', isEnabled: false }
  ];
  const promptSettings = { settings: { customPrompts: { enabled: true, prompts } }, saveSettings: jest.fn(async () => undefined) };
  const store = new CustomPromptStorageService(null, promptSettings as unknown as Settings);
  const record = { id: 'cache-id', provider: 'nexus', name: 'meeting-notes', description: 'Summarize decisions', vaultPath: 'UserRoot/skills/nexus/meeting-notes', contentHash: 'abc', isArchived: false, created: 1, updated: 1, declaredCategories: ['Operations'] };
  const detail: SkillDetail = { record, reference: { provider: 'nexus', name: 'meeting-notes' }, name: record.name, description: record.description, body: 'Capture decisions', frontmatter: {}, entrypointPath: `${record.vaultPath}/SKILL.md`, resourceRoot: record.vaultPath, resources: ['SKILL.md', 'references/checklist.md'], toolSelectors: ['content read'], contentHash: 'abc', archived: false, declaredCategories: ['Operations'] };
  const port: InstructionSkillPort = {
    list: jest.fn(async () => ({ ok: true, value: [record] })),
    getDetail: jest.fn(async () => ({ ok: true, value: detail })),
    prepareMany: jest.fn(async references => ({ ok: true, value: references.map(ref => ({ reference: { type: 'skill', ...ref }, name: ref.name, instructions: detail.body, resources: detail.resources, toolSelectors: detail.toolSelectors, contentHash: 'abc' })) }))
  };
  const organization = new InstructionMetadataService({ getSettings: () => metadata, setSettings: next => { metadata = next; }, saveSettings: async () => undefined });
  return { library: new InstructionLibraryService(store, port, organization), store, prompts, organization, port, promptSettings, detail };
}

describe('instruction library projection', () => {
  test('preserves IDs/body and resolves full names case-insensitively without fallback from a missing ID', async () => {
    const state = setup();
    expect(await state.library.preparePrompt(undefined, 'review')).toMatchObject({ ok: true, value: { reference: { type: 'prompt', id: 'primary-id' }, instructions: 'Review each claim.' } });
    expect(await state.library.preparePrompt('missing', 'Review')).toMatchObject({ ok: false, error: { code: 'not-found' } });
    expect(await state.library.preparePrompt(undefined, 'Rev')).toMatchObject({ ok: false });
    state.prompts.push({ ...state.prompts[0], id: 'second-id', name: 'REVIEW' });
    expect(await state.library.preparePrompt(undefined, 'Review')).toMatchObject({ ok: false, error: { code: 'ambiguous' } });
    expect(await state.library.preparePrompt('primary-id')).toMatchObject({ ok: true });
    expect(await state.library.preparePrompt('disabled-id')).toMatchObject({ ok: false, error: { code: 'archived' } });
  });

  test('filters arbitrary type/category/source/search, with explicit empty user override', async () => {
    const state = setup();
    expect(await state.library.list({ category: 'Operations' })).toMatchObject({ ok: true, value: [{ type: 'skill', source: 'nexus', name: 'meeting-notes' }] });
    expect(await state.library.list({ type: 'prompt', source: 'native', search: 'sources' })).toMatchObject({ ok: true, value: [{ name: 'Review' }] });
    expect(await state.library.list({ availability: 'archived' })).toMatchObject({ ok: true, value: [{ name: 'Archived' }] });
    expect(state.port.getDetail).not.toHaveBeenCalled();
    await state.organization.setCategories({ type: 'skill', provider: 'nexus', name: 'meeting-notes' }, []);
    expect(await state.library.list({ category: 'Operations' })).toEqual({ ok: true, value: [] });
  });

  test('archive delegates to real prompt authority and preparation remains read-only', async () => {
    const state = setup();
    expect(await state.library.archive({ type: 'prompt', id: 'primary-id' })).toMatchObject({ ok: true });
    expect(state.store.getAllPrompts()[0].isEnabled).toBe(false);
    expect(await state.library.preparePrompt('primary-id')).toMatchObject({ ok: false, error: { code: 'archived' } });
    const refs = [{ provider: 'nexus', name: 'meeting-notes' }];
    expect(await state.library.prepareSkills(refs)).toMatchObject({ ok: true, value: [{ toolSelectors: ['content read'] }] });
    expect(state.port.prepareMany).toHaveBeenCalledWith(refs);
    expect(state.promptSettings.saveSettings).toHaveBeenCalledTimes(1);
  });

  test('creates and edits through the existing prompt store, retaining IDs', async () => {
    const state = setup();
    const created = await state.library.create({ type: 'prompt', name: 'Checklist', description: 'Review safety', body: 'Check each item.', categories: ['Safety'] });
    expect(created.ok).toBe(true);
    if (!created.ok || created.value.type !== 'prompt') throw new Error('Expected created prompt');
    const ref = created.value.reference;
    expect(await state.library.update(ref, { body: 'Updated.', categories: [] })).toMatchObject({ ok: true, value: { reference: ref, body: 'Updated.', categories: [] } });
    expect(state.store.getAllPrompts().find(prompt => prompt.id === ref.id)?.prompt).toBe('Updated.');
  });

  test('reports skills initializing rather than returning an authoritative empty all-types library', async () => {
    const state = setup();
    jest.mocked(state.port.list).mockResolvedValue({ ok: false, error: { code: 'initializing', message: 'Skills preparing' } });
    expect(await state.library.list()).toMatchObject({ ok: false, error: { code: 'initializing' } });
    expect(await state.library.list({ type: 'prompt' })).toMatchObject({ ok: true, value: [{ name: 'Review' }] });
  });

  test.each(['create', 'update'] as const)('retains the durable skill identity when %s succeeds but detail reload fails', async action => {
    const state = setup();
    const savedReference = { type: 'skill' as const, provider: 'nexus', name: 'saved-notes' };
    const savedDetail = { ...state.detail, reference: { provider: savedReference.provider, name: savedReference.name } };
    const mutations: InstructionSkillMutationPort = {
      ...state.port,
      create: jest.fn(async () => ({ ok: true, value: savedDetail })),
      update: jest.fn(async () => ({ ok: true, value: savedDetail })),
      archive: async () => ({ ok: true, value: state.detail.record }),
      sync: async () => ({ ok: true, value: { providers: [], imported: [], syncedBack: [], skipped: [], archived: [] } })
    };
    const library = new InstructionLibraryService(state.store, state.port, state.organization, mutations);
    jest.mocked(state.port.getDetail).mockResolvedValueOnce({ ok: false, error: { code: 'initializing', message: 'Skill cache is rebuilding' } });
    const result = action === 'create'
      ? await library.create({ type: 'skill', name: savedReference.name, description: '', body: 'Saved body', categories: ['Operations'] })
      : await library.update({ type: 'skill', provider: 'nexus', name: 'meeting-notes' }, { name: savedReference.name, categories: ['Operations'] });
    expect(result).toMatchObject({ ok: false, error: { code: 'initializing', reference: savedReference, message: expect.stringContaining(`Instruction was ${action === 'create' ? 'created' : 'updated'}`) } });
    expect(state.organization.categories(savedReference)).toEqual(['Operations']);
    expect(state.port.getDetail).toHaveBeenCalledWith(savedReference);
    expect(mutations[action]).toHaveBeenCalledTimes(1);
  });

  test('handles a rejected post-create detail read without losing the saved identity', async () => {
    const state = setup();
    const mutations: InstructionSkillMutationPort = {
      ...state.port,
      create: async () => ({ ok: true, value: state.detail }),
      update: async () => ({ ok: true, value: state.detail }),
      archive: async () => ({ ok: true, value: state.detail.record }),
      sync: async () => ({ ok: true, value: { providers: [], imported: [], syncedBack: [], skipped: [], archived: [] } })
    };
    const library = new InstructionLibraryService(state.store, state.port, state.organization, mutations);
    jest.mocked(state.port.getDetail).mockRejectedValueOnce(new Error('Read interrupted'));
    await expect(library.create({ type: 'skill', name: 'meeting-notes', description: '' })).resolves.toMatchObject({
      ok: false, error: { reference: { type: 'skill', provider: 'nexus', name: 'meeting-notes' }, message: expect.stringContaining('Instruction was created') }
    });
  });
});
