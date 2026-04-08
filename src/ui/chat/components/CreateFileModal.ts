/**
 * CreateFileModal - Modal for creating a new vault file from chat content
 * Location: /src/ui/chat/components/CreateFileModal.ts
 *
 * Presents a filename field, folder path (defaulting to 00-inbox), and an
 * open-after-save toggle. Creates the folder if it does not exist, guards
 * against duplicate filenames, and opens the created file on request.
 *
 * Used by MessageActionBar when the user clicks "Create new file".
 */

import { App, Modal, Notice, Setting, ToggleComponent, normalizePath } from 'obsidian';

export class CreateFileModal extends Modal {
  private filename = '';
  private folderPath = '00-Inbox';
  private openAfterSave = true;
  private openAfterSaveToggle: ToggleComponent | null = null;
  private readonly content: string;

  constructor(app: App, content: string) {
    super(app);
    this.content = content;
  }

  onOpen(): void {
    const { contentEl } = this;

    contentEl.createEl('h2', { text: 'Create new file' });

    // File name input
    let filenameInput: HTMLInputElement;
    new Setting(contentEl)
      .setName('File name')
      .addText(text => {
        text.setPlaceholder('Note name')
          .onChange(value => { this.filename = value; });
        filenameInput = text.inputEl;
      });

    // Folder path input
    new Setting(contentEl)
      .setName('Folder')
      .setDesc('Folder path within your vault')
      .addText(text => {
        text.setValue(this.folderPath)
          .onChange(value => { this.folderPath = value; });
      });

    // Open after save toggle — store ref so handleCreate reads current value directly
    new Setting(contentEl)
      .setName('Open after saving')
      .addToggle(toggle => {
        toggle.setValue(this.openAfterSave);
        this.openAfterSaveToggle = toggle;
      });

    // Action buttons
    new Setting(contentEl)
      .addButton(button => {
        button.setButtonText('Create')
          .setCta()
          .onClick(() => this.handleCreate());
      })
      .addButton(button => {
        button.setButtonText('Cancel')
          .onClick(() => this.close());
      });

    // Focus filename input on open
    setTimeout(() => { filenameInput?.focus(); }, 50);
  }

  private async handleCreate(): Promise<void> {
    // Strip .md suffix and trim whitespace
    let name = this.filename.trim();
    if (name.toLowerCase().endsWith('.md')) {
      name = name.slice(0, -3).trim();
    }

    if (!name) {
      new Notice('Please enter a file name.');
      return;
    }

    const folder = this.folderPath.trim() || '00-Inbox';
    const filePath = normalizePath(`${folder}/${name}.md`);

    // Guard against duplicate
    if (this.app.vault.getFileByPath(filePath)) {
      new Notice(`File already exists: ${filePath}`);
      return;
    }

    try {
      await this.ensureFolder(folder);
      const file = await this.app.vault.create(filePath, this.content);
      new Notice(`Created: ${name}.md`);
      this.close();

      const shouldOpen = this.openAfterSaveToggle
        ? this.openAfterSaveToggle.getValue()
        : this.openAfterSave;
      if (shouldOpen) {
        await this.app.workspace.getLeaf().openFile(file);
      }
    } catch (err) {
      console.error('[CreateFileModal] Error creating file:', err);
      new Notice(`Failed to create file: ${String(err)}`);
    }
  }

  private async ensureFolder(folderPath: string): Promise<void> {
    const normalized = normalizePath(folderPath);
    if (!this.app.vault.getAbstractFileByPath(normalized)) {
      await this.app.vault.createFolder(normalized);
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
