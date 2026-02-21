/**
 * ContentEditableSuggester - Base class for contenteditable suggestions
 *
 * Adapted from TextAreaSuggester to work with contenteditable elements
 * using the Selection/Range API instead of textarea's selectionStart/selectionEnd
 */

import { App, Component } from 'obsidian';
import { SuggesterConfig, SuggestionItem } from './base/SuggesterInterfaces';
import { ContentEditableHelper } from '../../utils/ContentEditableHelper';

export abstract class ContentEditableSuggester<T> {
  protected app: App;
  protected element: HTMLElement;
  protected config: SuggesterConfig;
  protected suggestionContainer: HTMLDivElement | null = null;
  protected selectedIndex = 0;
  protected currentSuggestions: SuggestionItem<T>[] = [];
  protected debounceTimer: NodeJS.Timeout | null = null;
  protected isActive = false;
  protected component?: Component;
  private clickOutsideHandler?: (e: MouseEvent) => void;

  constructor(app: App, element: HTMLElement, config: SuggesterConfig, component?: Component) {
    this.app = app;
    this.element = element;
    this.config = config;
    this.component = component;

    this.setupEventListeners();
  }

  /**
   * Get suggestions based on query
   */
  abstract getSuggestions(query: string): Promise<SuggestionItem<T>[]>;

  /**
   * Render a single suggestion item
   */
  abstract renderSuggestion(item: SuggestionItem<T>, el: HTMLElement): void;

  /**
   * Handle suggestion selection
   */
  abstract selectSuggestion(item: SuggestionItem<T>): Promise<void> | void;

  /**
   * Setup event listeners
   */
  private setupEventListeners(): void {
    const inputHandler = () => this.onInput();
    const keydownHandler = (e: KeyboardEvent) => this.onKeyDown(e);

    this.component!.registerDomEvent(this.element, 'input', inputHandler);
    this.component!.registerDomEvent(this.element, 'keydown', keydownHandler);

    // Click outside to close - stored as instance property for cleanup
    this.clickOutsideHandler = (e: MouseEvent) => {
      if (!this.suggestionContainer?.contains(e.target as Node) &&
          e.target !== this.element) {
        setTimeout(() => this.closeSuggestions(), 100);
      }
    };
    this.component!.registerDomEvent(document, 'click', this.clickOutsideHandler);
  }

  /**
   * Handle input event
   */
  private async onInput(): Promise<void> {
    const text = ContentEditableHelper.getPlainText(this.element);
    const cursorPos = ContentEditableHelper.getCursorPosition(this.element);

    // Clear existing debounce timer
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    // Get text before cursor
    const beforeCursor = text.substring(0, cursorPos);
    const match = this.config.trigger.exec(beforeCursor);

    if (!match) {
      this.closeSuggestions();
      return;
    }

    // Extract query from match
    const query = match[1] || '';

    // Debounce the suggestion fetch
    this.debounceTimer = setTimeout(async () => {
      const suggestions = await this.getSuggestions(query);

      if (suggestions.length === 0) {
        this.closeSuggestions();
        return;
      }

      this.currentSuggestions = suggestions;
      this.selectedIndex = 0;
      this.showSuggestions();
    }, this.config.debounceDelay || 100);
  }

  /**
   * Handle keydown events
   */
  private onKeyDown(e: KeyboardEvent): void {
    if (!this.isActive) return;

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        this.selectedIndex = Math.min(
          this.selectedIndex + 1,
          this.currentSuggestions.length - 1
        );
        this.updateSelection();
        break;

      case 'ArrowUp':
        e.preventDefault();
        this.selectedIndex = Math.max(this.selectedIndex - 1, 0);
        this.updateSelection();
        break;

      case 'Enter':
        if (this.currentSuggestions.length > 0) {
          e.preventDefault();
          e.stopPropagation();
          this.selectCurrentSuggestion();
        }
        break;

      case 'Escape':
        e.preventDefault();
        this.closeSuggestions();
        break;
    }
  }

  /**
   * Show suggestions dropdown
   */
  private showSuggestions(): void {
    if (!this.suggestionContainer) {
      this.createSuggestionContainer();
    }

    if (!this.suggestionContainer) return;

    // Clear existing suggestions
    this.suggestionContainer.empty();

    // Render each suggestion
    this.currentSuggestions.forEach((suggestion, index) => {
      const item = this.suggestionContainer!.createDiv('suggester-item');
      if (index === this.selectedIndex) {
        item.addClass('is-selected');
      }

      this.renderSuggestion(suggestion, item);

      // Click to select
      const clickHandler = (e: MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        this.selectedIndex = index;
        this.selectCurrentSuggestion();
      };

      this.component!.registerDomEvent(item, 'click', clickHandler);
    });

    // Position above the input
    this.positionSuggestions();

    this.suggestionContainer.classList.remove('suggester-container-hidden');
    this.suggestionContainer.classList.add('suggester-container-visible');
    this.isActive = true;
  }

  /**
   * Create suggestion container
   */
  private createSuggestionContainer(): void {
    this.suggestionContainer = document.body.createDiv('suggester-container');
    this.suggestionContainer.classList.add('suggester-container-positioned', 'suggester-container-hidden');
  }

  /**
   * Position suggestions above input
   */
  private positionSuggestions(): void {
    if (!this.suggestionContainer) return;

    const rect = this.element.getBoundingClientRect();
    this.suggestionContainer.style.left = rect.left + 'px';
    this.suggestionContainer.style.bottom = (window.innerHeight - rect.top + 4) + 'px';
    this.suggestionContainer.style.width = rect.width + 'px';
  }

  /**
   * Update selection highlight
   */
  private updateSelection(): void {
    if (!this.suggestionContainer) return;

    const items = this.suggestionContainer.querySelectorAll('.suggester-item');
    items.forEach((item, index) => {
      if (index === this.selectedIndex) {
        item.addClass('is-selected');
      } else {
        item.removeClass('is-selected');
      }
    });
  }

  /**
   * Select current suggestion
   */
  private async selectCurrentSuggestion(): Promise<void> {
    const suggestion = this.currentSuggestions[this.selectedIndex];
    if (!suggestion) return;

    await this.selectSuggestion(suggestion);
    this.closeSuggestions();

    // Refocus element
    this.element.focus();
  }

  /**
   * Close suggestions dropdown
   */
  protected closeSuggestions(): void {
    if (this.suggestionContainer) {
      this.suggestionContainer.classList.remove('suggester-container-visible');
      this.suggestionContainer.classList.add('suggester-container-hidden');
    }
    this.isActive = false;
    this.currentSuggestions = [];
    this.selectedIndex = 0;
  }

  /**
   * Check if suggester is currently active
   */
  getIsActive(): boolean {
    return this.isActive;
  }

  /**
   * Destroy suggester and cleanup
   */
  destroy(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    // Note: document click listener cleanup handled by component.registerDomEvent

    if (this.suggestionContainer) {
      this.suggestionContainer.remove();
      this.suggestionContainer = null;
    }

    this.isActive = false;
  }
}
