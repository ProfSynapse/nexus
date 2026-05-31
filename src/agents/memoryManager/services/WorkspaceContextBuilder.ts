/**
 * Location: /src/agents/memoryManager/services/WorkspaceContextBuilder.ts
 * Purpose: Builds context information for workspaces
 *
 * This service handles building various context components for workspaces
 * including contextual briefings, workflows, key files, and preferences.
 *
 * Used by: LoadWorkspaceMode for building workspace context
 * Integrates with: MemoryService for recent activity data
 *
 * Responsibilities:
 * - Build contextual briefings with recent activity
 * - Extract and format workflow information
 * - Extract key files from workspace context
 * - Build preferences summary
 */

import { ProjectWorkspace } from '../../../database/types/workspace/WorkspaceTypes';
import { formatWorkflowScheduleSummary } from '../../../services/workflows/types';
import { splitTopLevelSegments, tokenizeWithMeta } from '../../toolManager/services/ToolCliNormalizer';

/** Trace item shape for context building */
interface TraceItem {
  timestamp?: number;
  content?: string;
  sessionId?: string;
  metadata?: unknown;
}

/** Context (memory/goal/constraints) captured with a single trace */
interface TraceContextFields {
  memory?: string;
  goal?: string;
  constraints?: string;
}

/** Past-tense activity verbs → base form, for narrating failed attempts naturally */
const BASE_VERBS: Record<string, string> = {
  read: 'read', wrote: 'write', updated: 'update', searched: 'search',
  created: 'create', saved: 'save', loaded: 'load', listed: 'list',
  moved: 'move', copied: 'copy', archived: 'archive', opened: 'open',
  ran: 'run', linked: 'link', generated: 'generate', executed: 'execute',
  queried: 'query'
};

/**
 * Interface for memory service methods used by this builder
 * Returns PaginatedResult with items array
 */
interface IMemoryServiceForContext {
  getMemoryTraces(workspaceId: string): Promise<{ items: TraceItem[]; total?: number }>;
}

/**
 * Context briefing structure
 */
export interface ContextBriefing {
  name: string;
  description?: string;
  purpose?: string;
  rootFolder: string;
  recentActivity: string[];
}

/**
 * Service for building workspace context information
 * Implements Single Responsibility Principle - only handles context building
 */
export class WorkspaceContextBuilder {
  /**
   * Build a contextual briefing for the workspace
   * @param workspace The workspace
   * @param memoryService The memory service instance
   * @param limit Maximum number of recent activity items
   * @returns Context briefing object
   */
  async buildContextBriefing(
    workspace: ProjectWorkspace,
    memoryService: IMemoryServiceForContext | null,
    limit: number
  ): Promise<ContextBriefing> {
    let recentActivity: string[] = [];

    if (memoryService) {
      try {
        recentActivity = await this.getRecentActivity(workspace.id, memoryService, limit);
      } catch (error) {
        console.error('[WorkspaceContextBuilder] getRecentActivity failed:', error);
        recentActivity = [`Recent activity error: ${error instanceof Error ? error.message : String(error)}`];
      }
    } else {
      recentActivity = ['No recent activity'];
    }

    const finalActivity = recentActivity.length > 0 ? recentActivity : ['No recent activity'];

    return {
      name: workspace.name,
      description: workspace.description || undefined,
      purpose: workspace.context?.purpose || undefined,
      rootFolder: workspace.rootFolder,
      recentActivity: finalActivity
    };
  }

  /**
   * Build workflows array - one string per workflow
   * @param workspace The workspace
   * @returns Array of formatted workflow strings
   */
  buildWorkflows(workspace: ProjectWorkspace): string[] {
    if (!workspace.context?.workflows || workspace.context.workflows.length === 0) {
      return [];
    }

    return workspace.context.workflows.map(workflow => {
      const details: string[] = [];
      if (workflow.promptName) {
        details.push(`Prompt: ${workflow.promptName}`);
      }
      if (workflow.schedule?.enabled) {
        details.push(`Schedule: ${formatWorkflowScheduleSummary(workflow.schedule)}`);
      }

      const header = `**${workflow.name}** (${workflow.when})`;
      const metadata = details.length > 0 ? `\n${details.join('\n')}` : '';
      return `${header}${metadata}:\n${workflow.steps}`;
    });
  }

  /**
   * Extract key files into a flat structure
   * @param workspace The workspace
   * @returns Record of file names to file paths
   */
  extractKeyFiles(workspace: ProjectWorkspace): Record<string, string> {
    const keyFiles: Record<string, string> = {};

    if (workspace.context?.keyFiles) {
      // New format: simple array of file paths
      if (Array.isArray(workspace.context.keyFiles)) {
        workspace.context.keyFiles.forEach((filePath, index) => {
          // Extract filename without extension as key
          const fileName = filePath.split('/').pop()?.replace(/\.[^/.]+$/, '') || `file_${index}`;
          keyFiles[fileName] = filePath;
        });
      }
      // Legacy format: array of categorized files (for backward compatibility)
      else if (typeof workspace.context.keyFiles === 'object' && 'length' in workspace.context.keyFiles) {
        const legacyKeyFiles = workspace.context.keyFiles as Array<{ files?: Record<string, string> }>;
        legacyKeyFiles.forEach((category) => {
          if (category.files) {
            Object.entries(category.files).forEach(([name, path]) => {
              keyFiles[name] = path;
            });
          }
        });
      }
    }

    return keyFiles;
  }

  /**
   * Build preferences summary
   * @param workspace The workspace
   * @returns Preferences summary string
   */
  buildPreferences(workspace: ProjectWorkspace): string {
    // Preferences is now a string, not an array
    if (workspace.context?.preferences && workspace.context.preferences.trim()) {
      return workspace.context.preferences;
    }

    // Legacy support for userPreferences (if still exists)
    if (workspace.preferences?.userPreferences && Array.isArray(workspace.preferences.userPreferences)) {
      return workspace.preferences.userPreferences.join('. ') + '.';
    }

    return 'No preferences set';
  }

  /**
   * Get recent activity from memory traces as natural-language sentences.
   *
   * Each activity is narrated in the context captured with its own trace: the
   * memory (what was happening), goal (what it was for), and constraints (limits
   * in force) are composed into a readable sentence so that what happened is
   * grounded in why it happened. Activities with no captured context fall back
   * to the bare action description. Newest first, capped at `limit`.
   *
   * @param workspaceId The workspace ID
   * @param memoryService The memory service instance
   * @param limit Maximum number of activity items
   * @returns Array of composed recent-activity sentences
   */
  private async getRecentActivity(
    workspaceId: string,
    memoryService: IMemoryServiceForContext,
    limit: number
  ): Promise<string[]> {
    try {
      // Get all traces from workspace (across all sessions)
      const tracesResult = await memoryService.getMemoryTraces(workspaceId);
      const traces = tracesResult.items || [];

      if (traces.length === 0) {
        return ['No recent activity'];
      }

      // Sort by timestamp descending (newest first)
      traces.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

      const activities: string[] = [];
      for (const trace of traces) {
        const context = this.extractTraceContext(trace);
        for (const action of this.formatTraceActivities(trace)) {
          activities.push(this.composeActivitySentence(action, context));
          if (activities.length >= limit) {
            return activities;
          }
        }
      }

      return activities.length > 0 ? activities : ['No recent activity'];
    } catch (error) {
      console.error('[WorkspaceContextBuilder] getRecentActivity error:', error);
      return ['Recent activity unavailable'];
    }
  }

  /**
   * Extract the context (memory/goal/constraints) captured with a trace.
   * Supports both the V2 context schema (memory/goal/constraints) and the legacy
   * schema (sessionMemory/primaryGoal). Empty strings normalize to undefined.
   */
  private extractTraceContext(trace: TraceItem): TraceContextFields {
    const metadata = asRecord(trace.metadata);
    const context = asRecord(metadata.context);

    const memory = getString(context.memory) || getString(context.sessionMemory);
    const goal = getString(context.goal) || getString(context.primaryGoal);
    const constraints = getString(context.constraints);

    return {
      memory: memory || undefined,
      goal: goal || undefined,
      constraints: constraints || undefined
    };
  }

  /**
   * Compose an activity and its captured context into a natural-language
   * sentence. When no context was captured, the bare action is returned so
   * context-free traces read exactly as before.
   *
   * Shape: an optional leading memory sentence (kept verbatim — it is free-form
   * text), then the action woven with its goal ("I read X to do Y"), then an
   * optional trailing constraints sentence.
   */
  private composeActivitySentence(action: string, context: TraceContextFields): string {
    const { memory, goal, constraints } = context;
    if (!memory && !goal && !constraints) {
      return action;
    }

    const parts: string[] = [];
    if (memory) {
      parts.push(ensureSentence(memory));
    }
    parts.push(ensureSentence(this.composeActionClause(action, goal)));
    if (constraints) {
      parts.push(ensureSentence(constraints));
    }
    return parts.join(' ');
  }

  /**
   * Weave the action with its goal: "I read X" → "I read X to finish the draft".
   * Failed activities are narrated as attempts ("I tried to write X, but it
   * failed") using a small past→base verb map.
   */
  private composeActionClause(action: string, goal: string | undefined): string {
    const failed = action.startsWith('Failed: ');
    const act = failed ? action.slice('Failed: '.length) : action;
    const goalClause = goal ? ` to ${lowerFirst(stripTerminalPunctuation(goal))}` : '';

    if (failed) {
      const [verb, ...rest] = act.split(' ');
      const base = BASE_VERBS[verb.toLowerCase()];
      const attempt = base
        ? `I tried to ${base}${rest.length ? ' ' + rest.join(' ') : ''}`
        : `My attempt to ${lowerFirst(act)}`;
      return `${attempt}${goalClause}, but it failed`;
    }

    return `I ${lowerFirst(act)}${goalClause}`;
  }

  private formatTraceActivities(trace: TraceItem): string[] {
    const metadata = asRecord(trace.metadata);
    const tool = asRecord(metadata.tool);
    const agent = getString(tool.agent);
    const mode = getString(tool.mode);

    if (mode === 'getTools') {
      return [];
    }

    if (mode === 'useTools' || mode === 'useTool') {
      const toolString = this.extractUseToolsCommand(metadata);
      if (toolString) {
        const executedActivities = this.formatExecutedUseToolsActivities(metadata, toolString);
        if (executedActivities.length > 0) {
          return [...executedActivities].reverse();
        }

        const activities = this.formatUseToolsActivities(toolString);
        if (activities.length > 0) {
          return [...activities].reverse();
        }
      }
    }

    const args = this.extractTraceArguments(metadata);
    const formatted = mode ? this.formatSingleToolActivity(agent, mode, args) : null;
    return [formatted || trace.content || 'Unknown activity'];
  }

  private extractUseToolsCommand(metadata: Record<string, unknown>): string | undefined {
    const args = this.extractTraceArguments(metadata);
    return getString(args.tool);
  }

  private extractTraceArguments(metadata: Record<string, unknown>): Record<string, unknown> {
    const input = asRecord(metadata.input);
    const inputArgs = asRecord(input.arguments);
    if (Object.keys(inputArgs).length > 0) {
      return inputArgs;
    }

    const legacy = asRecord(metadata.legacy);
    return asRecord(legacy.params);
  }

  private formatUseToolsActivities(toolString: string): string[] {
    return splitTopLevelSegments(toolString)
      .map(segment => this.formatCliSegmentActivity(segment))
      .filter((activity): activity is string => Boolean(activity));
  }

  private formatExecutedUseToolsActivities(metadata: Record<string, unknown>, toolString: string): string[] {
    const results = this.extractUseToolsResults(metadata);
    if (results.length === 0) {
      return [];
    }

    const segments = splitTopLevelSegments(toolString);
    return results
      .map((result, index) => this.formatExecutedUseToolsResult(result, segments[index]))
      .filter((activity): activity is string => Boolean(activity));
  }

  private extractUseToolsResults(metadata: Record<string, unknown>): Record<string, unknown>[] {
    const legacy = asRecord(metadata.legacy);
    const result = asRecord(legacy.result);
    const data = asRecord(result.data);
    const results = data.results;
    if (!Array.isArray(results)) {
      return Object.keys(result).length > 0 && result.agent && result.tool ? [result] : [];
    }

    return results.filter((item): item is Record<string, unknown> =>
      typeof item === 'object' && item !== null && !Array.isArray(item)
    );
  }

  private formatExecutedUseToolsResult(result: Record<string, unknown>, segment: string | undefined): string | null {
    const agent = getString(result.agent);
    const tool = getString(result.tool);
    if (!tool) {
      return null;
    }

    const args = segment ? this.extractSegmentArgs(segment) : {};
    const base = this.formatSingleToolActivity(agent, tool, args);
    if (!base) {
      return null;
    }

    return result.success === false ? `Failed: ${base}` : base;
  }

  private formatCliSegmentActivity(segment: string): string | null {
    const parsed = this.parseCliSegment(segment);
    if (!parsed) {
      return null;
    }

    return this.formatSingleToolActivity(parsed.agent, parsed.tool, parsed.args);
  }

  private extractSegmentArgs(segment: string): Record<string, unknown> {
    const parsed = this.parseCliSegment(segment);
    return parsed?.args || {};
  }

  private parseCliSegment(segment: string): { agent: string; tool: string; args: Record<string, unknown> } | null {
    const tokens = tokenizeWithMeta(segment);
    if (tokens.length < 2) {
      return null;
    }

    const agent = tokens[0].value;
    const tool = tokens[1].value;
    const args = parseDisplayArgs(tokens.slice(2));
    return { agent, tool, args };
  }

  private formatSingleToolActivity(agent: string | undefined, tool: string, args: Record<string, unknown>): string | null {
    const normalizedAgent = normalizeToken(agent || '');
    const normalizedTool = normalizeToken(tool);
    const target = getTarget(args);
    const query = getString(args.query) || getString(args._positional0);

    if (normalizedAgent === 'content' || normalizedAgent === 'contentmanager') {
      switch (normalizedTool) {
        case 'read':
          return target ? `Read ${target}` : 'Read file';
        case 'write':
          return target ? `Wrote ${target}` : 'Wrote file';
        case 'replace':
        case 'insert':
        case 'setproperty':
          return target ? `Updated ${target}` : 'Updated file';
        default:
          return null;
      }
    }

    if (normalizedAgent === 'search' || normalizedAgent === 'searchmanager') {
      switch (normalizedTool) {
        case 'searchcontent':
        case 'searchmemory':
          return query ? `Searched for "${truncate(query)}"` : 'Searched';
        case 'searchdirectory':
          return query ? `Searched directory for "${truncate(query)}"` : 'Searched directory';
        default:
          return null;
      }
    }

    if (normalizedAgent === 'memory' || normalizedAgent === 'memorymanager') {
      return this.formatMemoryActivity(normalizedTool, args, target);
    }

    if (normalizedAgent === 'storage' || normalizedAgent === 'storagemanager') {
      return this.formatStorageActivity(normalizedTool, args, target);
    }

    if (normalizedAgent === 'task' || normalizedAgent === 'taskmanager') {
      return this.formatTaskActivity(normalizedTool, args, target);
    }

    if (normalizedAgent === 'prompt' || normalizedAgent === 'promptmanager') {
      return this.formatPromptActivity(normalizedTool, args, target);
    }

    if (normalizedAgent === 'canvas' || normalizedAgent === 'canvasmanager') {
      switch (normalizedTool) {
        case 'read':
          return target ? `Read canvas ${target}` : 'Read canvas';
        case 'write':
        case 'update':
          return target ? `Updated canvas ${target}` : 'Updated canvas';
        case 'list':
          return 'Listed canvases';
        default:
          return null;
      }
    }

    switch (normalizedTool) {
      case 'read':
        return target ? `Read ${target}` : 'Read file';
      case 'write':
        return target ? `Wrote ${target}` : 'Wrote file';
      case 'replace':
      case 'insert':
      case 'setproperty':
      case 'update':
        return target ? `Updated ${target}` : 'Updated file';
      case 'searchcontent':
      case 'searchmemory':
        return query ? `Searched for "${truncate(query)}"` : 'Searched';
      case 'searchdirectory':
        return query ? `Searched directory for "${truncate(query)}"` : 'Searched directory';
      default:
        return this.formatGenericActivity(tool, target);
    }
  }

  private formatMemoryActivity(tool: string, args: Record<string, unknown>, target: string | undefined): string | null {
    const workspaceTarget = getString(args.workspaceId) || target;
    const stateTarget = getString(args.name) || getString(args.id) || target;

    switch (tool) {
      case 'createworkspace':
        return workspaceTarget ? `Created workspace ${workspaceTarget}` : 'Created workspace';
      case 'loadworkspace':
        return workspaceTarget ? `Loaded workspace ${workspaceTarget}` : 'Loaded workspace';
      case 'updateworkspace':
        return workspaceTarget ? `Updated workspace ${workspaceTarget}` : 'Updated workspace';
      case 'archiveworkspace':
        return workspaceTarget ? `Archived workspace ${workspaceTarget}` : 'Archived workspace';
      case 'listworkspaces':
        return 'Listed workspaces';
      case 'createstate':
        return stateTarget ? `Saved state ${stateTarget}` : 'Saved state';
      case 'loadstate':
        return stateTarget ? `Loaded state ${stateTarget}` : 'Loaded state';
      case 'liststates':
        return 'Listed states';
      case 'runworkflow':
        return target ? `Ran workflow ${target}` : 'Ran workflow';
      default:
        return null;
    }
  }

  private formatStorageActivity(tool: string, args: Record<string, unknown>, target: string | undefined): string | null {
    const destination = getString(args.newPath) || getString(args.destinationPath) || getString(args.to) || getString(args._positional1);

    switch (tool) {
      case 'list':
        return target ? `Listed ${target}` : 'Listed vault';
      case 'createfolder':
        return target ? `Created folder ${target}` : 'Created folder';
      case 'move':
        return target && destination ? `Moved ${target} to ${destination}` : target ? `Moved ${target}` : 'Moved item';
      case 'copy':
        return target && destination ? `Copied ${target} to ${destination}` : target ? `Copied ${target}` : 'Copied item';
      case 'archive':
        return target ? `Archived ${target}` : 'Archived item';
      case 'open':
        return target ? `Opened ${target}` : 'Opened item';
      default:
        return null;
    }
  }

  private formatTaskActivity(tool: string, args: Record<string, unknown>, target: string | undefined): string | null {
    const taskTarget = getString(args.title) ||
      getString(args.taskId) ||
      (tool === 'createtask' ? getString(args._positional1) : undefined) ||
      target;
    const projectTarget = getString(args.name) ||
      getString(args.projectId) ||
      (tool === 'createproject' ? getString(args._positional1) : undefined) ||
      target;

    switch (tool) {
      case 'createproject':
        return projectTarget ? `Created project ${projectTarget}` : 'Created project';
      case 'listprojects':
        return 'Listed projects';
      case 'updateproject':
        return projectTarget ? `Updated project ${projectTarget}` : 'Updated project';
      case 'archiveproject':
        return projectTarget ? `Archived project ${projectTarget}` : 'Archived project';
      case 'createtask':
        return taskTarget ? `Created task ${taskTarget}` : 'Created task';
      case 'listtasks':
        return projectTarget ? `Listed tasks for ${projectTarget}` : 'Listed tasks';
      case 'opentasks':
        return 'Opened tasks';
      case 'updatetask':
        return taskTarget ? `Updated task ${taskTarget}` : 'Updated task';
      case 'movetask':
        return taskTarget ? `Moved task ${taskTarget}` : 'Moved task';
      case 'querytasks':
        return 'Queried tasks';
      case 'linknote':
        return target ? `Linked note ${target}` : 'Linked note';
      default:
        return null;
    }
  }

  private formatPromptActivity(tool: string, args: Record<string, unknown>, target: string | undefined): string | null {
    const promptTarget = getString(args.promptName) || target;

    switch (tool) {
      case 'createprompt':
        return promptTarget ? `Created prompt ${promptTarget}` : 'Created prompt';
      case 'getprompt':
        return promptTarget ? `Loaded prompt ${promptTarget}` : 'Loaded prompt';
      case 'listprompts':
        return 'Listed prompts';
      case 'updateprompt':
        return promptTarget ? `Updated prompt ${promptTarget}` : 'Updated prompt';
      case 'archiveprompt':
        return promptTarget ? `Archived prompt ${promptTarget}` : 'Archived prompt';
      case 'executeprompts':
        return promptTarget ? `Executed prompt ${promptTarget}` : 'Executed prompt';
      case 'generateimage':
        return promptTarget ? `Generated image for ${promptTarget}` : 'Generated image';
      case 'listmodels':
        return 'Listed models';
      case 'subagent':
        return promptTarget ? `Ran subagent ${promptTarget}` : 'Ran subagent';
      default:
        return null;
    }
  }

  private formatGenericActivity(tool: string, target: string | undefined): string {
    const label = humanizeToken(tool);
    return target ? `${label} ${target}` : label;
  }
}

function parseDisplayArgs(tokens: ReturnType<typeof tokenizeWithMeta>): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  const positionals: string[] = [];
  const looksLikeFlag = (token: (typeof tokens)[number]): boolean =>
    !token.wasQuoted && token.value.startsWith('--');

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!looksLikeFlag(token)) {
      positionals.push(token.value);
      continue;
    }

    let key = toCamelCase(token.value.slice(2));
    let inlineValue: string | undefined;
    const equalsIdx = key.indexOf('=');
    if (equalsIdx >= 0) {
      inlineValue = key.slice(equalsIdx + 1);
      key = key.slice(0, equalsIdx);
    }

    if (inlineValue !== undefined) {
      args[key] = inlineValue;
      continue;
    }

    const next = tokens[i + 1];
    if (!next || looksLikeFlag(next)) {
      args[key] = true;
      continue;
    }

    args[key] = next.value;
    i += 1;
  }

  positionals.forEach((value, index) => {
    args[`_positional${index}`] = value;
  });

  return args;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function getString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function getTarget(args: Record<string, unknown>): string | undefined {
  return getString(args.path) ||
    getString(args.filePath) ||
    getString(args.sourcePath) ||
    getString(args.id) ||
    getString(args.name) ||
    getString(args.title) ||
    getString(args._positional0);
}

function normalizeToken(value: string): string {
  return value.replace(/[-_\s]/g, '').toLowerCase();
}

function humanizeToken(value: string): string {
  const words = value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[-_]+/g, ' ')
    .trim();
  if (!words) {
    return 'Ran tool';
  }
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function toCamelCase(value: string): string {
  return value.replace(/-([a-z])/g, (_match, char: string) => char.toUpperCase());
}

function truncate(value: string): string {
  return value.length > 60 ? `${value.slice(0, 60)}...` : value;
}

/** Lowercase only the first character, leaving the rest (paths, proper nouns) intact. */
function lowerFirst(value: string): string {
  return value ? value.charAt(0).toLowerCase() + value.slice(1) : value;
}

/** Strip a single trailing sentence terminator (and surrounding whitespace) for clean weaving. */
function stripTerminalPunctuation(value: string): string {
  return value.trim().replace(/[.!?]+$/, '').trim();
}

/** Ensure a clause reads as a sentence: trimmed, capitalized, and terminated. */
function ensureSentence(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return trimmed;
  }
  const capitalized = trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
  return /[.!?]$/.test(capitalized) ? capitalized : `${capitalized}.`;
}
