/** Drafts and partial saves must survive failures; resource paths must not escape a package. */
import { App, ButtonComponent, Component, createMockElement } from 'obsidian';
import { InstructionEditor } from '../../src/components/instructions/InstructionEditor';
import { draftInstruction } from '../../src/components/instructions/InstructionDraft';
import { resolveSkillResourcePath } from '../../src/components/instructions/SkillInstructionEditor';
import { InstructionLibraryService } from '../../src/services/instructions/InstructionLibraryService';
import { InstructionMetadataService } from '../../src/services/instructions/InstructionMetadataService';
import { CustomPromptStorageService } from '../../src/agents/promptManager/services/CustomPromptStorageService';
import type { InstructionLibrarySettings, InstructionSkillPort } from '../../src/services/instructions/types';
import type { Settings } from '../../src/settings';

function setup() {
  let metadata: InstructionLibrarySettings = { version: 1, items: {} };
  let failMetadata = false;
  const promptSettings = { settings: { customPrompts: { enabled: true, prompts: [] } }, saveSettings: jest.fn(async () => undefined) };
  const storage = new CustomPromptStorageService(null, promptSettings as unknown as Settings);
  const skills: InstructionSkillPort = { list: async () => ({ ok: true, value: [] }), prepareMany: async () => ({ ok: true, value: [] }), getDetail: async () => ({ ok: false, error: { code: 'not-found', message: 'Absent' } }) };
  const organization = new InstructionMetadataService({ getSettings: () => metadata, setSettings: next => { metadata = next; }, saveSettings: async () => { if (failMetadata) throw new Error('Disk full'); } });
  const library = new InstructionLibraryService(storage, skills, organization);
  const back = jest.fn();
  const editor = new InstructionEditor(library, new App(), new Component(), 'prompt', back, jest.fn());
  Object.assign(editor.draft, { name: 'Briefing', body: 'Explain the decision.', categories: ['Operations'] });
  editor.dirty = true;
  return { editor, storage, back, fail: (value: boolean) => { failMetadata = value; } };
}

describe('InstructionEditor saves', () => {
  it('retains the created reference and dirty draft after a partial save, then retries without duplication', async () => {
    const state = setup();
    state.fail(true);
    const button = new ButtonComponent(createMockElement('div'));
    await state.editor['save'](button);
    expect(state.storage.getAllPrompts()).toHaveLength(1);
    expect(state.editor.draft.reference).toEqual({ type: 'prompt', id: state.storage.getAllPrompts()[0].id });
    expect(state.editor.dirty).toBe(true);
    expect(state.back).not.toHaveBeenCalled();
    state.fail(false);
    await state.editor['save'](button);
    expect(state.storage.getAllPrompts()).toHaveLength(1);
    expect(state.editor.dirty).toBe(false);
    expect(state.back).toHaveBeenCalledTimes(1);
  });

  it('validates a required name before storing anything', async () => {
    const state = setup();
    state.editor.draft.name = '   ';
    await state.editor['save'](new ButtonComponent(createMockElement('div')));
    expect(state.storage.getAllPrompts()).toHaveLength(0);
    expect(state.back).not.toHaveBeenCalled();
  });

  it('copies mutable category/dependency arrays while preserving qualified skill identity and frontmatter', () => {
    const detail = {
      record: { id: 'cache-id', provider: 'codex', name: 'source-check', description: '', vaultPath: 'CustomRoot/skills/codex/source-check', contentHash: 'hash', isArchived: false, created: 1, updated: 1 },
      reference: { provider: 'codex', name: 'source-check' }, name: 'source-check', description: '', body: 'Read sources.', frontmatter: { allowedTools: ['external-provider-tool'], metadata: { nexus: { tools: ['content read'], custom: true } } }, entrypointPath: 'CustomRoot/skills/codex/source-check/SKILL.md', resourceRoot: 'CustomRoot/skills/codex/source-check', resources: ['SKILL.md'], toolSelectors: ['content read'], contentHash: 'hash', archived: false, declaredCategories: ['Research']
    };
    const categories = ['Research'];
    const draft = draftInstruction({ type: 'skill', detail, categories });
    draft.categories.push('Communication'); draft.toolSelectors.push('task list');
    expect(categories).toEqual(['Research']);
    expect(detail.toolSelectors).toEqual(['content read']);
    expect(draft.reference).toEqual({ type: 'skill', provider: 'codex', name: 'source-check' });
    expect(draft.frontmatter).toEqual(detail.frontmatter);
  });
});

describe('skill resource confinement', () => {
  it('opens nested resources under the actual configured package root', () => {
    expect(resolveSkillResourcePath('CustomRoot/skills/codex/source-check', 'references/a..b.md')).toBe('CustomRoot/skills/codex/source-check/references/a..b.md');
  });
  it.each(['../outside.md', 'references/../../outside.md', '/absolute.md', '~/file.md', 'C:\\outside.md', 'http://external/file.md'])('rejects untrusted resource %s', resource => {
    expect(() => resolveSkillResourcePath('CustomRoot/skills/codex/source-check', resource)).toThrow();
  });
  it('rejects an empty root or resource', () => {
    expect(() => resolveSkillResourcePath('', 'SKILL.md')).toThrow();
    expect(() => resolveSkillResourcePath('CustomRoot/skills/codex/source-check', '')).toThrow();
  });
});
