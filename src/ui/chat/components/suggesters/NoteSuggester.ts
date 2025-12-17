/**
 * NoteSuggester - Provides autocomplete for [[note]] references
 * Triggers on [[ and suggests vault notes with fuzzy search
 */

import { App, TFile, prepareFuzzySearch, setIcon } from 'obsidian';
import { BaseSuggester } from './base/BaseSuggester';
import {
  SuggestionItem,
  EditorSuggestContext,
  NoteSuggestionItem,
  NoteReference,
  EnhancementType
} from './base/SuggesterInterfaces';
import { MessageEnhancer } from '../../services/MessageEnhancer';
import { TokenCalculator } from '../../utils/TokenCalculator';

/**
 * Note suggester for [[ wikilink autocomplete
 */
export class NoteSuggester extends BaseSuggester<NoteSuggestionItem> {

  private messageEnhancer: MessageEnhancer;
  private maxTokensPerNote = 10000; // Warn if note exceeds this

  constructor(app: App, messageEnhancer: MessageEnhancer) {
    super(app, {
      // Matches [[ followed by any text
      trigger: /\[\[([^\]]*?)$/,
      maxSuggestions: 50,
      cacheTTL: 60000, // 1 minute - notes don't change that often during a chat session
      debounceDelay: 150
    });

    this.messageEnhancer = messageEnhancer;
  }

  // ==========================================================================
  // Abstract Method Implementations
  // ==========================================================================

  /**
   * Get note suggestions with fuzzy search
   * @param context - Editor context with query
   * @returns Filtered and ranked note suggestions
   */
  async getSuggestions(
    context: EditorSuggestContext
  ): Promise<SuggestionItem<NoteSuggestionItem>[]> {

    // Get all markdown files
    const files = this.app.vault.getMarkdownFiles();

    // If no query, return all files (sorted by recent modification)
    if (!context.query || context.query.trim().length === 0) {
      const allSuggestions = files
        .sort((a, b) => b.stat.mtime - a.stat.mtime) // Most recently modified first
        .slice(0, this.config.maxSuggestions)
        .map(file => this.createSuggestion(file, 1.0));

      return allSuggestions;
    }

    // Fuzzy search on file paths and names
    const query = context.query.toLowerCase();
    const fuzzySearch = prepareFuzzySearch(query);

    const suggestions: SuggestionItem<NoteSuggestionItem>[] = [];

    for (const file of files) {
      // Search against basename and path
      const basename = file.basename;
      const path = file.path;

      // Try fuzzy match on basename first (higher priority)
      const basenameMatch = fuzzySearch(basename);
      if (basenameMatch) {
        suggestions.push(this.createSuggestion(file, basenameMatch.score));
        continue;
      }

      // Try fuzzy match on full path (lower priority)
      const pathMatch = fuzzySearch(path);
      if (pathMatch) {
        suggestions.push(this.createSuggestion(file, pathMatch.score * 0.8));
      }
    }

    // Sort by score and limit
    return this.limitSuggestions(this.sortByScore(suggestions));
  }

  /**
   * Render note suggestion in dropdown
   * @param item - Note suggestion item
   * @param el - HTML element to populate
   */
  renderSuggestion(
    item: SuggestionItem<NoteSuggestionItem>,
    el: HTMLElement
  ): void {
    el.addClass('suggester-item', 'note-suggester-item');

    // Icon
    const icon = el.createDiv({ cls: 'suggester-icon' });
    setIcon(icon, 'file-text');

    // Content container
    const content = el.createDiv({ cls: 'suggester-content' });

    // Note name (primary text)
    const name = content.createDiv({ cls: 'suggester-title' });
    name.textContent = item.data.name;

    // Path (secondary text)
    const path = content.createDiv({ cls: 'suggester-description' });
    path.textContent = item.data.path;

    // Token badge
    const badgeContainer = el.createDiv({ cls: 'suggester-badge-container' });

    // Token warning badge if needed
    if (item.data.estimatedTokens > this.maxTokensPerNote * 0.75) {
      this.addTokenBadge(badgeContainer, item.data.estimatedTokens, this.maxTokensPerNote);
    } else {
      // Just show token count
      const tokenBadge = badgeContainer.createSpan({ cls: 'suggester-badge token-info' });
      tokenBadge.textContent = `~${item.data.estimatedTokens.toLocaleString()} tokens`;
    }
  }

  /**
   * Handle note selection
   * @param item - Selected note
   * @param evt - Selection event
   */
  async selectSuggestion(
    item: SuggestionItem<NoteSuggestionItem>,
    evt: MouseEvent | KeyboardEvent
  ): Promise<void> {

    const context = this.context;
    if (!context) return;

    const { editor, start, end } = context;

    // Read note content
    const content = await this.app.vault.read(item.data.file);

    // Calculate actual tokens
    const tokens = TokenCalculator.estimateTextTokens(content);

    // Create note reference
    const noteRef: NoteReference = {
      path: item.data.path,
      name: item.data.name,
      content: content,
      tokens: tokens
    };

    // Add to message enhancer
    this.messageEnhancer.addNote(noteRef);

    // Replace trigger + query with wikilink
    const replacement = `[[${item.data.name}]]`;

    // Replace text in editor
    editor.replaceRange(
      replacement,
      start,
      end
    );

    // Move cursor after the wikilink
    const newCursor = {
      line: start.line,
      ch: start.ch + replacement.length
    };
    editor.setCursor(newCursor);
  }

  /**
   * Estimate tokens for a note
   * @param item - Note data
   * @returns Estimated token count
   */
  protected estimateItemTokens(item: NoteSuggestionItem): number {
    // Use character count for estimation: ~4 chars per token
    // This is a rough estimate without reading the file
    return Math.ceil(item.size / 4);
  }

  // ==========================================================================
  // Helper Methods
  // ==========================================================================

  /**
   * Create suggestion item from TFile
   * @param file - Obsidian TFile
   * @param score - Match score
   * @returns Suggestion item
   */
  private createSuggestion(file: TFile, score: number): SuggestionItem<NoteSuggestionItem> {
    const estimatedTokens = Math.ceil(file.stat.size / 4); // ~4 chars per token

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
