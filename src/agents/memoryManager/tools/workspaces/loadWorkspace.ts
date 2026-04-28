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
  LoadWorkspaceResult
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
import type { WorkspaceTaskSummary } from '../../../taskManager/types';

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
      'Load a workspace by ID and restore context and state',
      '2.0.0'
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

      if (workspaceService.isSystemWorkspaceId(params.id)) {
        const systemWorkspace = await workspaceService.loadSystemGuidesWorkspace(limit);
        if (!systemWorkspace) {
          return this.createErrorResult(`Workspace '${params.id}' is unavailable`, params);
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
        workspace = await workspaceService.getWorkspaceByNameOrId(params.id);
      } catch (queryError) {
        console.error('[LoadWorkspaceMode] Failed to load workspace:', queryError);
        return this.createErrorResult(
          `Failed to load workspace: ${queryError instanceof Error ? queryError.message : String(queryError)}`,
          params
        );
      }

      if (!workspace) {
        console.error('[LoadWorkspaceMode] Workspace not found:', params.id);
        return this.createErrorResult(`Workspace '${params.id}' not found (searched by both name and ID)`, params);
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
      const recentFiles = this.fileCollector.getRecentFilesInWorkspace(workspace, cacheManager);

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
        workspaceContext
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
   * Create an error result with default data structure
   * Follows DRY principle by consolidating error result creation
   */
  protected createErrorResult(errorMessage: string, params: LoadWorkspaceParameters): LoadWorkspaceResult {
    return {
      success: false,
      error: errorMessage,
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
    return labelWithId(verbs('Loading workspace', 'Loaded workspace', 'Failed to load workspace'), params, tense, { keys: ['id'], fallback: 'workspace' });
  }

  /**
   * Get the parameter schema
   */
  getParameterSchema(): JSONSchema {
    const toolSchema = {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'Workspace ID or name to load (REQUIRED). Accepts either the unique workspace ID or the workspace name. Using the name returned by create-workspace is fine; you do not need to call list-workspaces just to find the UUID.'
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
      required: ['id']
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
              type: 'string',
              description: 'Formatted contextual briefing about the workspace'
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
                  id: {
                    type: 'string',
                    description: 'State ID'
                  },
                  name: {
                    type: 'string',
                    description: 'State name'
                  },
                  description: {
                    type: 'string',
                    description: 'State description'
                  },
                  sessionId: {
                    type: 'string',
                    description: 'Session ID this state belongs to'
                  },
                  created: {
                    type: 'number',
                    description: 'State creation timestamp'
                  },
                  tags: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'State tags'
                  }
                },
                required: ['id', 'name', 'created']
              },
              description: 'States in this workspace (paginated)'
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
        }
      },
      required: ['success']
    };
  }
}
