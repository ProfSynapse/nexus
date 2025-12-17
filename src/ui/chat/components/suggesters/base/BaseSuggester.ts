/**
 * BaseSuggester - Abstract base class for all suggester implementations
 * Extends Obsidian's EditorSuggest to provide inline autocomplete functionality
 */

import { App, Editor, EditorPosition, EditorSuggest, TFile } from 'obsidian';
import { TokenCalculator } from '../../../utils/TokenCalculator';
import {
  SuggesterConfig,
  SuggestionItem,
  EditorSuggestContext,
  CacheEntry,
  TokenWarning,
  TokenWarningLevel
} from './SuggesterInterfaces';

/**
 * Abstract base class for suggester implementations
 * Provides common functionality: trigger detection, caching, token estimation
 */
export abstract class BaseSuggester<T> extends EditorSuggest<SuggestionItem<T>> {

  protected config: SuggesterConfig;
  protected cache = new Map<string, CacheEntry<T>>();

  constructor(app: App, config: SuggesterConfig) {
    super(app);
    this.config = config;
  }

  // ==========================================================================
  // Abstract Methods - Must be implemented by subclasses
  // ==========================================================================

  /**
   * Get filtered and ranked suggestions based on context
   * @param context - Editor context with query text
   * @returns Array of suggestion items
   */
  abstract getSuggestions(
    context: EditorSuggestContext
  ): Promise<SuggestionItem<T>[]> | SuggestionItem<T>[];

  /**
   * Render a suggestion item in the dropdown
   * @param item - Suggestion item to render
   * @param el - HTML element to populate
   */
  abstract renderSuggestion(
    item: SuggestionItem<T>,
    el: HTMLElement
  ): void;

  /**
   * Handle selection of a suggestion
   * @param item - Selected suggestion item
   * @param evt - Mouse/keyboard event
   */
  abstract selectSuggestion(
    item: SuggestionItem<T>,
    evt: MouseEvent | KeyboardEvent
  ): void;

  /**
   * Estimate tokens for a specific suggestion item
   * @param item - Suggestion item
   * @returns Estimated token count
   */
  protected abstract estimateItemTokens(item: T): number;

  // ==========================================================================
  // Concrete Methods - Provided by base class
  // ==========================================================================

  /**
   * Trigger detection - called by EditorSuggest on every keystroke
   * Checks if cursor position matches the trigger pattern
   * @param cursor - Current cursor position
   * @param editor - Obsidian editor instance
   * @param file - Current file (may be null)
   * @returns Context if trigger detected, null otherwise
   */
  onTrigger(
    cursor: EditorPosition,
    editor: Editor,
    file: TFile | null
  ): EditorSuggestContext | null {

    const line = editor.getLine(cursor.line);
    const textBeforeCursor = line.substring(0, cursor.ch);

    // Check trigger pattern
    const match = this.config.trigger.exec(textBeforeCursor);

    if (!match) {
      return null;
    }

    // Extract query (everything after trigger character)
    const query = match[1] || '';

    // Calculate trigger start position
    const triggerLength = match[0].length;
    const start: EditorPosition = {
      line: cursor.line,
      ch: cursor.ch - triggerLength
    };

    return {
      query,
      start,
      end: cursor,
      editor
    };
  }

  // ==========================================================================
  // Cache Management
  // ==========================================================================

  /**
   * Get cached data if still valid
   * @param key - Cache key
   * @returns Cached data or null if expired/missing
   */
  protected getCached(key: string): T[] | null {
    const entry = this.cache.get(key);

    if (!entry) {
      return null;
    }

    // Check if cache has expired
    const age = Date.now() - entry.timestamp;
    if (age > this.config.cacheTTL) {
      this.cache.delete(key);
      return null;
    }

    return entry.data;
  }

  /**
   * Store data in cache
   * @param key - Cache key
   * @param data - Data to cache
   */
  protected setCached(key: string, data: T[]): void {
    this.cache.set(key, {
      data,
      timestamp: Date.now()
    });
  }

  /**
   * Clear all cached data
   */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Clear specific cache entry
   * @param key - Cache key to clear
   */
  protected clearCacheEntry(key: string): void {
    this.cache.delete(key);
  }

  // ==========================================================================
  // Token Management
  // ==========================================================================

  /**
   * Estimate tokens for a suggestion item
   * @param item - Suggestion item
   * @returns Estimated token count
   */
  protected estimateTokens(item: SuggestionItem<T>): number {
    if (item.tokens !== undefined) {
      return item.tokens;
    }
    return this.estimateItemTokens(item.data);
  }

  /**
   * Calculate token warning level
   * @param tokens - Current token count
   * @param maxTokens - Maximum allowed tokens
   * @returns Token warning data
   */
  protected getTokenWarning(tokens: number, maxTokens: number): TokenWarning {
    const percentage = (tokens / maxTokens) * 100;

    let level: TokenWarningLevel;
    let message: string;

    if (percentage >= 100) {
      level = TokenWarningLevel.ERROR;
      message = `Exceeds context limit by ${tokens - maxTokens} tokens!`;
    } else if (percentage >= 90) {
      level = TokenWarningLevel.ERROR;
      message = `Context nearly full (${percentage.toFixed(0)}%)`;
    } else if (percentage >= 75) {
      level = TokenWarningLevel.WARNING;
      message = `High context usage (${percentage.toFixed(0)}%)`;
    } else if (percentage >= 50) {
      level = TokenWarningLevel.INFO;
      message = `Moderate context usage (${percentage.toFixed(0)}%)`;
    } else {
      level = TokenWarningLevel.NONE;
      message = '';
    }

    return {
      level,
      message,
      currentTokens: tokens,
      maxTokens,
      percentage
    };
  }

  /**
   * Add token warning badge to suggestion element
   * @param el - HTML element to add badge to
   * @param tokens - Token count
   * @param maxTokens - Maximum allowed tokens
   */
  protected addTokenBadge(el: HTMLElement, tokens: number, maxTokens: number): void {
    const warning = this.getTokenWarning(tokens, maxTokens);

    if (warning.level === TokenWarningLevel.NONE) {
      return;
    }

    const badge = el.createDiv({ cls: `token-badge token-badge-${warning.level}` });
    badge.textContent = `${tokens.toLocaleString()} tokens`;

    if (warning.message) {
      badge.setAttribute('aria-label', warning.message);
      badge.setAttribute('title', warning.message);
    }
  }

  // ==========================================================================
  // Utility Methods
  // ==========================================================================

  /**
   * Clean up resources when suggester is destroyed
   */
  onDestroy(): void {
    this.clearCache();
  }

  /**
   * Limit array to max suggestions
   * @param items - Array of items
   * @returns Sliced array
   */
  protected limitSuggestions(items: SuggestionItem<T>[]): SuggestionItem<T>[] {
    return items.slice(0, this.config.maxSuggestions);
  }

  /**
   * Sort suggestions by score (descending)
   * @param items - Array of items
   * @returns Sorted array
   */
  protected sortByScore(items: SuggestionItem<T>[]): SuggestionItem<T>[] {
    return items.sort((a, b) => b.score - a.score);
  }
}
