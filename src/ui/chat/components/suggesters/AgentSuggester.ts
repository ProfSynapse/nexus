/**
 * AgentSuggester - Provides autocomplete for @agent mentions
 * Triggers on @ and suggests custom agents with fuzzy search
 */

import { App, prepareFuzzySearch, setIcon } from 'obsidian';
import { BaseSuggester } from './base/BaseSuggester';
import {
  SuggestionItem,
  EditorSuggestContext,
  AgentSuggestionItem,
  AgentReference,
  EnhancementType
} from './base/SuggesterInterfaces';
import { MessageEnhancer } from '../../services/MessageEnhancer';
import { CustomPromptStorageService } from '../../../../agents/agentManager/services/CustomPromptStorageService';
import { TokenCalculator } from '../../utils/TokenCalculator';

/**
 * Agent suggester for @ mention autocomplete
 */
export class AgentSuggester extends BaseSuggester<AgentSuggestionItem> {

  private messageEnhancer: MessageEnhancer;
  private promptStorage: CustomPromptStorageService;
  private maxTokensPerAgent = 5000; // Warn if agent prompt exceeds this

  constructor(
    app: App,
    messageEnhancer: MessageEnhancer,
    promptStorage: CustomPromptStorageService
  ) {
    super(app, {
      // Matches @ followed by word characters
      trigger: /@(\w*)$/,
      maxSuggestions: 20,
      cacheTTL: 30000, // 30 seconds - agents may be added/edited during chat
      debounceDelay: 100
    });

    this.messageEnhancer = messageEnhancer;
    this.promptStorage = promptStorage;
  }

  // ==========================================================================
  // Abstract Method Implementations
  // ==========================================================================

  /**
   * Get agent suggestions with fuzzy search
   * @param context - Editor context with query
   * @returns Filtered and ranked agent suggestions
   */
  async getSuggestions(
    context: EditorSuggestContext
  ): Promise<SuggestionItem<AgentSuggestionItem>[]> {

    // Get enabled agents only
    const agents = this.promptStorage.getEnabledPrompts();

    if (agents.length === 0) {
      return [];
    }

    // If no query, return all agents (sorted by name)
    if (!context.query || context.query.trim().length === 0) {
      const allSuggestions = agents
        .sort((a, b) => a.name.localeCompare(b.name))
        .slice(0, this.config.maxSuggestions)
        .map(agent => this.createSuggestion(agent, 1.0));

      return allSuggestions;
    }

    // Fuzzy search on agent names and descriptions
    const query = context.query.toLowerCase();
    const fuzzySearch = prepareFuzzySearch(query);

    const suggestions: SuggestionItem<AgentSuggestionItem>[] = [];

    for (const agent of agents) {
      // Try fuzzy match on name first (higher priority)
      const nameMatch = fuzzySearch(agent.name);
      if (nameMatch) {
        suggestions.push(this.createSuggestion(agent, nameMatch.score));
        continue;
      }

      // Try fuzzy match on description (lower priority)
      const descMatch = fuzzySearch(agent.description);
      if (descMatch) {
        suggestions.push(this.createSuggestion(agent, descMatch.score * 0.7));
      }
    }

    // Sort by score and limit
    return this.limitSuggestions(this.sortByScore(suggestions));
  }

  /**
   * Render agent suggestion in dropdown
   * @param item - Agent suggestion item
   * @param el - HTML element to populate
   */
  renderSuggestion(
    item: SuggestionItem<AgentSuggestionItem>,
    el: HTMLElement
  ): void {
    el.addClass('suggester-item', 'agent-suggester-item');

    // Icon
    const icon = el.createDiv({ cls: 'suggester-icon' });
    setIcon(icon, 'bot');

    // Content container
    const content = el.createDiv({ cls: 'suggester-content' });

    // Agent name (primary text)
    const name = content.createDiv({ cls: 'suggester-title' });
    name.textContent = item.data.name;

    // Description (secondary text)
    const desc = content.createDiv({ cls: 'suggester-description' });
    desc.textContent = item.data.description;

    // Token badge
    const badgeContainer = el.createDiv({ cls: 'suggester-badge-container' });

    // Token warning badge if needed
    if (item.data.promptTokens > this.maxTokensPerAgent * 0.75) {
      this.addTokenBadge(badgeContainer, item.data.promptTokens, this.maxTokensPerAgent);
    } else {
      // Just show token count
      const tokenBadge = badgeContainer.createSpan({ cls: 'suggester-badge token-info' });
      tokenBadge.textContent = `~${item.data.promptTokens.toLocaleString()} tokens`;
    }
  }

  /**
   * Handle agent selection
   * @param item - Selected agent
   * @param evt - Selection event
   */
  selectSuggestion(
    item: SuggestionItem<AgentSuggestionItem>,
    evt: MouseEvent | KeyboardEvent
  ): void {

    // Access the context property from EditorSuggest base class
    // This is typed as EditorSuggestContext | null in Obsidian's API
    if (!this.context) return;

    const { editor, start, end } = this.context;

    // Create agent reference
    const agentRef: AgentReference = {
      id: item.data.id,
      name: item.data.name,
      prompt: item.data.prompt,
      tokens: item.data.promptTokens
    };

    // Add to message enhancer
    this.messageEnhancer.addAgent(agentRef);

    // Replace @ mention with agent name (in format that's clear to user)
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
   * Estimate tokens for an agent prompt
   * @param item - Agent data
   * @returns Estimated token count
   */
  protected estimateItemTokens(item: AgentSuggestionItem): number {
    return item.promptTokens;
  }

  // ==========================================================================
  // Helper Methods
  // ==========================================================================

  /**
   * Create suggestion item from CustomPrompt
   * @param agent - Custom prompt data
   * @param score - Match score
   * @returns Suggestion item
   */
  private createSuggestion(
    agent: { id: string; name: string; description: string; prompt: string },
    score: number
  ): SuggestionItem<AgentSuggestionItem> {

    const promptTokens = TokenCalculator.estimateTextTokens(agent.prompt);

    return {
      data: {
        id: agent.id,
        name: agent.name,
        description: agent.description,
        prompt: agent.prompt,
        promptTokens: promptTokens
      },
      score: score,
      displayText: agent.name,
      description: agent.description,
      tokens: promptTokens
    };
  }

  /**
   * Refresh cache when agents are modified
   */
  refreshCache(): void {
    this.clearCache();
  }
}
