/**
 * MessageActionBar - Action pill shown below completed AI message bubbles
 * Location: /src/ui/chat/components/MessageActionBar.ts
 *
 * Renders four action buttons: Copy, Insert at cursor, Append to active note,
 * and Create new file. Appears only on completed assistant messages that have
 * non-empty text content. Fades to 35% opacity at rest and full opacity on hover.
 *
 * Used by MessageBubble.appendActionBar() after a message reaches completed state.
 */

import { App, Component, MarkdownView, Notice, setIcon } from 'obsidian';
import { CreateFileModal } from './CreateFileModal';

export class MessageActionBar extends Component {
  private element: HTMLElement | null = null;

  constructor(
    private readonly content: string,
    private readonly app: App
  ) {
    super();
  }

  /**
   * Build and return the pill element. Call once — the element is stored and
   * returned by getElement() for later DOM removal.
   */
  createElement(): HTMLElement {
    const bar = document.createElement('div');
    bar.addClass('message-action-bar');

    this.addButton(bar, 'copy', 'Copy message', () => this.handleCopy(bar));
    this.addButton(bar, 'file-input', 'Insert at cursor', () => this.handleInsert());
    this.addButton(bar, 'file-plus-2', 'Append to active note', () => this.handleAppend());
    this.addButton(bar, 'file-plus', 'Create new file', () => this.handleCreate());

    this.element = bar;
    return bar;
  }

  getElement(): HTMLElement | null {
    return this.element;
  }

  // ─── Private helpers ────────────────────────────────────────────────────────

  private addButton(
    parent: HTMLElement,
    icon: string,
    title: string,
    handler: () => void
  ): void {
    const btn = parent.createEl('button', {
      cls: 'message-action-bar-btn clickable-icon',
      attr: { title, 'aria-label': title }
    });
    setIcon(btn, icon);
    this.registerDomEvent(btn, 'click', handler);
  }

  private handleCopy(bar: HTMLElement): void {
    navigator.clipboard.writeText(this.content).then(() => {
      const btn = bar.querySelector('[title="Copy message"]');
      if (btn instanceof HTMLElement) {
        this.showCopyFeedback(btn);
      }
    }).catch(err => {
      console.error('[MessageActionBar] Copy failed:', err);
      new Notice('Copy failed.');
    });
  }

  private showCopyFeedback(button: HTMLElement): void {
    setIcon(button, 'check');
    setTimeout(() => {
      setIcon(button, 'copy');
    }, 1500);
  }

  private handleInsert(): void {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) return;
    view.editor.replaceSelection(this.content);
  }

  private async handleAppend(): Promise<void> {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view?.file) return;

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
