/**
 * MessageActionBar - Populates the existing message-actions-external pill
 * Location: /src/ui/chat/components/MessageActionBar.ts
 *
 * Renders four action buttons into the caller-supplied container element
 * (the existing .message-actions-external pill that sits in the upper-right
 * corner of each message bubble). Buttons appear alongside any other pill
 * contents (e.g. branch navigator) and use the same message-action-btn
 * styling as the original copy button did.
 *
 * Only rendered for completed assistant messages with non-empty text content.
 * Called by MessageBubble.appendActionBar() after message state transitions
 * to complete.
 */

import { App, Component, MarkdownView, Notice, setIcon } from 'obsidian';
import { CreateFileModal } from './CreateFileModal';

export class MessageActionBar extends Component {
  private buttons: HTMLElement[] = [];
  private copyButton: HTMLElement | null = null;

  constructor(
    private readonly content: string,
    private readonly app: App
  ) {
    super();
  }

  /**
   * Create the four action buttons inside the provided container element.
   * The container is the existing .message-actions-external pill — no new
   * wrapper is created. Call removeFromContainer() before unload to clean up.
   */
  renderInto(container: HTMLElement): void {
    this.copyButton = this.addButton(container, 'copy', 'Copy message', () => this.handleCopy());

    // Insert and Append need mousedown:preventDefault so clicking the button
    // does not shift focus away from the active note (and lose the cursor).
    const insertBtn = this.addButton(container, 'file-input', 'Insert at cursor', () => this.handleInsert());
    this.registerDomEvent(insertBtn, 'mousedown', (e: MouseEvent) => e.preventDefault());

    const appendBtn = this.addButton(container, 'file-plus-2', 'Append to active note', () => { void this.handleAppend(); });
    this.registerDomEvent(appendBtn, 'mousedown', (e: MouseEvent) => e.preventDefault());

    this.addButton(container, 'file-plus', 'Create new file', () => this.handleCreate());
  }

  /**
   * Remove all buttons this component added from their parent container.
   * Call before unload() to keep the DOM clean.
   */
  removeFromContainer(): void {
    this.buttons.forEach(btn => btn.remove());
    this.buttons = [];
    this.copyButton = null;
  }

  // ─── Private helpers ────────────────────────────────────────────────────────

  private addButton(
    parent: HTMLElement,
    icon: string,
    title: string,
    handler: () => void
  ): HTMLElement {
    const btn = parent.createEl('button', {
      cls: 'message-action-btn clickable-icon',
      attr: { title, 'aria-label': title }
    });
    setIcon(btn, icon);
    this.registerDomEvent(btn, 'click', handler);
    this.buttons.push(btn);
    return btn;
  }

  private handleCopy(): void {
    navigator.clipboard.writeText(this.content).then(() => {
      if (this.copyButton) this.showCopyFeedback(this.copyButton);
    }).catch(err => {
      console.error('[MessageActionBar] Copy failed:', err);
      new Notice('Copy failed.');
    });
  }

  private showCopyFeedback(button: HTMLElement): void {
    setIcon(button, 'check');
    button.classList.add('copy-success');
    setTimeout(() => {
      setIcon(button, 'copy');
      button.classList.remove('copy-success');
    }, 1500);
  }

  /**
   * Returns the active MarkdownView, or falls back to the most recently
   * opened markdown leaf if the chat panel currently has workspace focus.
   */
  private getMarkdownView(): MarkdownView | null {
    const active = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (active) return active;

    // Chat panel has focus — find any open note tab
    const leaves = this.app.workspace.getLeavesOfType('markdown');
    if (leaves.length === 0) return null;
    return leaves[leaves.length - 1].view as MarkdownView;
  }

  private handleInsert(): void {
    const view = this.getMarkdownView();
    if (!view) {
      new Notice('No active note — open a note and place your cursor first.');
      return;
    }
    view.editor.focus();
    view.editor.replaceSelection(this.content);
  }

  private async handleAppend(): Promise<void> {
    const view = this.getMarkdownView();
    if (!view?.file) {
      new Notice('No active note — open a note first.');
      return;
    }

    const timestamp = new Date().toLocaleString();
    const separator = `\n\n---\n*Appended from Nexus Chat — ${timestamp}*\n\n`;

    await this.app.vault.process(view.file, (fileContent) => {
      return fileContent + separator + this.content;
    });

    new Notice('Appended to note.');
  }

  private handleCreate(): void {
    new CreateFileModal(this.app, this.content).open();
  }
}
