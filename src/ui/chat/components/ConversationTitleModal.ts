/**
 * ConversationTitleModal - Modal for creating new conversation with title
 *
 * Properly extends Obsidian's Modal class for proper focus management
 */

import { App, Component, Modal, Setting } from 'obsidian';

export class ConversationTitleModal extends Modal {
  private result: string | null = null;
  private submitted = false;
  private inputEl: HTMLInputElement | null = null;
  private component = new Component();

  constructor(app: App, private onSubmit: (title: string | null) => void) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    this.component.load();
    contentEl.addClass('chat-conversation-title-modal');
    
    // Simulate a click on the modal to ensure Obsidian's keyboard scope is activated.
    // This is necessary when the modal opens after a native confirm() dialog,
    // which can leave the scope in an uninitialized state.
    setTimeout(() => {
      this.modalEl.click();
    }, 10);

    contentEl.createEl('h2', { text: 'New Conversation' });
    contentEl.createEl('p', { text: 'Enter a title for your new conversation:' });

    new Setting(contentEl)
      .setName('Conversation Title')
      .addText((text) => {
        this.inputEl = text.inputEl;
        
        text
          .setPlaceholder('e.g., "Help with React project"')
          .onChange((value) => {
            this.result = value;
          });
          
        this.component.registerDomEvent(text.inputEl, 'keydown', (e: KeyboardEvent) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            this.submit();
          }
        });

        // Focus the input after modal activation click
        requestAnimationFrame(() => {
          setTimeout(() => {
            if (this.inputEl) {
              this.inputEl.click();
              this.inputEl.focus();
              this.inputEl.select();
            }
          }, 50);
        });
      });

    // Action buttons
    const buttonContainer = contentEl.createDiv('modal-button-container');
    buttonContainer.addClass('modal-button-container-flex');

    const cancelBtn = buttonContainer.createEl('button', {
      text: 'Cancel',
      cls: 'mod-cancel'
    });
    this.component.registerDomEvent(cancelBtn, 'click', () => this.close());

    const createBtn = buttonContainer.createEl('button', {
      text: 'Create Chat',
      cls: 'mod-cta'
    });
    this.component.registerDomEvent(createBtn, 'click', () => this.submit());
  }

  private submit() {
    const title = this.result?.trim();
    if (!title) {
      // Show error state on input
      if (this.inputEl) {
        this.inputEl.addClass('is-invalid');
        this.inputEl.focus();
        setTimeout(() => {
          this.inputEl?.removeClass('is-invalid');
        }, 2000);
      }
      return;
    }

    this.submitted = true;
    this.close();
  }

  onClose() {
    this.component.unload();
    const { contentEl } = this;
    contentEl.empty();

    // Call the callback with result (or null if cancelled)
    if (this.submitted && this.result?.trim()) {
      this.onSubmit(this.result.trim());
    } else {
      this.onSubmit(null);
    }
  }
}
