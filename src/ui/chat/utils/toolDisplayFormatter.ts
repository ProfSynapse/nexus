import { formatToolDisplayName } from '../../../utils/toolNameUtils';
import type { ToolDisplayGroup, ToolDisplayStep, ToolDisplayStatus } from './toolDisplayNormalizer';

type DisplayTense = 'present' | 'past' | 'failed';

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function getStringParameter(parameters: Record<string, unknown> | undefined, keys: string[]): string | undefined {
  if (!parameters) {
    return undefined;
  }

  for (const key of keys) {
    const value = parameters[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }

  return undefined;
}

function getBaseName(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const parts = value.split(/[\\/]/);
  const last = parts[parts.length - 1]?.trim();
  return last && last.length > 0 ? last : value.trim();
}

function toTitleCase(value: string): string {
  return value
    .replace(/[_-]/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(part => part.length > 0)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function getActionName(step: Partial<Pick<ToolDisplayStep, 'technicalName' | 'displayName' | 'actionName'>>): string {
  if (isNonEmptyString(step.actionName)) {
    return step.actionName;
  }

  if (isNonEmptyString(step.technicalName)) {
    const normalized = step.technicalName.replace(/_/g, '.');
    const segments = normalized.split('.');
    const actionSegment = segments.length > 0 ? segments[segments.length - 1] : normalized;
    return toTitleCase(actionSegment);
  }

  return step.displayName || 'Tool';
}

function formatQuery(parameters: Record<string, unknown> | undefined, keys: string[]): string | undefined {
  const query = getStringParameter(parameters, keys);
  return query ? `"${query}"` : undefined;
}

function summarizePastSteps(steps: ToolDisplayStep[], limit = 3): string | undefined {
  const completedOrFailed = steps.filter(step => step.status === 'completed' || step.status === 'failed');
  if (completedOrFailed.length === 0) {
    return undefined;
  }

  const labels = completedOrFailed
    .slice(0, limit)
    .map(step => formatToolStepLabel(step, step.status === 'failed' ? 'failed' : 'past'));

  if (labels.length === 0) {
    return undefined;
  }

  const remaining = completedOrFailed.length - labels.length;
  return remaining > 0 ? `${labels.join(', ')}, +${remaining} more` : labels.join(', ');
}

export function formatDiscoveryLabel(status: ToolDisplayStatus): string {
  switch (status) {
    case 'failed':
      return 'Failed to check available tools';
    case 'completed':
      return 'Checked available tools';
    default:
      return 'Checking available tools';
  }
}

export function formatToolStepLabel(step: Partial<Pick<ToolDisplayStep, 'technicalName' | 'parameters' | 'displayName' | 'actionName' | 'isVirtual'>> & { result?: unknown; error?: string; status?: ToolDisplayStatus }, tense?: DisplayTense): string {
  const technicalName = step.technicalName ? step.technicalName.replace(/_/g, '.') : '';
  const action = getActionName(step);
  const status = tense || step.status || 'present';
  const parameters = step.parameters;

  const isUseToolsWrapper =
    technicalName === 'useTools' ||
    technicalName.endsWith('.useTools') ||
    action === 'Use Tools';

  if (technicalName === 'getTools' || technicalName.endsWith('.getTools')) {
    return formatDiscoveryLabel((step.status || 'executing'));
  }

  if (isUseToolsWrapper) {
    return status === 'failed'
      ? 'Failed to prepare actions'
      : status === 'past'
        ? 'Prepared actions'
        : 'Preparing actions';
  }

  switch (technicalName) {
    case 'contentManager.read': {
      const target = getBaseName(getStringParameter(parameters, ['path', 'filePath', 'file', 'filename'])) || 'file';
      return status === 'failed'
        ? `Failed to read ${target}`
        : status === 'past'
          ? `Read ${target}`
          : `Reading ${target}`;
    }
    case 'contentManager.write': {
      const target = getBaseName(getStringParameter(parameters, ['path', 'filePath', 'file', 'filename'])) || 'file';
      return status === 'failed'
        ? `Failed to update ${target}`
        : status === 'past'
          ? `Updated ${target}`
          : `Updating ${target}`;
    }
    case 'contentManager.replace': {
      const target = getBaseName(getStringParameter(parameters, ['path', 'filePath', 'file', 'filename'])) || 'file';
      return status === 'failed'
        ? `Failed to update ${target}`
        : status === 'past'
          ? `Updated ${target}`
          : `Updating ${target}`;
    }
    case 'contentManager.insert': {
      const target = getBaseName(getStringParameter(parameters, ['path', 'filePath', 'file', 'filename'])) || 'file';
      return status === 'failed'
        ? `Failed to update ${target}`
        : status === 'past'
          ? `Updated ${target}`
          : `Updating ${target}`;
    }
    case 'contentManager.setProperty': {
      const target = getBaseName(getStringParameter(parameters, ['path', 'filePath', 'file', 'filename'])) || 'file';
      return status === 'failed'
        ? `Failed to update ${target}`
        : status === 'past'
          ? `Updated ${target}`
          : `Updating ${target}`;
    }
    case 'memoryManager.loadWorkspace': {
      const workspace = getStringParameter(parameters, ['id', 'workspaceId', 'name']) || 'workspace';
      return status === 'failed'
        ? `Failed to load workspace ${workspace}`
        : status === 'past'
          ? `Loaded workspace ${workspace}`
          : `Loading workspace ${workspace}`;
    }
    case 'memoryManager.listWorkspaces':
      return status === 'failed'
        ? 'Failed to list workspaces'
        : status === 'past'
          ? 'Listed workspaces'
          : 'Listing workspaces';
    case 'searchManager.searchContent': {
      const query = formatQuery(parameters, ['query', 'text', 'term']);
      return status === 'failed'
        ? `Failed to search notes${query ? ` for ${query}` : ''}`
        : status === 'past'
          ? `Searched notes${query ? ` for ${query}` : ''}`
          : `Searching notes${query ? ` for ${query}` : ''}`;
    }
    case 'searchManager.searchMemory': {
      const query = formatQuery(parameters, ['query', 'text', 'term']);
      return status === 'failed'
        ? `Failed to search memory${query ? ` for ${query}` : ''}`
        : status === 'past'
          ? `Searched memory${query ? ` for ${query}` : ''}`
          : `Searching memory${query ? ` for ${query}` : ''}`;
    }
    case 'storageManager.move': {
      const source = getBaseName(getStringParameter(parameters, ['sourcePath', 'path', 'from', 'source'])) || 'item';
      const destination = getBaseName(getStringParameter(parameters, ['destinationPath', 'to', 'destination'])) || 'destination';
      return status === 'failed'
        ? `Failed to move ${source} to ${destination}`
        : status === 'past'
          ? `Moved ${source} to ${destination}`
          : `Moving ${source} to ${destination}`;
    }
    case 'storageManager.copy': {
      const source = getBaseName(getStringParameter(parameters, ['sourcePath', 'path', 'from', 'source'])) || 'item';
      const destination = getBaseName(getStringParameter(parameters, ['destinationPath', 'to', 'destination'])) || 'destination';
      return status === 'failed'
        ? `Failed to copy ${source} to ${destination}`
        : status === 'past'
          ? `Copied ${source} to ${destination}`
          : `Copying ${source} to ${destination}`;
    }
    case 'storageManager.archive': {
      const source = getBaseName(getStringParameter(parameters, ['path', 'sourcePath', 'filePath'])) || 'item';
      return status === 'failed'
        ? `Failed to archive ${source}`
        : status === 'past'
          ? `Archived ${source}`
          : `Archiving ${source}`;
    }
    case 'storageManager.open': {
      const target = getBaseName(getStringParameter(parameters, ['path', 'filePath', 'target'])) || 'item';
      return status === 'failed'
        ? `Failed to open ${target}`
        : status === 'past'
          ? `Opened ${target}`
          : `Opening ${target}`;
    }
    case 'storageManager.list': {
      const target = getBaseName(getStringParameter(parameters, ['path', 'directory', 'folderPath', 'target'])) || 'folder';
      return status === 'failed'
        ? `Failed to list contents of ${target}`
        : status === 'past'
          ? `Listed contents of ${target}`
          : `Listing contents of ${target}`;
    }
    case 'storageManager.createFolder': {
      const target = getBaseName(getStringParameter(parameters, ['path', 'folderPath', 'name'])) || 'folder';
      return status === 'failed'
        ? `Failed to create folder ${target}`
        : status === 'past'
          ? `Created folder ${target}`
          : `Creating folder ${target}`;
    }
    case 'searchManager.searchDirectory': {
      const target = getBaseName(getStringParameter(parameters, ['path', 'directory', 'folderPath'])) || 'folder';
      const query = formatQuery(parameters, ['query', 'text', 'term']);
      const suffix = query ? ` for ${query}` : '';
      return status === 'failed'
        ? `Failed to search ${target}${suffix}`
        : status === 'past'
          ? `Searched ${target}${suffix}`
          : `Searching ${target}${suffix}`;
    }
    case 'memoryManager.createSession': {
      const name = getStringParameter(parameters, ['name', 'sessionName', 'title']);
      const suffix = name ? ` "${name}"` : '';
      return status === 'failed'
        ? `Failed to create session${suffix}`
        : status === 'past'
          ? `Created session${suffix}`
          : `Creating session${suffix}`;
    }
    case 'memoryManager.loadSession': {
      const id = getStringParameter(parameters, ['id', 'sessionId', 'name']) || 'session';
      return status === 'failed'
        ? `Failed to load ${id}`
        : status === 'past'
          ? `Loaded ${id}`
          : `Loading ${id}`;
    }
    case 'memoryManager.createWorkspace': {
      const name = getStringParameter(parameters, ['name', 'workspaceName', 'title']);
      const suffix = name ? ` "${name}"` : '';
      return status === 'failed'
        ? `Failed to create workspace${suffix}`
        : status === 'past'
          ? `Created workspace${suffix}`
          : `Creating workspace${suffix}`;
    }
    case 'memoryManager.createState': {
      const name = getStringParameter(parameters, ['name', 'stateName', 'title']);
      const suffix = name ? ` "${name}"` : '';
      return status === 'failed'
        ? `Failed to save state${suffix}`
        : status === 'past'
          ? `Saved state${suffix}`
          : `Saving state${suffix}`;
    }
    case 'taskManager.createProject': {
      const name = getStringParameter(parameters, ['name', 'title', 'projectName']);
      const suffix = name ? ` "${name}"` : '';
      return status === 'failed'
        ? `Failed to create project${suffix}`
        : status === 'past'
          ? `Created project${suffix}`
          : `Creating project${suffix}`;
    }
    case 'taskManager.listProjects':
      return status === 'failed'
        ? 'Failed to list projects'
        : status === 'past'
          ? 'Listed projects'
          : 'Listing projects';
    case 'taskManager.updateProject': {
      const id = getStringParameter(parameters, ['projectId', 'id', 'name']) || 'project';
      return status === 'failed'
        ? `Failed to update ${id}`
        : status === 'past'
          ? `Updated ${id}`
          : `Updating ${id}`;
    }
    case 'taskManager.archiveProject': {
      const id = getStringParameter(parameters, ['projectId', 'id', 'name']) || 'project';
      return status === 'failed'
        ? `Failed to archive ${id}`
        : status === 'past'
          ? `Archived ${id}`
          : `Archiving ${id}`;
    }
    case 'taskManager.createTask': {
      const name = getStringParameter(parameters, ['name', 'title', 'taskName', 'description']);
      const suffix = name ? ` "${name}"` : '';
      return status === 'failed'
        ? `Failed to create task${suffix}`
        : status === 'past'
          ? `Created task${suffix}`
          : `Creating task${suffix}`;
    }
    case 'taskManager.listTasks':
      return status === 'failed'
        ? 'Failed to list tasks'
        : status === 'past'
          ? 'Listed tasks'
          : 'Listing tasks';
    case 'taskManager.updateTask': {
      const id = getStringParameter(parameters, ['taskId', 'id', 'name']) || 'task';
      return status === 'failed'
        ? `Failed to update ${id}`
        : status === 'past'
          ? `Updated ${id}`
          : `Updating ${id}`;
    }
    case 'taskManager.moveTask': {
      const id = getStringParameter(parameters, ['taskId', 'id', 'name']) || 'task';
      return status === 'failed'
        ? `Failed to move ${id}`
        : status === 'past'
          ? `Moved ${id}`
          : `Moving ${id}`;
    }
    case 'taskManager.queryTasks': {
      const query = formatQuery(parameters, ['query', 'filter', 'text']);
      const suffix = query ? ` matching ${query}` : '';
      return status === 'failed'
        ? `Failed to query tasks${suffix}`
        : status === 'past'
          ? `Queried tasks${suffix}`
          : `Querying tasks${suffix}`;
    }
    case 'taskManager.linkNote': {
      const note = getBaseName(getStringParameter(parameters, ['notePath', 'path', 'filePath'])) || 'note';
      return status === 'failed'
        ? `Failed to link ${note}`
        : status === 'past'
          ? `Linked ${note}`
          : `Linking ${note}`;
    }
    case 'promptManager.listModels':
      return status === 'failed'
        ? 'Failed to list models'
        : status === 'past'
          ? 'Listed models'
          : 'Listing models';
    case 'promptManager.executePrompts': {
      const name = getStringParameter(parameters, ['promptName', 'name', 'prompt', 'title']);
      const suffix = name ? ` "${name}"` : '';
      return status === 'failed'
        ? `Failed to run prompt${suffix}`
        : status === 'past'
          ? `Ran prompt${suffix}`
          : `Running prompt${suffix}`;
    }
    case 'promptManager.createPrompt': {
      const name = getStringParameter(parameters, ['name', 'promptName', 'title']);
      const suffix = name ? ` "${name}"` : '';
      return status === 'failed'
        ? `Failed to create prompt${suffix}`
        : status === 'past'
          ? `Created prompt${suffix}`
          : `Creating prompt${suffix}`;
    }
    case 'promptManager.updatePrompt': {
      const name = getStringParameter(parameters, ['name', 'promptName', 'id']) || 'prompt';
      return status === 'failed'
        ? `Failed to update ${name}`
        : status === 'past'
          ? `Updated ${name}`
          : `Updating ${name}`;
    }
    case 'promptManager.deletePrompt': {
      const name = getStringParameter(parameters, ['name', 'promptName', 'id']) || 'prompt';
      return status === 'failed'
        ? `Failed to delete ${name}`
        : status === 'past'
          ? `Deleted ${name}`
          : `Deleting ${name}`;
    }
    case 'promptManager.listPrompts':
      return status === 'failed'
        ? 'Failed to list prompts'
        : status === 'past'
          ? 'Listed prompts'
          : 'Listing prompts';
    case 'promptManager.getPrompt': {
      const name = getStringParameter(parameters, ['name', 'promptName', 'id']) || 'prompt';
      return status === 'failed'
        ? `Failed to load ${name}`
        : status === 'past'
          ? `Loaded ${name}`
          : `Loading ${name}`;
    }
    case 'promptManager.generateImage': {
      const query = formatQuery(parameters, ['prompt', 'description', 'query']);
      const suffix = query ? ` from ${query}` : '';
      return status === 'failed'
        ? `Failed to generate image${suffix}`
        : status === 'past'
          ? `Generated image${suffix}`
          : `Generating image${suffix}`;
    }
    case 'canvasManager.read': {
      const target = getBaseName(getStringParameter(parameters, ['path', 'filePath', 'canvasPath'])) || 'canvas';
      return status === 'failed'
        ? `Failed to read ${target}`
        : status === 'past'
          ? `Read ${target}`
          : `Reading ${target}`;
    }
    case 'canvasManager.write': {
      const target = getBaseName(getStringParameter(parameters, ['path', 'filePath', 'canvasPath'])) || 'canvas';
      return status === 'failed'
        ? `Failed to create ${target}`
        : status === 'past'
          ? `Created ${target}`
          : `Creating ${target}`;
    }
    case 'canvasManager.update': {
      const target = getBaseName(getStringParameter(parameters, ['path', 'filePath', 'canvasPath'])) || 'canvas';
      return status === 'failed'
        ? `Failed to update ${target}`
        : status === 'past'
          ? `Updated ${target}`
          : `Updating ${target}`;
    }
    case 'canvasManager.list': {
      const target = getBaseName(getStringParameter(parameters, ['path', 'directory', 'folderPath'])) || 'folder';
      return status === 'failed'
        ? `Failed to list canvases in ${target}`
        : status === 'past'
          ? `Listed canvases in ${target}`
          : `Listing canvases in ${target}`;
    }
    case 'webTools.openWebpage': {
      const url = getStringParameter(parameters, ['url', 'link', 'address']);
      const suffix = url ? ` ${url}` : '';
      return status === 'failed'
        ? `Failed to open${suffix}`
        : status === 'past'
          ? `Opened${suffix}`
          : `Opening${suffix}`;
    }
    case 'webTools.capturePagePdf': {
      const url = getStringParameter(parameters, ['url', 'link']);
      const suffix = url ? ` ${url}` : '';
      return status === 'failed'
        ? `Failed to capture PDF${suffix}`
        : status === 'past'
          ? `Captured PDF${suffix}`
          : `Capturing PDF${suffix}`;
    }
    case 'webTools.capturePagePng': {
      const url = getStringParameter(parameters, ['url', 'link']);
      const suffix = url ? ` ${url}` : '';
      return status === 'failed'
        ? `Failed to capture screenshot${suffix}`
        : status === 'past'
          ? `Captured screenshot${suffix}`
          : `Capturing screenshot${suffix}`;
    }
    case 'webTools.captureToMarkdown': {
      const url = getStringParameter(parameters, ['url', 'link']);
      const suffix = url ? ` ${url}` : '';
      return status === 'failed'
        ? `Failed to convert${suffix} to markdown`
        : status === 'past'
          ? `Converted${suffix} to markdown`
          : `Converting${suffix} to markdown`;
    }
    case 'webTools.extractLinks': {
      const url = getStringParameter(parameters, ['url', 'link']);
      const suffix = url ? ` from ${url}` : '';
      return status === 'failed'
        ? `Failed to extract links${suffix}`
        : status === 'past'
          ? `Extracted links${suffix}`
          : `Extracting links${suffix}`;
    }
    case 'composer.compose': {
      const format = getStringParameter(parameters, ['format', 'outputFormat', 'type']);
      const suffix = format ? ` ${format}` : '';
      return status === 'failed'
        ? `Failed to compose${suffix}`
        : status === 'past'
          ? `Composed${suffix}`
          : `Composing${suffix}`;
    }
    case 'composer.listFormats':
      return status === 'failed'
        ? 'Failed to list formats'
        : status === 'past'
          ? 'Listed formats'
          : 'Listing formats';
    case 'ingestManager.ingest': {
      const target = getBaseName(getStringParameter(parameters, ['path', 'filePath', 'file', 'source'])) || 'file';
      return status === 'failed'
        ? `Failed to ingest ${target}`
        : status === 'past'
          ? `Ingested ${target}`
          : `Ingesting ${target}`;
    }
    case 'ingestManager.listCapabilities':
      return status === 'failed'
        ? 'Failed to list ingest capabilities'
        : status === 'past'
          ? 'Listed ingest capabilities'
          : 'Listing ingest capabilities';
  }

  const fallbackAction = toTitleCase(action);
  return status === 'failed'
    ? `Failed to run ${fallbackAction}`
    : status === 'past'
      ? `Ran ${fallbackAction}`
      : `Running ${fallbackAction}`;
}

export function formatToolGroupHeader(group: Pick<ToolDisplayGroup, 'kind' | 'status' | 'strategy' | 'steps' | 'displayName'> & { id?: string; technicalName?: string; isVirtual?: boolean }): string {
  if (group.kind === 'reasoning') {
    return 'Reasoning';
  }

  if (group.kind === 'discovery') {
    return formatDiscoveryLabel(group.status);
  }

  const technicalName = group.technicalName?.replace(/_/g, '.');
  if ((technicalName === 'useTools' || technicalName?.endsWith('.useTools')) && group.steps.length === 0) {
    if (group.status === 'failed') {
      return 'Failed to prepare actions';
    }

    if (group.status === 'completed') {
      return 'Prepared actions';
    }

    return 'Preparing actions';
  }

  const total = group.steps.length;
  const completedCount = group.steps.filter(step => step.status === 'completed').length;
  const failedCount = group.steps.filter(step => step.status === 'failed').length;
  const activeSteps = group.steps.filter(step => step.status === 'executing' || step.status === 'streaming' || step.status === 'pending' || step.status === 'queued');
  const currentStep = activeSteps[0] || group.steps[0];

  if (group.status === 'failed') {
    if (group.strategy === 'serial' && group.steps.some(step => step.status === 'skipped')) {
      const executedCount = completedCount + failedCount;
      return `Failed after ${executedCount} of ${total} actions`;
    }

    if (total === 1 && currentStep) {
      return formatToolStepLabel(currentStep, 'failed');
    }

    if (failedCount > 0) {
      return `Completed ${completedCount} actions, ${failedCount} failed`;
    }

    return `Failed ${total} actions`;
  }

  if (group.status === 'completed') {
    const summarized = summarizePastSteps(group.steps);
    if (summarized) {
      return summarized;
    }

    if (total === 1 && currentStep) {
      return formatToolStepLabel(currentStep, 'past');
    }

    if (failedCount > 0) {
      return `Completed ${completedCount} actions, ${failedCount} failed`;
    }

    return `Completed ${completedCount || total} actions`;
  }

  if (group.strategy === 'serial') {
    if (currentStep) {
      const label = formatToolStepLabel(currentStep, 'present');
      const queuedCount = group.steps.filter(step => step.status === 'queued' || step.status === 'pending').length;
      return queuedCount > 0 ? `${label}, ${queuedCount} more queued` : label;
    }
  }

  const runningLabels = activeSteps.slice(0, 2).map(step => formatToolStepLabel(step, 'present'));
  if (runningLabels.length === 1) {
    const remaining = total - 1;
    return remaining > 0 ? `${runningLabels[0]}, +${remaining} more` : runningLabels[0];
  }

  if (runningLabels.length > 1) {
    const remaining = total - runningLabels.length;
    return remaining > 0 ? `${runningLabels.join(', ')}, +${remaining} more` : runningLabels.join(', ');
  }

  if (group.displayName) {
    return group.displayName;
  }

  return 'Running tools';
}

export function formatToolDisplayLabel(step: Partial<Pick<ToolDisplayStep, 'technicalName' | 'parameters' | 'displayName' | 'actionName' | 'isVirtual'>> & { result?: unknown; error?: string; status?: ToolDisplayStatus }): string {
  return formatToolStepLabel(step, step.status === 'failed' ? 'failed' : step.status === 'completed' ? 'past' : 'present');
}

export function formatFallbackToolName(technicalName?: string): string {
  if (!technicalName) {
    return 'Tool';
  }

  return formatToolDisplayName(technicalName);
}
