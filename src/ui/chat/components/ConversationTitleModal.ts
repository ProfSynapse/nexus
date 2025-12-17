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

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass('chat-conversation-title-modal');

    contentEl.createEl('h2', { text: 'New Conversation' });
    contentEl.createEl('p', { text: 'Enter a title for your new conversation:' });

    // Create input using Obsidian's Setting component for consistency
    new Setting(contentEl)
      .setName('Conversation Title')
      .addText((text) => {
        this.inputEl = text.inputEl;
        text
          .setPlaceholder('e.g., "Help with React project"')
          .onChange((value) => {
            this.result = value;
          });
        // Modal cleanup handles this automatically
        text.inputEl.addEventListener('keydown', (e: KeyboardEvent) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            this.submit();
          }
        });

        // Focus the input after a small delay to ensure modal is fully rendered
        setTimeout(() => {
          text.inputEl.focus();
          text.inputEl.select();
        }, 10);
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
      text: 'Create Chat',
      cls: 'mod-cta'
    });
    createBtn.addEventListener('click', () => this.submit());
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
