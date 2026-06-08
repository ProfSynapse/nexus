/**
 * SavePromptModal - Asks whether to save a read-aloud rendering to the note.
 *
 * Shown when the user invokes "Read aloud". Offers three outcomes:
 *   - 'save'  → [Save & read]  : play AND save the audio + insert the embed
 *   - 'read'  → [Just read]    : play only, nothing saved
 *   - 'cancel'→ [Cancel] / dismiss : do nothing
 */

import { App, Component, Modal } from 'obsidian';

export type SavePromptChoice = 'save' | 'read' | 'cancel';

export class SavePromptModal extends Modal {
  private choice: SavePromptChoice = 'cancel';
  private modalEvents: Component | null = null;

  constructor(app: App, private onChoose: (choice: SavePromptChoice) => void) {
    super(app);
  }

  onOpen(): void {
    this.modalEvents = new Component();
    const { contentEl } = this;
    contentEl.addClass('read-aloud-save-prompt');

    contentEl.createEl('h2', { text: 'Read aloud' });
    contentEl.createEl('p', { text: 'Save this read-aloud to the note?' });

    const buttonContainer = contentEl.createDiv('modal-button-container');
    buttonContainer.addClass('modal-button-container-flex');

    const cancelBtn = buttonContainer.createEl('button', {
      text: 'Cancel',
      cls: 'mod-cancel'
    });
    this.modalEvents.registerDomEvent(cancelBtn, 'click', () => {
      this.choice = 'cancel';
      this.close();
    });

    const justReadBtn = buttonContainer.createEl('button', {
      text: 'Just read'
    });
    this.modalEvents.registerDomEvent(justReadBtn, 'click', () => {
      this.choice = 'read';
      this.close();
    });

    const saveReadBtn = buttonContainer.createEl('button', {
      text: 'Save & read',
      cls: 'mod-cta'
    });
    this.modalEvents.registerDomEvent(saveReadBtn, 'click', () => {
      this.choice = 'save';
      this.close();
    });

    window.setTimeout(() => {
      saveReadBtn.focus();
    }, 0);
  }

  onClose(): void {
    const { contentEl } = this;
    contentEl.empty();
    this.modalEvents?.unload();
    this.modalEvents = null;
    this.onChoose(this.choice);
  }
}
