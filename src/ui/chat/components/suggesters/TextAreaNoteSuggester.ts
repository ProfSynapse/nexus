/**
 * TextAreaNoteSuggester - Note suggester for textarea
 */

import { App, TFile, setIcon, Component } from 'obsidian';
import { ContentEditableSuggester } from './ContentEditableSuggester';
import { ContentEditableHelper } from '../../utils/ContentEditableHelper';
import {
  SuggestionItem,
  NoteSuggestionItem,
  NoteReference
} from './base/SuggesterInterfaces';
import { MessageEnhancer } from '../../services/MessageEnhancer';
import { TokenCalculator } from '../../utils/TokenCalculator';
import type { EmbeddingService } from '../../../../services/embeddings/EmbeddingService';
import { searchNotes } from '../../../../utils/noteSearch';

export class TextAreaNoteSuggester extends ContentEditableSuggester<NoteSuggestionItem> {
  private messageEnhancer: MessageEnhancer;
  private embeddingService: EmbeddingService | null;
  private maxTokensPerNote = 10000;

  constructor(app: App, element: HTMLElement, messageEnhancer: MessageEnhancer, component?: Component, embeddingService?: EmbeddingService | null) {
    super(app, element, {
      trigger: /\[\[([^\]]*?)$/,
      maxSuggestions: 50,
      cacheTTL: 60000,
      debounceDelay: 150
    }, component);

    this.messageEnhancer = messageEnhancer;
    this.embeddingService = embeddingService ?? null;
  }

  async getSuggestions(query: string): Promise<SuggestionItem<NoteSuggestionItem>[]> {
    const files = await searchNotes(this.app, query, this.embeddingService, this.config.maxSuggestions);
    return files.map(file => this.createSuggestion(file, 1.0));
  }

  renderSuggestion(item: SuggestionItem<NoteSuggestionItem>, el: HTMLElement): void {
    el.addClass('note-suggester-item');

    const icon = el.createDiv({ cls: 'suggester-icon' });
    setIcon(icon, 'file-text');

    const content = el.createDiv({ cls: 'suggester-content' });
    content.createDiv({ cls: 'suggester-title', text: item.data.name });
    content.createDiv({ cls: 'suggester-description', text: item.data.path });

    const badgeContainer = el.createDiv({ cls: 'suggester-badge-container' });
    
    if (item.data.estimatedTokens > this.maxTokensPerNote * 0.75) {
      const tokenBadge = badgeContainer.createSpan({ cls: 'suggester-badge token-badge-warning' });
      tokenBadge.textContent = `~${item.data.estimatedTokens.toLocaleString()} tokens`;
    } else {
      // Just show token count
      const tokenBadge = badgeContainer.createSpan({ cls: 'suggester-badge token-info' });
      tokenBadge.textContent = `~${item.data.estimatedTokens.toLocaleString()} tokens`;
    }
  }

  async selectSuggestion(item: SuggestionItem<NoteSuggestionItem>): Promise<void> {
    // Read note content
    const content = await this.app.vault.read(item.data.file);
    const tokens = TokenCalculator.estimateTextTokens(content);

    // Add to message enhancer
    const noteRef: NoteReference = {
      path: item.data.path,
      name: item.data.name,
      content: content,
      tokens: tokens
    };
    this.messageEnhancer.addNote(noteRef);

    // Replace [[ with styled reference badge
    const cursorPos = ContentEditableHelper.getCursorPosition(this.element);
    const text = ContentEditableHelper.getPlainText(this.element);
    const beforeCursor = text.substring(0, cursorPos);
    const match = /\[\[([^\]]*)$/.exec(beforeCursor);

    if (match) {
      const start = cursorPos - match[0].length;

      // Delete the trigger text
      ContentEditableHelper.deleteTextAtCursor(this.element, start, cursorPos);

      // Insert styled reference
      ContentEditableHelper.insertReferenceNode(
        this.element,
        'note',
        `[[${item.data.name}]]`,
        item.data.path
      );
    }
  }

  private createSuggestion(file: TFile, score: number): SuggestionItem<NoteSuggestionItem> {
    const estimatedTokens = Math.ceil(file.stat.size / 4);

    return {
      data: {
        file: file,
        name: file.basename,
        path: file.path,
        size: file.stat.size,
        estimatedTokens: estimatedTokens
      },
      score: score,
      displayText: file.basename,
      description: file.path,
      tokens: estimatedTokens
    };
  }
}
