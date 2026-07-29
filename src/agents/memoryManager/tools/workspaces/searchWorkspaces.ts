import { JSONSchema } from '../../../../types/schema/JSONSchemaTypes';
/**
 * Location: src/agents/memoryManager/tools/workspaces/searchWorkspaces.ts
 *
 * Purpose: Find workspaces by name/description/folder fragment instead of
 * listing every workspace. `listWorkspaces` returns the whole inventory, which
 * is a pure context tax when the caller already has a name fragment.
 *
 * Optionally auto-loads the match when the search resolves to exactly one
 * workspace (strict — 0 or 2+ matches never auto-load), saving a round trip.
 *
 * Used by: MemoryManagerAgent
 * Integrates with: WorkspaceService (lightweight index), WorkspaceMatcher
 * (pure scoring), LoadWorkspaceTool (auto-load delegation)
 */

import { BaseTool } from '../../../baseTool';
import type { MemoryManagerAgent } from '../../memoryManager';
import { verbs } from '../../../utils/toolStatusLabels';
import type { ToolStatusTense } from '../../../interfaces/ITool';
import {
  SearchWorkspacesParameters,
  SearchWorkspacesResult,
  SearchWorkspacesMatch
} from '../../../../database/types/workspace/ParameterTypes';
import { matchWorkspaces } from '../../services/WorkspaceMatcher';

const DEFAULT_LIMIT = 10;

/**
 * Tool to search workspaces by free-text query, with opt-in single-match auto-load
 */
export class SearchWorkspacesTool extends BaseTool<SearchWorkspacesParameters, SearchWorkspacesResult> {
  private agent: MemoryManagerAgent;

  constructor(agent: MemoryManagerAgent) {
    super(
      'searchWorkspaces',
      'Search Workspaces',
      'Find workspaces by name, description, or folder without listing them all. Pass --load to auto-load when exactly one workspace matches.',
      '1.0.0'
    );
    this.agent = agent;
  }

  async execute(params: SearchWorkspacesParameters): Promise<SearchWorkspacesResult> {
    const query = typeof params.query === 'string' ? params.query.trim() : '';

    // Schemas are documentation only (no runtime JSON-schema validation), so
    // required-field enforcement has to live here.
    if (!query) {
      return this.buildErrorResult('query is required. Example: memory search-workspaces "research"', '');
    }

    try {
      const workspaceService = await this.agent.getWorkspaceServiceAsync();
      if (!workspaceService) {
        return this.buildErrorResult('WorkspaceService not available', query);
      }

      let workspaces;
      try {
        workspaces = await workspaceService.listWorkspaces();
      } catch (queryError) {
        return this.buildErrorResult(
          `Failed to query workspaces: ${queryError instanceof Error ? queryError.message : String(queryError)}`,
          query
        );
      }

      const includeArchived = params.includeArchived ?? false;
      const allMatches = matchWorkspaces(workspaces, query, { includeArchived });

      // Auto-load is decided on the full match set, never on the truncated one,
      // so `--limit 1` can't manufacture a single match.
      const totalMatches = allMatches.length;

      const limit = typeof params.limit === 'number' && params.limit > 0 ? params.limit : DEFAULT_LIMIT;
      const matches: SearchWorkspacesMatch[] = allMatches.slice(0, limit).map(match => ({
        id: match.workspace.id,
        name: match.workspace.name,
        description: match.workspace.description,
        rootFolder: match.workspace.rootFolder || '',
        lastAccessed: match.workspace.lastAccessed ?? match.workspace.created ?? 0,
        score: Number(match.score.toFixed(3)),
        matchedOn: match.matchedOn
      }));

      const shouldAutoLoad = params.load === true && totalMatches === 1;
      if (shouldAutoLoad) {
        const target = allMatches[0].workspace;
        try {
          const loaded = await this.agent.executeTool('loadWorkspace', {
            workspace: target.id,
            context: params.context,
            workspaceContext: params.workspaceContext
          } as unknown as Record<string, unknown>);

          if (loaded && loaded.success) {
            return {
              success: true,
              data: {
                query,
                matches,
                totalMatches,
                autoLoaded: true,
                workspace: loaded
              }
            };
          }

          // Load failed — still a successful search, so return matches with the
          // failure surfaced rather than swallowing the result.
          return {
            success: true,
            data: {
              query,
              matches,
              totalMatches,
              autoLoaded: false,
              nudge: `Auto-load of '${target.name}' failed (${loaded?.error || 'unknown error'}). Retry with: memory load-workspace --workspace ${target.id}`
            }
          };
        } catch (loadError) {
          return {
            success: true,
            data: {
              query,
              matches,
              totalMatches,
              autoLoaded: false,
              nudge: `Auto-load of '${target.name}' failed (${loadError instanceof Error ? loadError.message : String(loadError)}). Retry with: memory load-workspace --workspace ${target.id}`
            }
          };
        }
      }

      return {
        success: true,
        data: {
          query,
          matches,
          totalMatches,
          autoLoaded: false,
          nudge: this.buildNudge(query, totalMatches, matches, params.load === true)
        }
      };
    } catch (error: unknown) {
      return this.buildErrorResult(
        `Unexpected error: ${error instanceof Error ? error.message : String(error)}`,
        query
      );
    }
  }

  /**
   * Build the next-step steer. These are workspace *locations*, not contents —
   * without this the caller tends to answer from the match list alone.
   */
  private buildNudge(
    query: string,
    totalMatches: number,
    matches: SearchWorkspacesMatch[],
    loadRequested: boolean
  ): string {
    if (totalMatches === 0) {
      return `No workspace matched '${query}'. Try a shorter fragment, or run "memory list-workspaces" to see everything available.`;
    }

    const example = `memory load-workspace --workspace ${matches[0].id}`;

    if (loadRequested && totalMatches > 1) {
      return `${totalMatches} workspaces matched '${query}', so nothing was auto-loaded. These are workspace locations, not contents — pick one and call: ${example}`;
    }

    return `These are workspace locations, not contents. Load one with: ${example}`;
  }

  private buildErrorResult(error: string, query: string): SearchWorkspacesResult {
    return {
      success: false,
      error,
      data: {
        query,
        matches: [],
        totalMatches: 0,
        autoLoaded: false
      }
    };
  }

  getStatusLabel(_params: Record<string, unknown> | undefined, tense: ToolStatusTense): string | undefined {
    const v = verbs('Searching workspaces', 'Searched workspaces', 'Failed to search workspaces');
    return v[tense];
  }

  getParameterSchema(): JSONSchema {
    const toolSchema = {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Free-text query matched against workspace name, description, folder, and id. Partial words work (e.g. "resear" matches "Research").'
        },
        load: {
          type: 'boolean',
          description: 'Auto-load the workspace when the search matches exactly one (default: false). With 0 or 2+ matches nothing is loaded and the match list is returned instead.'
        },
        limit: {
          type: 'number',
          description: `Maximum matches to return (default: ${DEFAULT_LIMIT}). Does not affect the auto-load decision, which uses the full match count.`
        },
        includeArchived: {
          type: 'boolean',
          description: 'Include archived workspaces in the search (default: false)'
        }
      },
      required: ['query']
    };

    return this.getMergedSchema(toolSchema);
  }

  getResultSchema(): JSONSchema {
    return {
      type: 'object',
      properties: {
        success: {
          type: 'boolean',
          description: 'Whether the operation was successful'
        },
        error: {
          type: 'string',
          description: 'Error message if operation failed'
        },
        data: {
          type: 'object',
          description: 'Search results',
          properties: {
            query: {
              type: 'string',
              description: 'The query that was searched'
            },
            matches: {
              type: 'array',
              description: 'Matching workspaces, best first',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string', description: 'Workspace id — pass this to loadWorkspace' },
                  name: { type: 'string', description: 'Workspace name' },
                  description: { type: 'string', description: 'Workspace description' },
                  rootFolder: { type: 'string', description: 'Workspace root folder' },
                  lastAccessed: { type: 'number', description: 'Last accessed timestamp' },
                  score: { type: 'number', description: 'Relevance score (higher is better)' },
                  matchedOn: {
                    type: 'array',
                    description: 'Fields that matched the query',
                    items: { type: 'string' }
                  }
                },
                required: ['id', 'name', 'rootFolder', 'score']
              }
            },
            totalMatches: {
              type: 'number',
              description: 'Total matches before the limit was applied'
            },
            autoLoaded: {
              type: 'boolean',
              description: 'Whether the single match was auto-loaded'
            },
            workspace: {
              type: 'object',
              description: 'Full loadWorkspace payload, present only when autoLoaded is true'
            },
            nudge: {
              type: 'string',
              description: 'Suggested next step when nothing was auto-loaded'
            }
          },
          required: ['query', 'matches', 'totalMatches', 'autoLoaded']
        }
      },
      required: ['success']
    };
  }
}
