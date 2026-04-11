import { formatToolDisplayName } from '../../../utils/toolNameUtils';
import type { ToolDisplayGroup, ToolDisplayStep, ToolDisplayStatus } from './toolDisplayNormalizer';
import type { ToolStatusLabelResolver } from '../services/ToolStatusLabelResolver';
import type { ToolStatusTense } from '../../../agents/interfaces/ITool';

type DisplayTense = ToolStatusTense;

// ---------------------------------------------------------------------------
// Resolver wiring
// ---------------------------------------------------------------------------
//
// The UI layer looks up tool status labels via a ToolStatusLabelResolver —
// a lightweight service that routes `technicalName` to the owning tool's
// `getStatusLabel()` override. The resolver is installed once at plugin
// init by the chat layer and stored in module-level state so every caller
// of `formatToolStepLabel` shares the same route.
//
// When the resolver is unset (unit tests, startup race), or when a tool
// doesn't override `getStatusLabel`, the formatter falls back to a
// generic "Running {action}" label derived from the action name.

let activeResolver: ToolStatusLabelResolver | null = null;

export function setToolStatusLabelResolver(resolver: ToolStatusLabelResolver | null): void {
  activeResolver = resolver;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
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

function normalizeStatusToTense(status: ToolDisplayStatus | undefined, tense: DisplayTense | undefined): DisplayTense {
  if (tense) return tense;
  if (status === 'failed') return 'failed';
  if (status === 'completed') return 'past';
  return 'present';
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function formatToolStepLabel(
  step: Partial<Pick<ToolDisplayStep, 'technicalName' | 'parameters' | 'displayName' | 'actionName' | 'isVirtual'>> & { result?: unknown; error?: string; status?: ToolDisplayStatus },
  tense?: DisplayTense
): string {
  const technicalName = step.technicalName ? step.technicalName.replace(/_/g, '.') : '';
  const action = getActionName(step);
  const effectiveTense = normalizeStatusToTense(step.status, tense);

  // Special-case: tool discovery wrapper (getTools meta-call).
  if (technicalName === 'getTools' || technicalName.endsWith('.getTools')) {
    return formatDiscoveryLabel(step.status || 'executing');
  }

  // Special-case: useTools wrapper (two-tool architecture meta-call).
  const isUseToolsWrapper =
    technicalName === 'useTools' ||
    technicalName.endsWith('.useTools') ||
    action === 'Use Tools';

  if (isUseToolsWrapper) {
    if (effectiveTense === 'failed') return 'Failed to prepare actions';
    if (effectiveTense === 'past') return 'Prepared actions';
    return 'Preparing actions';
  }

  // Colocated path: ask the owning tool via the resolver.
  const resolved = activeResolver?.resolve(technicalName, step.parameters, effectiveTense);
  if (resolved) {
    return resolved;
  }

  // Generic fallback for tools that don't override getStatusLabel.
  const fallbackAction = toTitleCase(action);
  if (effectiveTense === 'failed') return `Failed to run ${fallbackAction}`;
  if (effectiveTense === 'past') return `Ran ${fallbackAction}`;
  return `Running ${fallbackAction}`;
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
