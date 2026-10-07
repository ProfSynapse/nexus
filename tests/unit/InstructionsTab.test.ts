/** UI filters and archive actions must use qualified references, preserve list state, and protect drafts. */
import { App, Component, DropdownComponent, Setting, ToggleComponent, ButtonComponent, createMockElement } from 'obsidian';
import type { SearchableCardManagerConfig } from '../../src/components/SearchableCardManager';
import type { CardItem } from '../../src/components/CardManager';
import type { InstructionSummary, InstructionSkillMutationPort, InstructionLibrarySettings, SkillDetail } from '../../src/services/instructions/types';

interface TestCard extends CardItem { instruction: InstructionSummary }
const mockConfigs: Array<SearchableCardManagerConfig<TestCard>> = [];
jest.mock('../../src/components/SearchableCardManager', () => ({ SearchableCardManager: class { constructor(config: SearchableCardManagerConfig<TestCard>) { mockConfigs.push(config); } } }));

import { InstructionsTab } from '../../src/settings/tabs/InstructionsTab';
import { SettingsRouter } from '../../src/settings/SettingsRouter';
import { InstructionLibraryService } from '../../src/services/instructions/InstructionLibraryService';
import { InstructionMetadataService } from '../../src/services/instructions/InstructionMetadataService';
import { CustomPromptStorageService } from '../../src/agents/promptManager/services/CustomPromptStorageService';
import { InstructionEditor } from '../../src/components/instructions/InstructionEditor';
import type { Settings } from '../../src/settings';

async function setup() {
  let organization: InstructionLibrarySettings = { version: 1, items: {} };
  let archived = false;
  const settings = { settings: { customPrompts: { enabled: true, prompts: [{ id: 'same-name', name: 'Review', description: 'Prompt content', prompt: 'Review carefully.', isEnabled: true }] } }, saveSettings: jest.fn(async () => undefined) } as unknown as Settings;
  const store = new CustomPromptStorageService(null, settings);
  const record = { id: 'cache-id', provider: 'codex', name: 'Review', description: 'Skill content', vaultPath: 'CustomRoot/skills/codex/Review', contentHash: 'hash', isArchived: false, created: 1, updated: 1, declaredCategories: ['Research'] };
  const detail: SkillDetail = { record, reference: { provider: 'codex', name: 'Review' }, name: 'Review', description: 'Skill content', body: 'Read the sources.', frontmatter: {}, entrypointPath: `${record.vaultPath}/SKILL.md`, resourceRoot: record.vaultPath, resources: ['SKILL.md'], toolSelectors: [], contentHash: 'hash', archived: false, declaredCategories: ['Research'] };
  const metadata = new InstructionMetadataService({ getSettings: () => organization, setSettings: value => { organization = value; }, saveSettings: async () => undefined });
  const port: InstructionSkillMutationPort = {
    list: async () => ({ ok: true, value: [{ ...record, isArchived: archived }] }),
    getDetail: async () => ({ ok: true, value: { ...detail, description: record.description } }), prepareMany: async () => ({ ok: true, value: [] }),
    create: async () => ({ ok: true, value: detail }), update: async (_reference, input) => { record.description = input.description ?? record.description; return { ok: true, value: { ...detail, description: record.description } }; },
    archive: jest.fn(async (reference, value) => { archived = value; await metadata.setArchived(reference, value); return { ok: true, value: { ...record, isArchived: value } }; }),
    sync: async () => ({ ok: true, value: { providers: [], imported: [], syncedBack: [], skipped: [], archived: [] } })
  };
  const library = new InstructionLibraryService(store, port, metadata, port);
  const router = new SettingsRouter(); router.setTab('instructions');
  const tab = new InstructionsTab(createMockElement('div'), router, { app: new App(), settings, getLibrary: async () => library });
  await tab.load();
  return { tab, router, library, port, store };
}
const latest = () => mockConfigs[mockConfigs.length - 1];

describe('InstructionsTab library interactions', () => {
  const dropdowns = new Map<string, (value: string) => void>();
  let settingName = '';
  beforeEach(() => {
    mockConfigs.length = 0; dropdowns.clear();
    jest.spyOn(Setting.prototype, 'setName').mockImplementation(function (name) { settingName = name; return this; });
    jest.spyOn(DropdownComponent.prototype, 'onChange').mockImplementation(function (callback) { dropdowns.set(settingName, callback); return this; });
    jest.spyOn(ToggleComponent.prototype, 'onChange').mockImplementation(function () { return this; });
  });
  afterEach(() => jest.restoreAllMocks());

  it('composes type/category/source filters and retains the search query through refresh', async () => {
    const state = await setup();
    expect(latest().items).toHaveLength(2);
    dropdowns.get('Type')?.('skill');
    dropdowns.get('Category')?.('Research');
    dropdowns.get('Source')?.('codex');
    expect(latest().items?.map(item => item.instruction.reference)).toEqual([{ type: 'skill', provider: 'codex', name: 'Review' }]);
    latest().search?.onQueryChange?.('source');
    await state.tab.load();
    expect(latest().search?.initialQuery).toBe('source');
    expect(latest().items).toHaveLength(1);
    state.tab.destroy();
  });

  it('archives and restores the qualified skill without altering a same-named prompt', async () => {
    const state = await setup();
    const skill = latest().items?.find(item => item.instruction.type === 'skill');
    if (!skill) throw new Error('Expected skill card');
    await state.tab['archive'](skill.instruction);
    expect(state.port.archive).toHaveBeenCalledWith({ type: 'skill', provider: 'codex', name: 'Review' }, true);
    expect(state.store.getAllPrompts()[0].isEnabled).toBe(true);
    const archived = await state.library.list({ includeArchived: true });
    if (!archived.ok) throw new Error('Expected library');
    const record = archived.value.find(item => item.type === 'skill');
    if (!record) throw new Error('Expected archived skill');
    expect(record.availability).toBe('archived');
    await state.tab['archive'](record);
    expect(state.port.archive).toHaveBeenLastCalledWith({ type: 'skill', provider: 'codex', name: 'Review' }, false);
    expect((await state.library.list())).toMatchObject({ ok: true, value: expect.arrayContaining([expect.objectContaining({ type: 'skill', availability: 'available' })]) });
    state.tab.destroy();
  });

  it('refreshes real prompt and skill changes when reentering a clean list without resetting filters', async () => {
    const state = await setup();
    latest().search?.onQueryChange?.('review');
    dropdowns.get('Category')?.('Research');
    state.router.setTab('workspaces');
    await state.store.createPrompt({ name: 'New briefing', description: 'Created outside settings', prompt: 'Summarize.', isEnabled: true });
    await state.library.update({ type: 'skill', provider: 'codex', name: 'Review' }, { description: 'Changed by provider sync' });
    state.router.setTab('instructions');
    const reload = jest.spyOn(state.tab, 'load');
    state.tab.show(createMockElement('div'));
    await reload.mock.results[0].value;
    expect(latest().search?.initialQuery).toBe('review');
    expect(latest().items?.map(item => item.name)).toEqual(['Review']);
    expect(latest().items?.[0].description).toBe('Changed by provider sync');
    dropdowns.get('Category')?.('');
    expect(latest().items?.map(item => item.name)).toContain('New briefing');
    state.tab.destroy();
  });

  it('retains explicit prior identity through a failed rename so save retry repairs attachments', async () => {
    const state = await setup();
    const original = { type: 'skill' as const, provider: 'codex', name: 'Review' };
    const current = { type: 'skill' as const, provider: 'codex', name: 'Draft' };
    const detail = await state.library.getDetail(original);
    if (!detail.ok) throw new Error('Expected skill details');
    const update = jest.spyOn(state.port, 'update');
    update.mockResolvedValueOnce({ ok: false, error: { code: 'persistence', message: 'Skill renamed, attachments failed', reference: current, repairReferencesFrom: original } });
    const editor = new InstructionEditor(state.library, new App(), new Component(), detail.value, jest.fn(), jest.fn());
    editor.draft.name = 'Draft'; editor.dirty = true;
    const button = new ButtonComponent(createMockElement('div'));
    await editor['save'](button);
    expect(editor.draft.reference).toEqual(current); expect(editor.draft.repairReferencesFrom).toEqual(original); expect(editor.dirty).toBe(true);
    await editor['save'](button);
    expect(update).toHaveBeenLastCalledWith(current, expect.objectContaining({ rename: 'Draft', repairReferencesFrom: original }));
    expect(editor.draft.repairReferencesFrom).toBeUndefined(); expect(editor.dirty).toBe(false);
    state.tab.destroy();
  });
  it('blocks tab navigation with a dirty instruction and releases the guard on disposal', async () => {
    const state = await setup();
    const editor = new InstructionEditor(state.library, new App(), new Component(), 'prompt', jest.fn(), jest.fn());
    editor.dirty = true;
    state.tab['editor'] = editor;
    state.router.setTab('workspaces');
    state.tab.show(createMockElement('div'));
    expect(state.tab['editor']).toBe(editor);
    expect(editor.dirty).toBe(true);
    expect(state.router.getState().tab).toBe('instructions');
    state.tab.destroy(); state.router.setTab('workspaces');
    expect(state.router.getState().tab).toBe('workspaces');
  });
});
