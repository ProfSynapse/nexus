/**
 * TextAreaSuggester - Suggestion system for plain HTML textarea
 * Similar to EditorSuggest but works with textarea instead of Obsidian Editor
 */

import { App, Component } from 'obsidian';
import { SuggesterConfig, SuggestionItem } from './base/SuggesterInterfaces';

export abstract class TextAreaSuggester<T> {
  protected app: App;
  protected config: SuggesterConfig;
  protected textarea: HTMLTextAreaElement;
  protected suggestionContainer: HTMLElement | null = null;
  protected suggestions: SuggestionItem<T>[] = [];
  protected selectedIndex = 0;
  protected isActive = false;
  protected component?: Component;

  constructor(app: App, textarea: HTMLTextAreaElement, config: SuggesterConfig, component?: Component) {
    this.app = app;
    this.textarea = textarea;
    this.config = config;
    this.component = component;

    this.attachEventListeners();
  }

  // ==========================================================================
  // Abstract Methods
  // ==========================================================================

  abstract getSuggestions(query: string): Promise<SuggestionItem<T>[]> | SuggestionItem<T>[];
  abstract renderSuggestion(item: SuggestionItem<T>, el: HTMLElement): void;
  abstract selectSuggestion(item: SuggestionItem<T>): void;

  // ==========================================================================
  // Event Listeners
  // ==========================================================================

  private attachEventListeners(): void {
    const inputHandler = this.onInput.bind(this);
    const keydownHandler = this.onKeyDown.bind(this);

    this.component!.registerDomEvent(this.textarea, 'input', inputHandler);
    this.component!.registerDomEvent(this.textarea, 'keydown', keydownHandler);

    // Don't close on blur - let user click suggestions
    // Suggestions will close on selection or Escape key
  }

  private async onInput(): Promise<void> {
    const cursorPos = this.textarea.selectionStart;
    const text = this.textarea.value.substring(0, cursorPos);

    // Check if trigger pattern matches
    const match = this.config.trigger.exec(text);

    if (!match) {
      this.close();
      return;
    }

    const query = match[1] || '';

    // Get suggestions
    this.suggestions = await this.getSuggestions(query);

    if (this.suggestions.length === 0) {
      this.close();
      return;
    }

    // Show suggestions
    this.selectedIndex = 0;
    this.show();
  }

  private onKeyDown(e: KeyboardEvent): void {
    if (!this.isActive) return;

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        this.selectNext();
        break;
      case 'ArrowUp':
        e.preventDefault();
        this.selectPrevious();
        break;
      case 'Enter':
        if (this.isActive) {
          e.preventDefault();
          this.confirmSelection();
        }
        break;
      case 'Escape':
        e.preventDefault();
        this.close();
        break;
    }
  }

  // ==========================================================================
  // Suggestion Management
  // ==========================================================================

  private show(): void {
    if (this.isActive && this.suggestionContainer) {
      // Already showing, just update
      this.renderSuggestions();
      return;
    }

    // Create container
    this.suggestionContainer = document.createElement('div');
    this.suggestionContainer.addClass('suggestion-container', 'suggester-dropdown', 'suggester-container-positioned', 'suggester-dropdown-styled');

    // Position ABOVE textarea (not below)
    const rect = this.textarea.getBoundingClientRect();
    this.suggestionContainer.style.left = rect.left + 'px';
    this.suggestionContainer.style.bottom = (window.innerHeight - rect.top + 4) + 'px';
    this.suggestionContainer.style.width = rect.width + 'px';

    document.body.appendChild(this.suggestionContainer);
    this.isActive = true;

    // Add click-outside handler to close
    // Note: document click handlers can't use registerDomEvent easily, so we add/remove manually
    setTimeout(() => {
      document.addEventListener('click', this.handleClickOutside);
    }, 100);

    this.renderSuggestions();
  }

  private handleClickOutside = (e: MouseEvent): void => {
    if (!this.suggestionContainer) return;

    const target = e.target as Node;
    if (!this.suggestionContainer.contains(target) && target !== this.textarea) {
      this.close();
    }
  };

  private renderSuggestions(): void {
    if (!this.suggestionContainer) return;

    this.suggestionContainer.empty();

    this.suggestions.forEach((suggestion, index) => {
      const el = this.suggestionContainer!.createDiv({
        cls: index === this.selectedIndex ? 'suggester-item is-selected' : 'suggester-item'
      });

      // Render the suggestion using subclass method
      this.renderSuggestion(suggestion, el);

      // Click handler
      const mousedownHandler = (e: MouseEvent) => {
        e.preventDefault(); // Prevent textarea blur
        this.selectedIndex = index;
        this.confirmSelection();
      };

      // Hover handler
      const mouseenterHandler = () => {
        this.selectedIndex = index;
        this.renderSuggestions();
      };

      this.component!.registerDomEvent(el, 'mousedown', mousedownHandler);
      this.component!.registerDomEvent(el, 'mouseenter', mouseenterHandler);
    });
  }

  private selectNext(): void {
    this.selectedIndex = (this.selectedIndex + 1) % this.suggestions.length;
    this.renderSuggestions();
  }

  private selectPrevious(): void {
    this.selectedIndex = (this.selectedIndex - 1 + this.suggestions.length) % this.suggestions.length;
    this.renderSuggestions();
  }

  private confirmSelection(): void {
    if (this.suggestions.length === 0) return;

    const selected = this.suggestions[this.selectedIndex];

    this.selectSuggestion(selected);
    this.close();
  }

  close(): void {
    if (this.suggestionContainer) {
      this.suggestionContainer.remove();
      this.suggestionContainer = null;
    }

    // Remove click-outside handler
    document.removeEventListener('click', this.handleClickOutside);

    this.isActive = false;
    this.suggestions = [];
    this.selectedIndex = 0;
  }

  // ==========================================================================
  // Utility
  // ==========================================================================

  destroy(): void {
    this.close();
    // Event listeners will be cleaned up with textarea
  }
}
