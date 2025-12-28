/**
 * TextAreaPromptSuggester - Prompt suggester for textarea
 */

import { App, prepareFuzzySearch, setIcon, Component } from 'obsidian';
import { ContentEditableSuggester } from './ContentEditableSuggester';
import { ContentEditableHelper } from '../../utils/ContentEditableHelper';
import {
  SuggestionItem,
  PromptSuggestionItem,
  PromptReference
} from './base/SuggesterInterfaces';
import { MessageEnhancer } from '../../services/MessageEnhancer';
import { CustomPromptStorageService } from '../../../../agents/promptManager/services/CustomPromptStorageService';
import { TokenCalculator } from '../../utils/TokenCalculator';

export class TextAreaPromptSuggester extends ContentEditableSuggester<PromptSuggestionItem> {
  private messageEnhancer: MessageEnhancer;
  private promptStorage: CustomPromptStorageService;
  private maxTokensPerPrompt = 5000;

  constructor(
    app: App,
    element: HTMLElement,
    messageEnhancer: MessageEnhancer,
    promptStorage: CustomPromptStorageService,
    component?: Component
  ) {
    super(app, element, {
      trigger: /@(\w*)$/,
      maxSuggestions: 20,
      cacheTTL: 30000,
      debounceDelay: 100
    }, component);

    this.messageEnhancer = messageEnhancer;
    this.promptStorage = promptStorage;
  }

  async getSuggestions(query: string): Promise<SuggestionItem<PromptSuggestionItem>[]> {
    const prompts = this.promptStorage.getEnabledPrompts();

    if (prompts.length === 0) {
      return [];
    }

    if (!query || query.trim().length === 0) {
      return prompts
        .sort((a, b) => a.name.localeCompare(b.name))
        .slice(0, this.config.maxSuggestions)
        .map(prompt => this.createSuggestion(prompt, 1.0));
    }

    const fuzzySearch = prepareFuzzySearch(query.toLowerCase());
    const suggestions: SuggestionItem<PromptSuggestionItem>[] = [];

    for (const prompt of prompts) {
      const nameMatch = fuzzySearch(prompt.name);
      if (nameMatch) {
        suggestions.push(this.createSuggestion(prompt, nameMatch.score));
        continue;
      }

      const descMatch = fuzzySearch(prompt.description);
      if (descMatch) {
        suggestions.push(this.createSuggestion(prompt, descMatch.score * 0.7));
      }
    }

    return suggestions
      .sort((a, b) => b.score - a.score)
      .slice(0, this.config.maxSuggestions);
  }

  renderSuggestion(item: SuggestionItem<PromptSuggestionItem>, el: HTMLElement): void {
    el.addClass('prompt-suggester-item');

    const icon = el.createDiv({ cls: 'suggester-icon' });
    setIcon(icon, 'bot');

    const content = el.createDiv({ cls: 'suggester-content' });
    content.createDiv({ cls: 'suggester-title', text: item.data.name });
    content.createDiv({ cls: 'suggester-description', text: item.data.description });

    const badgeContainer = el.createDiv({ cls: 'suggester-badge-container' });
    const tokenBadge = badgeContainer.createSpan({ cls: 'suggester-badge token-info' });
    tokenBadge.textContent = `~${item.data.promptTokens.toLocaleString()} tokens`;
  }

  selectSuggestion(item: SuggestionItem<PromptSuggestionItem>): void {
    // Add to message enhancer
    const promptRef: PromptReference = {
      id: item.data.id,
      name: item.data.name,
      prompt: item.data.prompt,
      tokens: item.data.promptTokens
    };
    this.messageEnhancer.addPrompt(promptRef);

    // Replace @ with styled reference badge
    const cursorPos = ContentEditableHelper.getCursorPosition(this.element);
    const text = ContentEditableHelper.getPlainText(this.element);
    const beforeCursor = text.substring(0, cursorPos);
    const match = /@(\w*)$/.exec(beforeCursor);

    if (match) {
      const start = cursorPos - match[0].length;

      // Delete the trigger text
      ContentEditableHelper.deleteTextAtCursor(this.element, start, cursorPos);

      // Insert styled reference
      ContentEditableHelper.insertReferenceNode(
        this.element,
        'prompt',
        `@${item.data.name.replace(/\s+/g, '_')}`,
        item.data.id
      );
    }
  }

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
}
