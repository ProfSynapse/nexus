/**
 * ConversationTitleModal - Modal for creating new conversation with title
 *
 * Properly extends Obsidian's Modal class for proper focus management
 */

import { App, Modal, Setting } from 'obsidian';

export class ConversationTitleModal extends Modal {
  private result: string | null = null;
  private submitted = false;
  private inputEl: HTMLInputElement | null = null;

  constructor(app: App, private onSubmit: (title: string | null) => void) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass('chat-conversation-title-modal');

    contentEl.createEl('h2', { text: 'New conversation' });
    contentEl.createEl('p', { text: 'Enter a title for your new conversation:' });

    new Setting(contentEl)
      .setName('Conversation title')
      .addText((text) => {
        this.inputEl = text.inputEl;

        text
          .setPlaceholder('Chat title')
          .onChange((value) => {
            this.result = value;
          });

        text.inputEl.addEventListener('keydown', (e: KeyboardEvent) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            this.submit();
          }
        });
      });

    // Action buttons
    const buttonContainer = contentEl.createDiv('modal-button-container');
    buttonContainer.addClass('modal-button-container-flex');

    const cancelBtn = buttonContainer.createEl('button', {
      text: 'Cancel',
      cls: 'mod-cancel'
    });
    cancelBtn.addEventListener('click', () => this.close());

    const createBtn = buttonContainer.createEl('button', {
      text: 'Create chat',
      cls: 'mod-cta'
    });
    createBtn.addEventListener('click', () => this.submit());

    // Focus the input after modal is fully rendered
    setTimeout(() => {
      this.inputEl?.focus();
    }, 0);
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

  onClose(): void {
    // Release focus from modal elements before cleanup
    this.inputEl?.blur();

    const { contentEl } = this;
    contentEl.empty();

    // Call the callback with result (or null if cancelled)
    if (this.submitted && this.result?.trim()) {
      this.onSubmit(this.result.trim());
    } else {
      this.onSubmit(null);
    }

    // Restore focus to workspace so cursor is not trapped
    activeWindow.document.body.focus();
  }
}
