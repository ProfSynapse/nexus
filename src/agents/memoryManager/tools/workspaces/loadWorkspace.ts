import { JSONSchema } from '../../../../types/schema/JSONSchemaTypes';
/**
 * Location: /src/agents/memoryManager/modes/workspaces/LoadWorkspaceMode.ts
 * Purpose: Consolidated workspace loading mode for MemoryManager
 *
 * This file handles loading a workspace by ID and restoring workspace context
 * and state for the user session. It automatically collects all files in the
 * workspace directory recursively and provides comprehensive workspace information.
 *
 * Used by: MemoryManager agent for workspace loading operations
 * Integrates with: WorkspaceService for accessing workspace data
 * Refactored: Now uses dedicated services for data fetching, agent resolution,
 *             context building, and file collection following SOLID principles
 */

import { BaseTool } from '../../../baseTool';
import type { MemoryManagerAgent } from '../../memoryManager';
import { labelWithId, verbs } from '../../../utils/toolStatusLabels';
import type { ToolStatusTense } from '../../../interfaces/ITool';
import {
  LoadWorkspaceParameters,
  LoadWorkspaceResult,
  WorkspaceResolutionReport
} from '../../../../database/types/workspace/ParameterTypes';
import { ProjectWorkspace, WorkspaceWorkflow } from '../../../../database/types/workspace/WorkspaceTypes';
import { IndividualWorkspace } from '../../../../types/storage/StorageTypes';
import { parseWorkspaceContext } from '../../../../utils/contextUtils';
import { createErrorMessage } from '../../../../utils/errorUtils';
import { PaginationParams } from '../../../../types/pagination/PaginationTypes';

// Import refactored services
import { WorkspaceDataFetcher } from '../../services/WorkspaceDataFetcher';
import { WorkspacePromptResolver } from '../../services/WorkspacePromptResolver';
import { WorkspaceContextBuilder } from '../../services/WorkspaceContextBuilder';
import { WorkspaceFileCollector } from '../../services/WorkspaceFileCollector';
import { resolveWorkspaceIdentifier } from '../../services/WorkspaceMatcher';
import type { WorkspaceTaskSummary } from '../../../taskManager/types';
import type { WorkspaceMetadata } from '../../../../types/storage/StorageTypes';
import type { WorkspaceService } from '../../../../services/WorkspaceService';

/** Workspace names listed back to the caller when nothing matched at all. */
const MAX_LISTED_WORKSPACES = 25;

/**
 * Mode to load and restore a workspace by ID
 * Automatically collects all files in the workspace directory and provides complete workspace information
 *
 * Follows SOLID principles with service composition:
 * - WorkspaceDataFetcher: Handles session and state data retrieval
 * - WorkspacePromptResolver: Resolves workspace prompts (custom prompts)
 * - WorkspaceContextBuilder: Builds context briefings and workflows
 * - WorkspaceFileCollector: Collects and organizes workspace files
 */
export class LoadWorkspaceTool extends BaseTool<LoadWorkspaceParameters, LoadWorkspaceResult> {
  private agent: MemoryManagerAgent;

  // Composed services following Dependency Inversion Principle
  private dataFetcher: WorkspaceDataFetcher;
  private promptResolver: WorkspacePromptResolver;
  private contextBuilder: WorkspaceContextBuilder;
  private fileCollector: WorkspaceFileCollector;

  /**
   * Create a new LoadWorkspaceMode for the consolidated MemoryManager
   * @param agent The MemoryManagerAgent instance
   */
  constructor(agent: MemoryManagerAgent) {
    super(
      'loadWorkspace',
      'Load Workspace',
      'Load a workspace by name or ID and restore its context and state. Pass a name you have actually seen (getTools workspace list, search-workspaces, list-workspaces) — never one inferred from the user\'s wording.',
      '2.1.0'
    );
    this.agent = agent;

    // Initialize composed services
    this.dataFetcher = new WorkspaceDataFetcher();
    this.promptResolver = new WorkspacePromptResolver(
      agent.getApp(),
      agent.plugin as ConstructorParameters<typeof WorkspacePromptResolver>[1],
      agent.customPromptStorage
    );
    this.contextBuilder = new WorkspaceContextBuilder();
    this.fileCollector = new WorkspaceFileCollector();
  }

  /**
   * Execute the mode to load a workspace
   * @param params Mode parameters
   * @returns Promise resolving to the result
   */
  async execute(params: LoadWorkspaceParameters): Promise<LoadWorkspaceResult> {
    const startTime = Date.now();

    try {
      // Get workspace service from agent
      const workspaceService = await this.agent.getWorkspaceServiceAsync();
      if (!workspaceService) {
        console.error('[LoadWorkspaceMode] WorkspaceService not available');
        return this.createErrorResult('WorkspaceService not available', params);
      }

      // Get the workspace by ID or name (unified lookup)
      const limit = params.limit ?? 5;

      if (workspaceService.isSystemWorkspaceId(params.workspace)) {
        const systemWorkspace = await workspaceService.loadSystemGuidesWorkspace(limit);
        if (!systemWorkspace) {
          return this.createErrorResult(`Workspace '${params.workspace}' is unavailable`, params);
        }

        return {
          success: true,
          data: systemWorkspace.data,
          workspaceContext: systemWorkspace.workspaceContext,
          pagination: {
            sessions: {
              page: 0,
              pageSize: limit,
              totalItems: 0,
              totalPages: 0,
              hasNextPage: false,
              hasPreviousPage: false
            },
            states: {
              page: 0,
              pageSize: limit,
              totalItems: 0,
              totalPages: 0,
              hasNextPage: false,
              hasPreviousPage: false
            }
          }
        };
      }

      let workspace: IndividualWorkspace | null = null;
      try {
        workspace = await workspaceService.getWorkspaceByNameOrId(params.workspace);
      } catch (queryError) {
        console.error('[LoadWorkspaceMode] Failed to load workspace:', queryError);
        return this.createErrorResult(
          `Failed to load workspace: ${queryError instanceof Error ? queryError.message : String(queryError)}`,
          params
        );
      }

      // Exact lookup missed. Rather than dead-ending (which is what sends
      // agents into retry loops on invented names), fall back to fuzzy
      // resolution: load the obvious single candidate, or hand back a ranked
      // shortlist so the next call is guaranteed to be a real workspace.
      let resolution: WorkspaceResolutionReport | undefined;
      if (!workspace) {
        const recovered = await this.recoverFromMiss(workspaceService, params);
        if (!recovered.workspace) {
          console.error('[LoadWorkspaceMode] Workspace not found:', params.workspace);
          return this.createErrorResult(recovered.report.note, params, recovered.report);
        }
        workspace = recovered.workspace;
        resolution = recovered.report;
      }

      const projectWorkspace = workspace as ProjectWorkspace;

      // Update last accessed timestamp (use actual workspace ID, not the identifier)
      try {
        await workspaceService.updateLastAccessed(projectWorkspace.id);
      } catch {
        // Continue - this is not critical
      }

      // Get memory service for data operations
      const memoryService = this.agent.getMemoryService();

      // Build context using services
      const context = await this.contextBuilder.buildContextBriefing(
        projectWorkspace,
        memoryService,
        limit
      );

      const workflows = this.contextBuilder.buildWorkflows(projectWorkspace);
      const workflowDefinitions = (projectWorkspace.context?.workflows || []).map((workflow: WorkspaceWorkflow) => ({
        ...workflow
      }));
      const keyFiles = this.contextBuilder.extractKeyFiles(projectWorkspace);
      const preferences = this.contextBuilder.buildPreferences(projectWorkspace);

      // Pagination options for database queries (page 0, pageSize = limit)
      const paginationOptions: PaginationParams = {
        page: 0,
        pageSize: limit
      };

      // Fetch sessions and states using data fetcher with pagination
      const sessionsResult = await this.dataFetcher.fetchWorkspaceSessions(
        workspace.id,
        // same workspace id, projectWorkspace for downstream typing
        memoryService,
        paginationOptions
      );
      const limitedSessions = sessionsResult.items;

      const statesResult = await this.dataFetcher.fetchWorkspaceStates(
        workspace.id,
        memoryService,
        paginationOptions
      );
      const limitedStates = statesResult.items;

      // Fetch prompt data using prompt resolver
      const app = this.agent.getApp();
      const workspacePrompt = this.promptResolver.fetchWorkspacePrompt(projectWorkspace, app);

      // Fetch task summary if TaskManager is available
      let taskSummary: WorkspaceTaskSummary | null = null;
      try {
        const taskService = this.agent.getTaskService?.();
        if (taskService) {
          taskSummary = await taskService.getWorkspaceSummary(workspace.id);
        }
      } catch { /* TaskManager not initialized — skip */ }

      // Collect files using file collector
      const cacheManager = this.agent.getCacheManager();
      const recentFiles = this.fileCollector.getRecentFilesInWorkspace(workspace, cacheManager, app);

      // Build workspace structure using file collector
      // recursive defaults to false (top-level only)
      const recursive = params.recursive ?? false;
      const workspacePathResult = this.fileCollector.buildWorkspacePath(
        workspace.rootFolder,
        // workspace uses IndividualWorkspace shape but rootFolder is identical
        app,
        recursive
      );
      const workspaceStructure = workspacePathResult.path?.files || [];
      const workspaceContext = {
        workspaceId: workspace.id,
        workspacePath: workspaceStructure  // Use string[] not WorkspacePath object
      };

      const result: LoadWorkspaceResult = {
        success: true,
        data: {
          context,
          workflows,
          workflowDefinitions,
          workspaceStructure,
          recentFiles,
          keyFiles,
          preferences,
          sessions: limitedSessions,
          states: limitedStates,
          ...(workspacePrompt ? { prompt: workspacePrompt } : {}),
          ...(taskSummary !== null ? { taskSummary } : {})
        },
        pagination: {
          sessions: {
            page: sessionsResult.page,
            pageSize: sessionsResult.pageSize,
            totalItems: sessionsResult.totalItems,
            totalPages: sessionsResult.totalPages,
            hasNextPage: sessionsResult.hasNextPage,
            hasPreviousPage: sessionsResult.hasPreviousPage
          },
          states: {
            page: statesResult.page,
            pageSize: statesResult.pageSize,
            totalItems: statesResult.totalItems,
            totalPages: statesResult.totalPages,
            hasNextPage: statesResult.hasNextPage,
            hasPreviousPage: statesResult.hasPreviousPage
          }
        },
        workspaceContext,
        ...(resolution ? { resolution } : {})
      };

      // Add navigation fallback message if workspace path building failed
      if (workspacePathResult.failed) {
        result.data.context.recentActivity.push(
          "Note: Workspace directory navigation unavailable. Use vaultManager listDirectoryMode to explore the workspace folder structure."
        );
      }

      return result;

    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack : undefined;
      console.error(`[LoadWorkspaceMode] Unexpected error after ${Date.now() - startTime}ms:`, {
        message: errorMessage,
        stack,
        params: params
      });

      return this.createErrorResult(
        createErrorMessage('Unexpected error loading workspace: ', errorMessage),
        params
      );
    }
  }

  /**
   * Turn a failed exact lookup into either a resolved workspace or an
   * actionable shortlist.
   *
   * Every branch returns something the caller can act on immediately — a
   * loaded workspace, ranked candidates with the exact retry command, or the
   * full inventory when nothing matched. The one thing it never returns is a
   * bare "not found", which is the response agents respond to by guessing
   * again.
   */
  private async recoverFromMiss(
    workspaceService: WorkspaceService,
    params: LoadWorkspaceParameters
  ): Promise<{ workspace: IndividualWorkspace | null; report: WorkspaceResolutionReport }> {
    const requested = params.workspace;

    let workspaces: WorkspaceMetadata[] = [];
    try {
      workspaces = await workspaceService.listWorkspaces();
    } catch (listError) {
      console.error('[LoadWorkspaceMode] Failed to list workspaces for miss recovery:', listError);
      return {
        workspace: null,
        report: {
          requested,
          autoResolved: false,
          note: `Workspace '${requested}' not found (searched by both name and ID), and the workspace list could not be read to suggest alternatives. Retry with: memory list-workspaces`
        }
      };
    }

    const active = workspaces.filter(workspace => !workspace.isArchived);
    const resolution = resolveWorkspaceIdentifier(workspaces, requested);

    if (resolution.kind === 'auto') {
      const target = resolution.match.workspace;
      const loaded = await workspaceService.getWorkspace(target.id);

      if (loaded) {
        return {
          workspace: loaded,
          report: {
            requested,
            autoResolved: true,
            resolvedTo: { id: target.id, name: target.name },
            note: `No workspace is named '${requested}'. '${target.name}' was the only close match, so it was loaded instead. Use the name '${target.name}' (or id ${target.id}) from here on.`
          }
        };
      }

      // Index row without a loadable record — treat it as a candidate rather
      // than silently reporting nothing matched.
      return {
        workspace: null,
        report: {
          requested,
          autoResolved: false,
          candidates: [this.toCandidate(resolution.match.workspace, resolution.match.score)],
          note: `Workspace '${requested}' not found. Closest match '${target.name}' could not be loaded. Retry with: memory load-workspace --workspace ${target.id}`
        }
      };
    }

    if (resolution.kind === 'candidates') {
      const candidates = resolution.candidates.map(match =>
        this.toCandidate(match.workspace, match.score)
      );
      return {
        workspace: null,
        report: {
          requested,
          autoResolved: false,
          candidates,
          note: `No workspace is named '${requested}'. ${candidates.length} workspace${candidates.length === 1 ? '' : 's'} partially matched — pick one instead of guessing again: ${candidates.map(candidate => `"${candidate.name}"`).join(', ')}. Load with: memory load-workspace --workspace ${candidates[0].name}`
        }
      };
    }

    const names = active.slice(0, MAX_LISTED_WORKSPACES).map(workspace => workspace.name);

    if (names.length === 0) {
      return {
        workspace: null,
        report: {
          requested,
          autoResolved: false,
          availableWorkspaces: [],
          note: `Workspace '${requested}' not found, and no workspaces exist yet. Create one with: memory create-workspace --name "<name>" --rootFolder "<folder>"`
        }
      };
    }

    const truncated = active.length > names.length ? ` (${active.length} total)` : '';
    return {
      workspace: null,
      report: {
        requested,
        autoResolved: false,
        availableWorkspaces: names,
        note: `Workspace '${requested}' does not exist and nothing resembles it. These are the workspaces that actually exist${truncated}: ${names.map(name => `"${name}"`).join(', ')}. Load one of these by name — do not invent another: memory load-workspace --workspace "${names[0]}"`
      }
    };
  }

  private toCandidate(
    workspace: WorkspaceMetadata,
    score: number
  ): NonNullable<WorkspaceResolutionReport['candidates']>[number] {
    return {
      id: workspace.id,
      name: workspace.name,
      ...(workspace.description ? { description: workspace.description } : {}),
      rootFolder: workspace.rootFolder || '',
      score: Number(score.toFixed(3))
    };
  }

  /**
   * Create an error result with default data structure
   * Follows DRY principle by consolidating error result creation
   */
  protected createErrorResult(
    errorMessage: string,
    params: LoadWorkspaceParameters,
    resolution?: WorkspaceResolutionReport
  ): LoadWorkspaceResult {
    return {
      success: false,
      error: errorMessage,
      ...(resolution ? { resolution } : {}),
      data: {
        context: {
          name: 'Unknown',
          rootFolder: '',
          recentActivity: [errorMessage]
        },
        workflows: [],
        workflowDefinitions: [],
        workspaceStructure: [],
        recentFiles: [],
        keyFiles: {},
        preferences: '',
        sessions: [],
        states: [],
      },
      workspaceContext: typeof params.workspaceContext === 'string'
        ? parseWorkspaceContext(params.workspaceContext) || undefined
        : params.workspaceContext
    };
  }

  getStatusLabel(params: Record<string, unknown> | undefined, tense: ToolStatusTense): string | undefined {
    return labelWithId(verbs('Loading workspace', 'Loaded workspace', 'Failed to load workspace'), params, tense, { keys: ['workspace'], fallback: 'workspace' });
  }

  /**
   * Get the parameter schema
   */
  getParameterSchema(): JSONSchema {
    const toolSchema = {
      type: 'object',
      properties: {
        workspace: {
          type: 'string',
          description: 'Workspace name or ID to load (REQUIRED). Use a name you have actually seen — from the workspace list in getTools, from search-workspaces/list-workspaces, or from the create-workspace you just made. Do NOT infer a name from how the user phrased the request; "load my research workspace" does not mean a workspace named "Research" exists. If you do not have a confirmed name, run "memory search-workspaces --query <fragment> --load" first: it auto-loads on a single match and lists candidates otherwise. A near-miss here is recovered (single close match auto-loads, otherwise candidates are returned) — but recovery costs a round trip that discovery would have saved.'
        },
        limit: {
          type: 'number',
          description: 'Optional limit for sessions, states, and recentActivity returned (default: 5)',
          default: 5,
          minimum: 1,
          maximum: 20
        },
        recursive: {
          type: 'boolean',
          description: 'Show full recursive file structure (true) or top-level folders only (false). Default: false (top-level only, folders marked with trailing /)',
          default: false
        }
      },
      required: ['workspace']
    };

    // Merge with common schema (adds sessionId, workspaceContext)
    return this.getMergedSchema(toolSchema);
  }

  /**
   * Get the result schema
   */
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
          properties: {
            context: {
              type: 'object',
              description: 'Contextual briefing about the workspace, including recent activity narrated in the context it happened under.',
              properties: {
                name: { type: 'string', description: 'Workspace name' },
                description: { type: 'string', description: 'Workspace description' },
                purpose: { type: 'string', description: 'What this workspace is for' },
                rootFolder: { type: 'string', description: 'Workspace root folder path' },
                recentActivity: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Recent tool activity as natural-language sentences, newest first. Each sentence couches the action in the memory/goal/constraints captured with that activity, so what happened is grounded in why it happened.'
                }
              },
              required: ['name', 'rootFolder', 'recentActivity']
            },
            workflows: {
              type: 'array',
              items: { type: 'string' },
              description: 'Workflow strings'
            },
            workflowDefinitions: {
              type: 'array',
              description: 'Structured workflow definitions including prompt bindings and schedules.',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  name: { type: 'string' },
                  when: { type: 'string' },
                  steps: { type: 'string' },
                  promptId: { type: 'string' },
                  promptName: { type: 'string' },
                  schedule: {
                    type: 'object',
                    properties: {
                      enabled: { type: 'boolean' },
                      frequency: { type: 'string', enum: ['hourly', 'daily', 'weekly', 'monthly'] },
                      intervalHours: { type: 'number' },
                      hour: { type: 'number' },
                      minute: { type: 'number' },
                      dayOfWeek: { type: 'number' },
                      dayOfMonth: { type: 'number' },
                      catchUp: { type: 'string', enum: ['skip', 'latest', 'all'] }
                    }
                  }
                },
                required: ['id', 'name', 'when', 'steps']
              }
            },
            workspaceStructure: {
              type: 'array',
              items: { type: 'string' },
              description: 'Workspace structure paths. By default shows top-level items only (folders marked with trailing /). Set recursive=true for full file tree.'
            },
            recentFiles: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  path: {
                    type: 'string',
                    description: 'File path relative to workspace root'
                  },
                  modified: {
                    type: 'number',
                    description: 'Last modified timestamp'
                  }
                },
                required: ['path', 'modified']
              },
              description: 'Most recently modified files in workspace (up to 5)'
            },
            keyFiles: {
              type: 'object',
              additionalProperties: {
                type: 'string'
              },
              description: 'Key files as name-path pairs'
            },
            preferences: {
              type: 'string',
              description: 'Formatted user preferences'
            },
            sessions: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: {
                    type: 'string',
                    description: 'Session ID'
                  },
                  name: {
                    type: 'string',
                    description: 'Session name'
                  },
                  description: {
                    type: 'string',
                    description: 'Session description'
                  },
                  created: {
                    type: 'number',
                    description: 'Session creation timestamp'
                  }
                },
                required: ['id', 'name', 'created']
              },
              description: 'Sessions in this workspace (paginated)'
            },
            states: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  name: {
                    type: 'string',
                    description: 'State name. Use this name with load-state while scoped to the same workspace.'
                  },
                  tags: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'State tags'
                  }
                },
                required: ['name']
              },
              description: 'Saved states in this workspace (paginated). State names are valid handles for load-state; IDs and session IDs are intentionally omitted.'
            },
            prompt: {
              type: 'object',
              properties: {
                id: {
                  type: 'string',
                  description: 'Prompt ID'
                },
                name: {
                  type: 'string',
                  description: 'Prompt name'
                },
                systemPrompt: {
                  type: 'string',
                  description: 'Custom prompt content'
                }
              },
              required: ['id', 'name', 'systemPrompt'],
              description: 'Associated workspace prompt (if available)'
            },
            taskSummary: {
              type: 'object',
              properties: {
                projects: { type: 'object', description: 'Project counts and summaries' },
                tasks: { type: 'object', description: 'Task counts by status, overdue count, next actions, recently completed' }
              },
              description: 'Task management summary (if TaskManager is available)'
            }
          }
        },
        pagination: {
          type: 'object',
          properties: {
            sessions: {
              type: 'object',
              properties: {
                page: { type: 'number', description: 'Current page (0-indexed)' },
                pageSize: { type: 'number', description: 'Items per page' },
                totalItems: { type: 'number', description: 'Total sessions in workspace' },
                totalPages: { type: 'number', description: 'Total pages available' },
                hasNextPage: { type: 'boolean', description: 'Whether more sessions exist' },
                hasPreviousPage: { type: 'boolean', description: 'Whether previous page exists' }
              },
              description: 'Pagination metadata for sessions'
            },
            states: {
              type: 'object',
              properties: {
                page: { type: 'number', description: 'Current page (0-indexed)' },
                pageSize: { type: 'number', description: 'Items per page' },
                totalItems: { type: 'number', description: 'Total states in workspace' },
                totalPages: { type: 'number', description: 'Total pages available' },
                hasNextPage: { type: 'boolean', description: 'Whether more states exist' },
                hasPreviousPage: { type: 'boolean', description: 'Whether previous page exists' }
              },
              description: 'Pagination metadata for states'
            }
          },
          description: 'Pagination metadata for sessions and states'
        },
        workspaceContext: {
          type: 'object',
          properties: {
            workspaceId: {
              type: 'string',
              description: 'Current workspace ID'
            },
            workspacePath: {
              type: 'array',
              items: { type: 'string' },
              description: 'Full path from root workspace'
            }
          }
        },
        resolution: {
          type: 'object',
          description: 'Present only when the requested name/ID was not an exact match. Read "note" and follow it — either a near-miss was resolved for you (use resolvedTo.name from now on) or the workspaces that actually exist are listed here. Never retry with another guessed name.',
          properties: {
            requested: { type: 'string', description: 'The identifier that was asked for' },
            autoResolved: { type: 'boolean', description: 'True when a single close match was loaded in place of the requested name' },
            resolvedTo: {
              type: 'object',
              description: 'The workspace actually loaded (present when autoResolved is true)',
              properties: {
                id: { type: 'string' },
                name: { type: 'string' }
              },
              required: ['id', 'name']
            },
            candidates: {
              type: 'array',
              description: 'Ranked partial matches to choose between when nothing was auto-resolved',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  name: { type: 'string' },
                  description: { type: 'string' },
                  rootFolder: { type: 'string' },
                  score: { type: 'number', description: 'Relevance score (higher is better)' }
                },
                required: ['id', 'name', 'rootFolder', 'score']
              }
            },
            availableWorkspaces: {
              type: 'array',
              items: { type: 'string' },
              description: 'Names of every existing workspace, listed when nothing resembled the request'
            },
            note: { type: 'string', description: 'What happened and the exact next command to run' }
          },
          required: ['requested', 'autoResolved', 'note']
        }
      },
      required: ['success']
    };
  }
}
