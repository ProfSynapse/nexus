import { App, ButtonComponent, Component, Notice, Setting } from 'obsidian';
import { BoxedSection } from '../../settings/components/BoxedSection';
import { resolveVaultPath, type VaultPath } from '../../core/vaultPath';
import type { SkillDetail } from '../../services/instructions/types';
import type { InstructionDraft } from './InstructionDraft';

/** Reject traversal/absolute resource references before app navigation can reach them. */
export function resolveSkillResourcePath(root: string, resource: string): VaultPath {
  if (resource.trim().startsWith('/')) throw new Error('Skill resources must use a package-relative path.');
  const safeRoot = resolveVaultPath(root);
  const relative = resolveVaultPath(resource);
  const path = resolveVaultPath(`${safeRoot}/${relative}`);
  if (!safeRoot || !relative || !path.startsWith(`${safeRoot}/`)) throw new Error('Resource must remain inside the skill folder.');
  return path;
}

export function renderSkillInstructions(container: HTMLElement, draft: InstructionDraft, component: Component, changed: () => void): void {
  new BoxedSection(container, { title: 'SKILL.md', unbounded: true, body: body => {
    new Setting(body).setName('Instructions').setDesc('The skill entry point. Other frontmatter is preserved when saving.').addTextArea(text => {
      text.setValue(draft.body).onChange(value => { draft.body = value; changed(); });
      text.inputEl.rows = 8;
      text.inputEl.setAttribute('aria-label', 'Skill instructions');
    });
  } }, component);
  new BoxedSection(container, { title: 'Required tools', unbounded: true, body: body => {
    new Setting(body).setName('Required tools').setDesc('Comma-separated agent or agent/tool selectors. These schemas preload with the skill.').addText(text => {
      text.setValue(draft.toolSelectors.join(', ')).setPlaceholder('Agent tool, agent tool').onChange(value => {
        draft.toolSelectors = value.split(',').map(item => item.trim()).filter(Boolean); changed();
      });
      text.inputEl.setAttribute('aria-label', 'Required tool selectors');
    });
  } }, component);
}

export function renderSkillResources(container: HTMLElement, detail: SkillDetail, app: App, component: Component, manageSources: () => void): void {
  new BoxedSection(container, { title: 'Resource files', unbounded: true, body: body => {
    body.createEl('p', { text: 'Files stay in the skill folder. Open a resource to edit it in the vault.', cls: 'nexus-form-hint' });
    for (const resource of detail.resources) {
      const row = body.createDiv('nexus-instruction-resource');
      row.createEl('code', { text: resource });
      if (resource.endsWith('/')) continue;
      new ButtonComponent(row).setButtonText('Open').onClick(() => {
        try {
          const path = resolveSkillResourcePath(detail.resourceRoot, resource);
          void app.workspace.openLinkText(path, '', true).catch(error => new Notice(`Resource could not be opened: ${error instanceof Error ? error.message : String(error)}`));
        } catch (error) { new Notice(error instanceof Error ? error.message : String(error)); }
      });
    }
    if (!detail.resources.length) body.createEl('p', { text: 'No resource files.', cls: 'nexus-form-hint' });
  } }, component);
  new BoxedSection(container, { title: 'Source and sync', unbounded: true, body: body => {
    new Setting(body).setName('Source').setDesc(detail.record.originPath ? `Mirrored from ${detail.record.provider}.` : 'Vault-native package.').addButton(button => button.setButtonText('Manage sources').onClick(manageSources));
    body.createEl('code', { text: detail.entrypointPath });
  } }, component);
}
