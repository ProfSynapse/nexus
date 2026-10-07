import { ButtonComponent, Component, Notice, Setting } from 'obsidian';
import { Settings } from '../../settings';
import { BoxedSection } from '../../settings/components/BoxedSection';
import { InstructionLibraryService } from '../../services/instructions/InstructionLibraryService';
import { deriveCoreSkillsSettings } from '../../services/skills/migrateCoreSkillsSettings';

export function renderSkillSources(container: HTMLElement, library: InstructionLibraryService, settings: Settings, component: Component): void {
  let pendingSave = Promise.resolve();
  new BoxedSection(container, { title: 'Skill sources', unbounded: true, body: body => {
    for (const [key, title, description] of [
      ['automaticImport', 'Automatic provider import', 'Automatically import packages from supported provider folders.'],
      ['syncBackOnEdit', 'Sync edits back', 'Write edits from mirrored packages back to their original folders.']
    ] as const) {
      new Setting(body).setName(title).setDesc(description).addToggle(toggle => {
        toggle.setValue(deriveCoreSkillsSettings(settings.settings.skills)[key]).onChange(async value => {
          pendingSave = pendingSave.then(async () => {
            const before = deriveCoreSkillsSettings(settings.settings.skills);
            settings.settings.skills = { ...before, [key]: value };
            try { await settings.saveSettings(); }
            catch (error) { settings.settings.skills = before; toggle.setValue(before[key]); new Notice(`Source preference was not saved: ${error instanceof Error ? error.message : String(error)}`); }
          });
          await pendingSave;
        });
      });
    }
    body.createEl('p', { text: 'Vault-native skills are indexed automatically. These preferences do not disable core skills.', cls: 'nexus-form-hint' });
    const sync = new ButtonComponent(body).setButtonText('Sync skills now');
    sync.onClick(() => {
      sync.setDisabled(true);
      void library.syncSkills({ direction: 'both' }).then(result => {
        new Notice(result.ok ? 'Skills synced' : result.error.message);
      }).catch(error => new Notice(`Skills were not synced: ${error instanceof Error ? error.message : String(error)}`)).finally(() => sync.setDisabled(false));
    });
  } }, component);
}
