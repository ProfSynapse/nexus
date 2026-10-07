/** Sequential preferences must not roll one successful change back when another save fails. */
import { Component, Setting, ToggleComponent, createMockElement } from 'obsidian';
import { renderSkillSources } from '../../src/components/instructions/SkillSourcesRenderer';
import { InstructionLibraryService } from '../../src/services/instructions/InstructionLibraryService';
import { InstructionMetadataService } from '../../src/services/instructions/InstructionMetadataService';
import { CustomPromptStorageService } from '../../src/agents/promptManager/services/CustomPromptStorageService';
import type { CoreSkillsSettings, InstructionLibrarySettings, InstructionSkillPort } from '../../src/services/instructions/types';
import type { Settings } from '../../src/settings';

it('keeps the next source preference after an earlier save fails', async () => {
  const callbacks = new Map<string, (value: boolean) => void>();
  let name = '';
  const nameSpy = jest.spyOn(Setting.prototype, 'setName').mockImplementation(function (value) { name = value; return this; });
  const toggleSpy = jest.spyOn(ToggleComponent.prototype, 'onChange').mockImplementation(function (callback) { callbacks.set(name, callback); return this; });
  let organization: InstructionLibrarySettings = { version: 1, items: {} };
  const snapshots: CoreSkillsSettings[] = [];
  const state = { settings: { skills: { version: 1 as const, automaticImport: true, syncBackOnEdit: true }, customPrompts: { enabled: true, prompts: [] } }, saveSettings: jest.fn(async () => { snapshots.push({ ...state.settings.skills }); if (snapshots.length === 1) throw new Error('First save failed'); }) };
  const settings = state as unknown as Settings;
  const port: InstructionSkillPort = { list: async () => ({ ok: true, value: [] }), getDetail: async () => ({ ok: false, error: { code: 'not-found', message: 'Unused' } }), prepareMany: async () => ({ ok: true, value: [] }) };
  const metadata = new InstructionMetadataService({ getSettings: () => organization, setSettings: value => { organization = value; }, saveSettings: async () => undefined });
  const library = new InstructionLibraryService(new CustomPromptStorageService(null, settings), port, metadata);
  try {
    renderSkillSources(createMockElement('div'), library, settings, new Component());
    await Promise.all([callbacks.get('Automatic provider import')?.(false), callbacks.get('Sync edits back')?.(false)]);
    expect(snapshots).toMatchObject([{ version: 1, automaticImport: false, syncBackOnEdit: true }, { version: 1, automaticImport: true, syncBackOnEdit: false }]);
    expect(state.settings.skills).toMatchObject({ version: 1, automaticImport: true, syncBackOnEdit: false });
  } finally { nameSpy.mockRestore(); toggleSpy.mockRestore(); }
});
