/**
 * TextAreaToolSuggester - Tool suggester for textarea
 */

import { App, Plugin, prepareFuzzySearch, setIcon, Component } from 'obsidian';
import { ContentEditableSuggester } from './ContentEditableSuggester';
import { ContentEditableHelper } from '../../utils/ContentEditableHelper';
import {
  SuggestionItem,
  ToolSuggestionItem,
  ToolHint
} from './base/SuggesterInterfaces';
import { MessageEnhancer } from '../../services/MessageEnhancer';
import { formatToolDisplayName } from '../../../../utils/toolNameUtils';
import { getNexusPlugin } from '../../../../utils/pluginLocator';
import { IAgent } from '../../../../agents/interfaces/IAgent';

/**
 * Extended plugin interface with MCP connector structure
 */
interface PluginWithConnector extends Plugin {
  connector?: {
    agentRegistry?: {
      getAllAgents(): Map<string, IAgent>;
    };
  };
}

export class TextAreaToolSuggester extends ContentEditableSuggester<ToolSuggestionItem> {
  private messageEnhancer: MessageEnhancer;
  private cachedTools: ToolSuggestionItem[] | null = null;

  constructor(
    app: App,
    element: HTMLElement,
    messageEnhancer: MessageEnhancer,
    component?: Component
  ) {
    super(app, element, {
      trigger: /\/(\w*)$/,
      maxSuggestions: 30,
      cacheTTL: 120000,
      debounceDelay: 100
    }, component);

    this.messageEnhancer = messageEnhancer;
  }

  /**
   * Load tools from plugin
   */
  private async loadTools(): Promise<void> {
    try {
      const plugin = getNexusPlugin<PluginWithConnector>(this.app);
      if (!plugin) {
        return;
      }

      // Get agents from connector's agent registry
      if (!plugin.connector?.agentRegistry) {
        return;
      }

      const agents = plugin.connector.agentRegistry.getAllAgents();
      if (!agents || agents.size === 0) {
        return;
      }

      // Extract individual tools from each agent
      this.cachedTools = [];

      for (const agent of Array.from(agents.values())) {
        const tools = agent.getTools();

        for (const tool of tools) {
          const toolName = `${agent.name}.${tool.slug}`;

          this.cachedTools.push({
            name: toolName, // Technical name: "storageManager.list"
            displayName: formatToolDisplayName(toolName), // "Read File"
            description: tool.description || `Execute ${tool.slug} on ${agent.name}`,
            category: agent.name,
            schema: {
              name: toolName,
              description: tool.description || `Execute ${tool.slug}`,
              inputSchema: tool.getParameterSchema?.() || {}
            }
          });
        }
      }
    } catch (error) {
      // Failed to load tools
    }
  }

  async getSuggestions(query: string): Promise<SuggestionItem<ToolSuggestionItem>[]> {

    // Wait for tools to load if not yet loaded
    if (!this.cachedTools) {
      await this.loadTools();
    }

    if (!this.cachedTools || this.cachedTools.length === 0) {
      return [];
    }

    // If no query, return all tools sorted by display name
    if (!query || query.trim().length === 0) {
      return this.cachedTools
        .slice(0, this.config.maxSuggestions)
        .map(tool => this.createSuggestion(tool, 1.0));
    }

    const fuzzySearch = prepareFuzzySearch(query.toLowerCase());
    const suggestions: SuggestionItem<ToolSuggestionItem>[] = [];

    for (const tool of this.cachedTools) {
      // Try fuzzy match on display name first (highest priority)
      const displayName = tool.displayName || tool.name;
      const displayMatch = fuzzySearch(displayName);
      if (displayMatch) {
        suggestions.push(this.createSuggestion(tool, displayMatch.score));
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

    return suggestions
      .sort((a, b) => b.score - a.score)
      .slice(0, this.config.maxSuggestions);
  }

  renderSuggestion(item: SuggestionItem<ToolSuggestionItem>, el: HTMLElement): void {
    el.addClass('tool-suggester-item');

    const icon = el.createDiv({ cls: 'suggester-icon' });
    setIcon(icon, 'wrench');

    const content = el.createDiv({ cls: 'suggester-content' });

    // Show display name (e.g., "Read File") instead of technical name
    const displayName = item.data.displayName || item.data.name;
    content.createDiv({ cls: 'suggester-title', text: displayName });
    content.createDiv({ cls: 'suggester-description', text: item.data.description });
  }

  selectSuggestion(item: SuggestionItem<ToolSuggestionItem>): void {
    // Add to message enhancer
    const toolHint: ToolHint = {
      name: item.data.name,
      schema: item.data.schema
    };
    this.messageEnhancer.addTool(toolHint);

    // Replace /command with styled reference badge
    const cursorPos = ContentEditableHelper.getCursorPosition(this.element);
    const text = ContentEditableHelper.getPlainText(this.element);
    const beforeCursor = text.substring(0, cursorPos);
    const match = /\/(\w*)$/.exec(beforeCursor);

    if (match) {
      const start = cursorPos - match[0].length;
      const displayName = item.data.displayName || item.data.name;

      // Delete the trigger text
      ContentEditableHelper.deleteTextAtCursor(this.element, start, cursorPos);

      // Insert styled reference
      ContentEditableHelper.insertReferenceNode(
        this.element,
        'tool',
        `/${displayName.replace(/\s+/g, '')}`,
        item.data.name
      );
    }
  }

  private createSuggestion(
    tool: ToolSuggestionItem,
    score: number
  ): SuggestionItem<ToolSuggestionItem> {
    return {
      data: tool,
      score: score,
      displayText: tool.name,
      description: tool.description,
      tokens: 150
    };
  }
}
