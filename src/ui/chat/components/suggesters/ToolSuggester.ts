/**
 * ToolSuggester - Provides autocomplete for / tool commands
 * Triggers on / and suggests available MCP tools with fuzzy search
 */

import { App, prepareFuzzySearch, setIcon } from 'obsidian';
import { BaseSuggester } from './base/BaseSuggester';
import {
  SuggestionItem,
  EditorSuggestContext,
  ToolSuggestionItem,
  ToolHint,
  ToolSchema,
  EnhancementType
} from './base/SuggesterInterfaces';
import { MessageEnhancer } from '../../services/MessageEnhancer';
import { ToolListService } from '../../../../handlers/services/ToolListService';
import { IAgent } from '../../../../agents/interfaces/IAgent';

/**
 * Tool suggester for / command autocomplete
 */
export class ToolSuggester extends BaseSuggester<ToolSuggestionItem> {

  private messageEnhancer: MessageEnhancer;
  private toolListService: ToolListService;
  private getAgents: () => Map<string, IAgent>;
  private isVaultEnabled: () => boolean;
  private getVaultName: () => string | undefined;

  constructor(
    app: App,
    messageEnhancer: MessageEnhancer,
    toolListService: ToolListService,
    getAgents: () => Map<string, IAgent>,
    isVaultEnabled: () => boolean,
    getVaultName: () => string | undefined
  ) {
    super(app, {
      // Matches / at start of line followed by word characters
      trigger: /^\/(\w*)$/,
      maxSuggestions: 30,
      cacheTTL: 120000, // 2 minutes - tools don't change often
      debounceDelay: 100
    });

    this.messageEnhancer = messageEnhancer;
    this.toolListService = toolListService;
    this.getAgents = getAgents;
    this.isVaultEnabled = isVaultEnabled;
    this.getVaultName = getVaultName;
  }

  // ==========================================================================
  // Abstract Method Implementations
  // ==========================================================================

  /**
   * Get tool suggestions with fuzzy search
   * @param context - Editor context with query
   * @returns Filtered and ranked tool suggestions
   */
  async getSuggestions(
    context: EditorSuggestContext
  ): Promise<SuggestionItem<ToolSuggestionItem>[]> {

    // Check cache first
    let tools = this.getCached('tools');

    if (!tools) {
      // Fetch tools from service
      const toolData = await this.toolListService.generateToolList(
        this.getAgents(),
        this.isVaultEnabled(),
        this.getVaultName()
      );

      tools = toolData.tools.map(tool => this.convertToToolItem(tool));
      this.setCached('tools', tools);
    }

    if (tools.length === 0) {
      return [];
    }

    // If no query, return all tools (sorted by name)
    if (!context.query || context.query.trim().length === 0) {
      const allSuggestions = tools
        .sort((a, b) => a.name.localeCompare(b.name))
        .slice(0, this.config.maxSuggestions)
        .map(tool => this.createSuggestion(tool, 1.0));

      return allSuggestions;
    }

    // Fuzzy search on tool names and descriptions
    const query = context.query.toLowerCase();
    const fuzzySearch = prepareFuzzySearch(query);

    const suggestions: SuggestionItem<ToolSuggestionItem>[] = [];

    for (const tool of tools) {
      // Try fuzzy match on name first (highest priority)
      const nameMatch = fuzzySearch(tool.name);
      if (nameMatch) {
        suggestions.push(this.createSuggestion(tool, nameMatch.score));
        continue;
      }

      // Try fuzzy match on category (medium priority)
      const categoryMatch = fuzzySearch(tool.category);
      if (categoryMatch) {
        suggestions.push(this.createSuggestion(tool, categoryMatch.score * 0.8));
        continue;
      }

      // Try fuzzy match on description (lower priority)
      const descMatch = fuzzySearch(tool.description);
      if (descMatch) {
        suggestions.push(this.createSuggestion(tool, descMatch.score * 0.6));
      }
    }

    // Sort by score and limit
    return this.limitSuggestions(this.sortByScore(suggestions));
  }

  /**
   * Render tool suggestion in dropdown
   * @param item - Tool suggestion item
   * @param el - HTML element to populate
   */
  renderSuggestion(
    item: SuggestionItem<ToolSuggestionItem>,
    el: HTMLElement
  ): void {
    el.addClass('suggester-item', 'tool-suggester-item');

    // Icon
    const icon = el.createDiv({ cls: 'suggester-icon' });
    setIcon(icon, 'wrench');

    // Content container
    const content = el.createDiv({ cls: 'suggester-content' });

    // Tool name (primary text)
    const name = content.createDiv({ cls: 'suggester-title' });
    name.textContent = item.data.name;

    // Description (secondary text)
    const desc = content.createDiv({ cls: 'suggester-description' });
    desc.textContent = item.data.description;

    // Badge container
    const badgeContainer = el.createDiv({ cls: 'suggester-badge-container' });

    // Category badge
    const categoryBadge = badgeContainer.createSpan({ cls: 'suggester-badge category-badge' });
    categoryBadge.textContent = item.data.category;
  }

  /**
   * Handle tool selection
   * @param item - Selected tool
   * @param evt - Selection event
   */
  selectSuggestion(
    item: SuggestionItem<ToolSuggestionItem>,
    evt: MouseEvent | KeyboardEvent
  ): void {

    if (!this.context) return;

    const { editor, start, end } = this.context;

    // Create tool hint
    const toolHint: ToolHint = {
      name: item.data.name,
      schema: item.data.schema
    };

    // Add to message enhancer
    this.messageEnhancer.addTool(toolHint);

    // Replace / command with cleaned text (remove slash)
    // User intent is clear from the tool hint, so just leave the rest of the message
    editor.replaceRange(
      '', // Remove the /command part
      start,
      end
    );

    // Keep cursor at same position (slash is removed)
    editor.setCursor(start);
  }

  /**
   * Estimate tokens for a tool schema
   * @param item - Tool data
   * @returns Estimated token count
   */
  protected estimateItemTokens(item: ToolSuggestionItem): number {
    // Tool schemas are typically ~150 tokens
    return 150;
  }

  // ==========================================================================
  // Helper Methods
  // ==========================================================================

  /**
   * Convert raw tool data to ToolSuggestionItem
   * @param tool - Raw tool from ToolListService
   * @returns ToolSuggestionItem
   */
  private convertToToolItem(tool: any): ToolSuggestionItem {
    // Extract category from tool name (e.g., "vaultManager.readFile" -> "vaultManager")
    const parts = tool.name.split('.');
    const category = parts.length > 1 ? parts[0] : 'general';

    return {
      name: tool.name,
      description: tool.description,
      category: category,
      schema: {
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema
      }
    };
  }

  /**
   * Create suggestion item from ToolSuggestionItem
   * @param tool - Tool data
   * @param score - Match score
   * @returns Suggestion item
   */
  private createSuggestion(
    tool: ToolSuggestionItem,
    score: number
  ): SuggestionItem<ToolSuggestionItem> {

    return {
      data: tool,
      score: score,
      displayText: tool.name,
      description: tool.description,
      tokens: 150 // Standard tool schema size
    };
  }

  /**
   * Refresh tool cache (call when tools may have changed)
   */
  refreshCache(): void {
    this.clearCacheEntry('tools');
  }
}
