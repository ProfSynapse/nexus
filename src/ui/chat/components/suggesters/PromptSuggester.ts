/**
 * PromptSuggester - Provides autocomplete for @prompt mentions
 * Triggers on @ and suggests custom prompts with fuzzy search
 */

import { App, prepareFuzzySearch, setIcon } from 'obsidian';
import { BaseSuggester } from './base/BaseSuggester';
import {
  SuggestionItem,
  EditorSuggestContext,
  PromptSuggestionItem,
  PromptReference,
  EnhancementType
} from './base/SuggesterInterfaces';
import { MessageEnhancer } from '../../services/MessageEnhancer';
import { CustomPromptStorageService } from '../../../../agents/promptManager/services/CustomPromptStorageService';
import { TokenCalculator } from '../../utils/TokenCalculator';

/**
 * Prompt suggester for @ mention autocomplete
 */
export class PromptSuggester extends BaseSuggester<PromptSuggestionItem> {

  private messageEnhancer: MessageEnhancer;
  private promptStorage: CustomPromptStorageService;
  private maxTokensPerPrompt = 5000; // Warn if prompt exceeds this

  constructor(
    app: App,
    messageEnhancer: MessageEnhancer,
    promptStorage: CustomPromptStorageService
  ) {
    super(app, {
      // Matches @ followed by word characters
      trigger: /@(\w*)$/,
      maxSuggestions: 20,
      cacheTTL: 30000, // 30 seconds - prompts may be added/edited during chat
      debounceDelay: 100
    });

    this.messageEnhancer = messageEnhancer;
    this.promptStorage = promptStorage;
  }

  // ==========================================================================
  // Abstract Method Implementations
  // ==========================================================================

  /**
   * Get prompt suggestions with fuzzy search
   * @param context - Editor context with query
   * @returns Filtered and ranked prompt suggestions
   */
  async getSuggestions(
    context: EditorSuggestContext
  ): Promise<SuggestionItem<PromptSuggestionItem>[]> {

    // Get enabled prompts only
    const prompts = this.promptStorage.getEnabledPrompts();

    if (prompts.length === 0) {
      return [];
    }

    // If no query, return all prompts (sorted by name)
    if (!context.query || context.query.trim().length === 0) {
      const allSuggestions = prompts
        .sort((a, b) => a.name.localeCompare(b.name))
        .slice(0, this.config.maxSuggestions)
        .map(prompt => this.createSuggestion(prompt, 1.0));

      return allSuggestions;
    }

    // Fuzzy search on prompt names and descriptions
    const query = context.query.toLowerCase();
    const fuzzySearch = prepareFuzzySearch(query);

    const suggestions: SuggestionItem<PromptSuggestionItem>[] = [];

    for (const prompt of prompts) {
      // Try fuzzy match on name first (higher priority)
      const nameMatch = fuzzySearch(prompt.name);
      if (nameMatch) {
        suggestions.push(this.createSuggestion(prompt, nameMatch.score));
        continue;
      }

      // Try fuzzy match on description (lower priority)
      const descMatch = fuzzySearch(prompt.description);
      if (descMatch) {
        suggestions.push(this.createSuggestion(prompt, descMatch.score * 0.7));
      }
    }

    // Sort by score and limit
    return this.limitSuggestions(this.sortByScore(suggestions));
  }

  /**
   * Render prompt suggestion in dropdown
   * @param item - Prompt suggestion item
   * @param el - HTML element to populate
   */
  renderSuggestion(
    item: SuggestionItem<PromptSuggestionItem>,
    el: HTMLElement
  ): void {
    el.addClass('suggester-item', 'prompt-suggester-item');

    // Icon
    const icon = el.createDiv({ cls: 'suggester-icon' });
    setIcon(icon, 'bot');

    // Content container
    const content = el.createDiv({ cls: 'suggester-content' });

    // Prompt name (primary text)
    const name = content.createDiv({ cls: 'suggester-title' });
    name.textContent = item.data.name;

    // Description (secondary text)
    const desc = content.createDiv({ cls: 'suggester-description' });
    desc.textContent = item.data.description;

    // Token badge
    const badgeContainer = el.createDiv({ cls: 'suggester-badge-container' });

    // Token warning badge if needed
    if (item.data.promptTokens > this.maxTokensPerPrompt * 0.75) {
      this.addTokenBadge(badgeContainer, item.data.promptTokens, this.maxTokensPerPrompt);
    } else {
      // Just show token count
      const tokenBadge = badgeContainer.createSpan({ cls: 'suggester-badge token-info' });
      tokenBadge.textContent = `~${item.data.promptTokens.toLocaleString()} tokens`;
    }
  }

  /**
   * Handle prompt selection
   * @param item - Selected prompt
   * @param evt - Selection event
   */
  selectSuggestion(
    item: SuggestionItem<PromptSuggestionItem>,
    evt: MouseEvent | KeyboardEvent
  ): void {

    // Access the context property from EditorSuggest base class
    // This is typed as EditorSuggestContext | null in Obsidian's API
    if (!this.context) return;

    const { editor, start, end } = this.context;

    // Create prompt reference
    const promptRef: PromptReference = {
      id: item.data.id,
      name: item.data.name,
      prompt: item.data.prompt,
      tokens: item.data.promptTokens
    };

    // Add to message enhancer
    this.messageEnhancer.addPrompt(promptRef);

    // Replace @ mention with prompt name (in format that's clear to user)
    const replacement = `@${item.data.name.replace(/\s+/g, '_')}`;

    // Replace text in editor
    editor.replaceRange(
      replacement + ' ', // Add space after for better UX
      start,
      end
    );

    // Move cursor after the mention
    const newCursor = {
      line: start.line,
      ch: start.ch + replacement.length + 1
    };
    editor.setCursor(newCursor);
  }

  /**
   * Estimate tokens for a prompt
   * @param item - Prompt data
   * @returns Estimated token count
   */
  protected estimateItemTokens(item: PromptSuggestionItem): number {
    return item.promptTokens;
  }

  // ==========================================================================
  // Helper Methods
  // ==========================================================================

  /**
   * Create suggestion item from CustomPrompt
   * @param promptData - Custom prompt data
   * @param score - Match score
   * @returns Suggestion item
   */
  private createSuggestion(
    promptData: { id: string; name: string; description: string; prompt: string },
    score: number
  ): SuggestionItem<PromptSuggestionItem> {

    const promptTokens = TokenCalculator.estimateTextTokens(promptData.prompt);

    return {
      data: {
        id: promptData.id,
        name: promptData.name,
        description: promptData.description,
        prompt: promptData.prompt,
        promptTokens: promptTokens
      },
      score: score,
      displayText: promptData.name,
      description: promptData.description,
      tokens: promptTokens
    };
  }

  /**
   * Refresh cache when prompts are modified
   */
  refreshCache(): void {
    this.clearCache();
  }
}
