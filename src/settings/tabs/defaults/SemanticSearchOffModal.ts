/**
 * Confirmation before semantic search is turned off.
 *
 * Says what stops working and that the index is kept. Turn off resolves true;
 * Cancel, the close button and Escape resolve false. A plain Obsidian Modal
 * with no Node imports, so it is safe to load on mobile even though the fold
 * that opens it exists only on desktop.
 */

import { App, ButtonComponent, Modal } from 'obsidian';
import { SEMANTIC_OFF_MODAL_COPY as COPY } from '../../../components/shared/chatSettings/copy';

export class SemanticSearchOffModal extends Modal {
  private confirmed = false;
  private settled = false;

  constructor(app: App, private readonly onResolve: (confirmed: boolean) => void) {
    super(app);
  }

  /** Open the modal and resolve with the user's choice. */
  static confirm(app: App): Promise<boolean> {
    return new Promise<boolean>(resolve => {
      new SemanticSearchOffModal(app, resolve).open();
    });
  }

  onOpen(): void {
    this.setTitle(COPY.title);
    this.modalEl.addClass('mod-confirm');

    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('p', { text: COPY.lede });
    const list = contentEl.createEl('ul');
    for (const bullet of COPY.bullets) {
      list.createEl('li', { text: bullet });
    }
    contentEl.createEl('p', { text: COPY.note, cls: 'nexus-semantic-off-note' });

    const buttons = this.modalEl.createDiv('modal-button-container');
    new ButtonComponent(buttons)
      .setButtonText(COPY.cancel)
      .onClick(() => this.close());
    new ButtonComponent(buttons)
      .setButtonText(COPY.confirm)
      .setWarning()
      .onClick(() => {
        this.confirmed = true;
        this.close();
      });
  }

  onClose(): void {
    this.contentEl.empty();
    if (this.settled) return;
    this.settled = true;
    this.onResolve(this.confirmed);
  }
}
