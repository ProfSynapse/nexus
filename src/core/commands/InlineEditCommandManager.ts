/**
 * InlineEditCommandManager
 *
 * Handles registration of inline AI editing commands and context menu items.
 * Implements the editorCallback pattern for guaranteed editor access.
 */

import { Notice, MarkdownView, MarkdownFileInfo, Plugin, Menu, Editor, App, Events } from 'obsidian';
import { InlineEditModal } from '../../ui/inline-edit/InlineEditModal';
import { InlineEditService } from '../../services/InlineEditService';
import type { SelectionContext } from '../../ui/inline-edit/types';
import type { LLMService } from '../../services/llm/core/LLMService';
import type { Settings } from '../../settings';

// Extend Workspace type for editor-menu event (not exposed in public types)
declare module 'obsidian' {
  interface Workspace extends Events {
    on(name: 'editor-menu', callback: (menu: Menu, editor: Editor, info: MarkdownView | MarkdownFileInfo) => void): import('obsidian').EventRef;
  }
}

/**
 * Plugin interface with required properties
 */
interface PluginWithServices extends Plugin {
  settings?: Settings;
  getService<T>(name: string, timeoutMs?: number): Promise<T | null>;
}

export interface InlineEditCommandConfig {
  plugin: PluginWithServices;
  app: App;
  getService: <T>(name: string, timeoutMs?: number) => Promise<T | null>;
}

export class InlineEditCommandManager {
  private config: InlineEditCommandConfig;

  constructor(config: InlineEditCommandConfig) {
    this.config = config;
  }

  /**
   * Register all inline edit commands and menus
   */
  registerCommands(): void {
    this.registerInlineEditCommand();
    this.registerContextMenu();
  }

  /**
   * Register the main inline edit command
   * Uses editorCallback to guarantee editor access with selection state
   */
  private registerInlineEditCommand(): void {
    this.config.plugin.addCommand({
      id: 'inline-ai-edit',
      name: 'Edit selection with AI',
      editorCallback: async (editor: Editor, ctx: MarkdownView | MarkdownFileInfo) => {
        // Get MarkdownView from context
        const view = ctx instanceof MarkdownView ? ctx : this.getActiveMarkdownView();
        if (!view) {
          new Notice('No active markdown view');
          return;
        }
        await this.handleInlineEdit(editor, view);
      }
    });
  }

  /**
   * Get the active MarkdownView if available
   */
  private getActiveMarkdownView(): MarkdownView | null {
    const leaf = this.config.app.workspace.activeLeaf;
    if (leaf?.view instanceof MarkdownView) {
      return leaf.view;
    }
    return null;
  }

  /**
   * Register context menu item for inline editing
   * Only shows when text is selected
   */
  private registerContextMenu(): void {
    this.config.plugin.registerEvent(
      this.config.app.workspace.on('editor-menu', (menu: Menu, editor: Editor, info: MarkdownView | MarkdownFileInfo) => {
        // Only show option if text is selected
        if (!editor.somethingSelected()) {
          return;
        }

        // Get MarkdownView from info
        const view = info instanceof MarkdownView ? info : this.getActiveMarkdownView();
        if (!view) {
          return;
        }

        menu.addItem((item) => {
          item
            .setTitle('Edit with AI')
            .setIcon('wand-2')
            .onClick(async () => {
              await this.handleInlineEdit(editor, view);
            });
        });
      })
    );
  }

  /**
   * Handle inline edit trigger (from command or context menu)
   */
  private async handleInlineEdit(editor: Editor, view: MarkdownView): Promise<void> {
    // Check for selection
    if (!editor.somethingSelected()) {
      new Notice('Please select text to edit');
      return;
    }

    // Capture selection context BEFORE opening modal
    const selectedText = editor.getSelection();
    const from = editor.getCursor('from');
    const to = editor.getCursor('to');
    const fileName = view.file?.name || 'Untitled';

    const selectionContext: SelectionContext = {
      selectedText,
      from,
      to,
      editor,
      view,
      fileName
    };

    // Get LLM service
    const llmService = await this.config.getService<LLMService>('llmService');
    if (!llmService) {
      new Notice('LLM service not available. Please check your configuration.');
      return;
    }

    // Create InlineEditService for this editing session
    const inlineEditService = new InlineEditService(llmService);

    // Open modal with captured context and injected service
    const modal = new InlineEditModal(
      this.config.app,
      this.config.plugin,
      selectionContext,
      inlineEditService
    );
    modal.open();
  }
}
