/**
 * WorkspaceSuggester - Provides autocomplete for #workspace mentions
 * Triggers on # and suggests workspaces with fuzzy search
 */

import { App, prepareFuzzySearch, setIcon } from 'obsidian';
import { BaseSuggester } from './base/BaseSuggester';
import {
  SuggestionItem,
  EditorSuggestContext,
  WorkspaceSuggestionItem,
  WorkspaceReference,
  EnhancementType
} from './base/SuggesterInterfaces';
import { MessageEnhancer } from '../../services/MessageEnhancer';
import { WorkspaceService } from '../../../../services/WorkspaceService';

/**
 * Workspace suggester for # mention autocomplete
 */
export class WorkspaceSuggester extends BaseSuggester<WorkspaceSuggestionItem> {

  private messageEnhancer: MessageEnhancer;
  private workspaceService: WorkspaceService;

  constructor(
    app: App,
    messageEnhancer: MessageEnhancer,
    workspaceService: WorkspaceService
  ) {
    super(app, {
      // Matches # followed by word characters
      trigger: /#(\w*)$/,
      maxSuggestions: 20,
      cacheTTL: 30000, // 30 seconds
      debounceDelay: 100
    });

    this.messageEnhancer = messageEnhancer;
    this.workspaceService = workspaceService;
  }

  // ==========================================================================
  // Abstract Method Implementations
  // ==========================================================================

  /**
   * Get workspace suggestions with fuzzy search
   * @param context - Editor context with query
   * @returns Filtered and ranked workspace suggestions
   */
  async getSuggestions(
    context: EditorSuggestContext
  ): Promise<SuggestionItem<WorkspaceSuggestionItem>[]> {

    // Get workspaces sorted by last accessed
    const workspaces = await this.workspaceService.listWorkspaces();

    if (workspaces.length === 0) {
      return [];
    }

    // If no query, return all workspaces (sorted by last accessed)
    if (!context.query || context.query.trim().length === 0) {
      const allSuggestions = workspaces
        .slice(0, this.config.maxSuggestions)
        .map(workspace => this.createSuggestion(workspace, 1.0));

      return allSuggestions;
    }

    // Fuzzy search on workspace names and descriptions
    const query = context.query.toLowerCase();
    const fuzzySearch = prepareFuzzySearch(query);

    const suggestions: SuggestionItem<WorkspaceSuggestionItem>[] = [];

    for (const workspace of workspaces) {
      // Try fuzzy match on name first (higher priority)
      const nameMatch = fuzzySearch(workspace.name);
      if (nameMatch) {
        suggestions.push(this.createSuggestion(workspace, nameMatch.score));
        continue;
      }

      // Try fuzzy match on description (lower priority)
      if (workspace.description) {
        const descMatch = fuzzySearch(workspace.description);
        if (descMatch) {
          suggestions.push(this.createSuggestion(workspace, descMatch.score * 0.7));
        }
      }
    }

    // Sort by score and limit
    return this.limitSuggestions(this.sortByScore(suggestions));
  }

  /**
   * Render workspace suggestion in dropdown
   * @param item - Workspace suggestion item
   * @param el - HTML element to populate
   */
  renderSuggestion(
    item: SuggestionItem<WorkspaceSuggestionItem>,
    el: HTMLElement
  ): void {
    el.addClass('suggester-item', 'workspace-suggester-item');

    // Icon
    const icon = el.createDiv({ cls: 'suggester-icon' });
    setIcon(icon, 'folder-tree');

    // Content container
    const content = el.createDiv({ cls: 'suggester-content' });

    // Workspace name (primary text)
    const name = content.createDiv({ cls: 'suggester-title' });
    name.textContent = item.data.name;

    // Description or root folder (secondary text)
    const desc = content.createDiv({ cls: 'suggester-description' });
    desc.textContent = item.data.description || item.data.rootFolder;
  }

  /**
   * Handle workspace selection
   * @param item - Selected workspace
   * @param evt - Selection event
   */
  selectSuggestion(
    item: SuggestionItem<WorkspaceSuggestionItem>,
    evt: MouseEvent | KeyboardEvent
  ): void {

    const context = this.context;
    if (!context) return;

    const { editor, start, end } = context;

    // Create workspace reference
    const workspaceRef: WorkspaceReference = {
      id: item.data.id,
      name: item.data.name,
      description: item.data.description,
      rootFolder: item.data.rootFolder
    };

    // Add to message enhancer
    this.messageEnhancer.addWorkspace(workspaceRef);

    // Replace # mention with workspace name (in format that's clear to user)
    const replacement = `#${item.data.name.replace(/\s+/g, '_')}`;

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

  // ==========================================================================
  // Helper Methods
  // ==========================================================================

  /**
   * Create suggestion item from workspace metadata
   * @param workspace - Workspace metadata
   * @param score - Match score
   * @returns Suggestion item
   */
  private createSuggestion(
    workspace: { id: string; name: string; description?: string; rootFolder: string; lastAccessed: number },
    score: number
  ): SuggestionItem<WorkspaceSuggestionItem> {

    return {
      data: {
        id: workspace.id,
        name: workspace.name,
        description: workspace.description,
        rootFolder: workspace.rootFolder,
        lastAccessed: workspace.lastAccessed
      },
      score: score,
      displayText: workspace.name,
      description: workspace.description || workspace.rootFolder
    };
  }

  /**
   * Estimate tokens for a workspace item
   * @param item - Workspace suggestion item
   * @returns Estimated token count (0 for workspace references)
   */
  protected estimateItemTokens(item: WorkspaceSuggestionItem): number {
    // Workspace references don't directly add tokens until context is loaded
    // Token estimation will happen when the full workspace is loaded
    return 0;
  }

  /**
   * Refresh cache when workspaces are modified
   */
  refreshCache(): void {
    this.clearCache();
  }
}
