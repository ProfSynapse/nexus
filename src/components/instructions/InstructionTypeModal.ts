import { App, ButtonComponent, Modal, Setting } from 'obsidian';

export class InstructionTypeModal extends Modal {
  constructor(app: App, private readonly selected: (type: 'prompt' | 'skill') => void) { super(app); }
  onOpen(): void {
    this.contentEl.empty();
    this.contentEl.createEl('h2', { text: 'New instruction' });
    new Setting(this.contentEl).setName('Prompt').setDesc('A single block of instruction text.').addButton(button => button.setButtonText('New prompt').onClick(() => { this.close(); this.selected('prompt'); }));
    new Setting(this.contentEl).setName('Skill').setDesc('A folder with SKILL.md and optional resources.').addButton(button => button.setButtonText('New skill').onClick(() => { this.close(); this.selected('skill'); }));
    new ButtonComponent(this.contentEl).setButtonText('Cancel').onClick(() => this.close());
  }
  onClose(): void { this.contentEl.empty(); }
}
