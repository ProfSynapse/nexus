import { getToolNameMetadata, normalizeToolName } from '../../../utils/toolNameUtils';
import { formatToolDisplayLabel, formatToolGroupHeader, formatToolStepLabel } from './toolDisplayFormatter';

export type ToolDisplayStatus = 'pending' | 'streaming' | 'queued' | 'executing' | 'completed' | 'failed' | 'skipped';

export type ToolDisplayGroupKind = 'single' | 'batch' | 'reasoning' | 'discovery';

export interface ToolDisplayStep {
  id: string;
  displayName: string;
  technicalName?: string;
  parameters?: Record<string, unknown>;
  result?: unknown;
  error?: string;
  status: ToolDisplayStatus;
  isVirtual?: boolean;
  agentName?: string;
  actionName?: string;
  startTime?: number;
  executionTime?: number;
  parametersComplete?: boolean;
  batchId?: string;
  parentToolCallId?: string;
  callIndex?: number;
  totalCalls?: number;
}

export interface ToolDisplayGroup {
  id: string;
  displayName: string;
  technicalName?: string;
  kind: ToolDisplayGroupKind;
  strategy?: 'serial' | 'parallel';
  status: ToolDisplayStatus;
  steps: ToolDisplayStep[];
  isVirtual?: boolean;
}

interface ToolCallLike {
  id?: string;
  stepId?: string;
  toolId?: string;
  parentToolCallId?: string;
  batchId?: string;
  callIndex?: number;
  totalCalls?: number;
  strategy?: string;
  parametersComplete?: boolean;
  name?: string;
  displayName?: string;
  technicalName?: string;
  type?: string;
  parameters?: unknown;
  result?: unknown;
  error?: string;
  success?: boolean;
  status?: string;
  isVirtual?: boolean;
  function?: {
    name?: string;
    arguments?: string;
  };
  arguments?: string;
}

interface UseToolCallLike {
  agent?: string;
  tool?: string;
  params?: Record<string, unknown>;
  parameters?: Record<string, unknown>;
  continueOnFailure?: boolean;
}

interface UseToolResultLike {
  success?: boolean;
  error?: string;
  data?: {
    results?: Array<{
      agent?: string;
      tool?: string;
      success?: boolean;
      error?: string;
      data?: unknown;
    }>;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function parseParameterValue(value: unknown): unknown {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }

  return value;
}

function getToolCallArguments(toolCall: ToolCallLike): unknown {
  if (!toolCall) {
    return undefined;
  }

  if (toolCall.function && typeof toolCall.function === 'object' && 'arguments' in toolCall.function) {
    return toolCall.function.arguments;
  }

  return toolCall.arguments;
}

function normalizeTechnicalName(toolCall: ToolCallLike): string {
  const rawName =
    toolCall.technicalName ??
    toolCall.name ??
    toolCall.function?.name ??
    'Unknown Tool';

  return normalizeToolName(rawName) ?? rawName;
}

function isDiscoveryCall(technicalName: string): boolean {
  return technicalName === 'getTools' || technicalName.endsWith('.getTools');
}

function isUseToolsCall(technicalName: string): boolean {
  return technicalName === 'useTools' ||
    technicalName.endsWith('.useTools') ||
    technicalName === 'useTool' ||
    technicalName.endsWith('.useTool');
}

function getPersistedTerminalStatus(toolCall: ToolCallLike): ToolDisplayStatus | undefined {
  if (toolCall.status) {
    return toolCall.status as ToolDisplayStatus;
  }

  if (toolCall.success === false) {
    return 'failed';
  }

  if (toolCall.success === true || toolCall.result !== undefined) {
    return 'completed';
  }

  return undefined;
}

function normalizeUseToolParams(toolCall: ToolCallLike): Record<string, unknown> {
  const directParams = toolCall.parameters;
  const fallbackArguments = getToolCallArguments(toolCall);
  const parsed = parseParameterValue(directParams !== undefined ? directParams : fallbackArguments);
  return isRecord(parsed) ? parsed : {};
}

function normalizeUseToolResults(result: UseToolResultLike | undefined): Array<{ agent?: string; tool?: string; success?: boolean; error?: string; data?: unknown }> {
  return result?.data?.results || [];
}

function getInnerCallTechnicalName(
  call?: UseToolCallLike,
  result?: { agent?: string; tool?: string }
): string | undefined {
  const agent = result?.agent || call?.agent;
  const tool = result?.tool || call?.tool;

  if (!isNonEmptyString(agent) || !isNonEmptyString(tool)) {
    return undefined;
  }

  return `${agent}.${tool}`;
}

function cloneStep(step: ToolDisplayStep): ToolDisplayStep {
  return { ...step };
}

function getBatchId(toolCall: ToolCallLike): string | undefined {
  const candidates = [
    toolCall.parentToolCallId,
    toolCall.batchId,
    toolCall.toolId,
    toolCall.stepId
  ];

  for (const candidate of candidates) {
    if (isNonEmptyString(candidate)) {
      return candidate.trim();
    }
  }

  return undefined;
}

function isLiveBatchToolCall(toolCall: ToolCallLike): boolean {
  return (
    typeof toolCall.callIndex === 'number' ||
    typeof toolCall.totalCalls === 'number' ||
    isNonEmptyString(toolCall.parentToolCallId) ||
    isNonEmptyString(toolCall.batchId)
  );
}

function getLiveBatchStrategy(toolCall: ToolCallLike, existingGroup?: ToolDisplayGroup | null): 'serial' | 'parallel' {
  if (toolCall.strategy === 'parallel') {
    return 'parallel';
  }

  if (toolCall.strategy === 'serial') {
    return 'serial';
  }

  return existingGroup?.strategy || 'serial';
}

function getLiveBatchStatus(toolCall: ToolCallLike): ToolDisplayStatus {
  const rawStatus = typeof toolCall.status === 'string' ? toolCall.status.toLowerCase() : '';

  if (rawStatus === 'completed') {
    return toolCall.success === false ? 'failed' : 'completed';
  }

  if (rawStatus === 'failed') {
    return 'failed';
  }

  if (rawStatus === 'streaming' || rawStatus === 'executing' || rawStatus === 'started') {
    return 'executing';
  }

  if (toolCall.success === false) {
    return 'failed';
  }

  if (toolCall.result !== undefined) {
    return 'completed';
  }

  return 'executing';
}

function createPlaceholderStep(
  batchId: string,
  index: number,
  strategy: 'serial' | 'parallel',
  currentIndex: number | null,
  currentStatus: ToolDisplayStatus
): ToolDisplayStep {
  const status =
    index === currentIndex
      ? currentStatus
      : strategy === 'serial'
        ? 'queued'
        : 'pending';

  return {
    id: `${batchId}_${index}`,
    displayName: status === 'queued'
      ? 'Queued action'
      : status === 'pending'
        ? 'Pending action'
        : 'Running action',
    technicalName: undefined,
    status,
    isVirtual: false
  };
}

function updateStepFromToolCall(
  step: ToolDisplayStep,
  toolCall: ToolCallLike,
  status: ToolDisplayStatus
): ToolDisplayStep {
  const technicalName = normalizeTechnicalName(toolCall);
  const metadata = getToolNameMetadata(technicalName);
  const parametersValue = parseParameterValue(
    toolCall.parameters !== undefined ? toolCall.parameters : getToolCallArguments(toolCall)
  );
  const parameters = isRecord(parametersValue) ? parametersValue : undefined;
  const result = toolCall.result;
  const error = toolCall.error;

  const updatedStep: ToolDisplayStep = {
    ...step,
    technicalName,
    parameters: parameters ?? step.parameters,
    result: result !== undefined ? result : step.result,
    error: error !== undefined ? error : step.error,
    status,
    isVirtual: toolCall.isVirtual ?? step.isVirtual,
    agentName: metadata.agentName,
    actionName: metadata.actionName,
    displayName: formatToolDisplayLabel({
      technicalName,
      parameters: parameters ?? step.parameters,
      status,
      result: result !== undefined ? result : step.result,
      error: error !== undefined ? error : step.error
    })
  };

  if (status === 'executing' && !updatedStep.startTime) {
    updatedStep.startTime = Date.now();
  }

  if (step.startTime) {
    updatedStep.startTime = step.startTime;
  }

  if (step.executionTime) {
    updatedStep.executionTime = step.executionTime;
  }

  if ((status === 'completed' || status === 'failed') && updatedStep.startTime && !updatedStep.executionTime) {
    updatedStep.executionTime = Date.now() - updatedStep.startTime;
  }

  return updatedStep;
}

function buildLiveBatchGroup(
  toolCall: ToolCallLike,
  existingGroup?: ToolDisplayGroup | null
): ToolDisplayGroup {
  const batchId = getBatchId(toolCall) || existingGroup?.id || normalizeTechnicalName(toolCall);
  const technicalName = normalizeTechnicalName(toolCall);
  const strategy = getLiveBatchStrategy(toolCall, existingGroup);
  const totalCalls = Math.max(
    toolCall.totalCalls || existingGroup?.steps.length || 1,
    1
  );
  const currentStatus = getLiveBatchStatus(toolCall);
  const currentIndex = typeof toolCall.callIndex === 'number' && toolCall.callIndex >= 0
    ? toolCall.callIndex
    : null;
  const currentStepId = isNonEmptyString(toolCall.stepId)
    ? toolCall.stepId.trim()
    : isNonEmptyString(toolCall.id)
      ? toolCall.id.trim()
      : currentIndex !== null
        ? `${batchId}_${currentIndex}`
        : batchId;

  const steps = existingGroup
    ? existingGroup.steps.map(step => cloneStep(step))
    : Array.from({ length: totalCalls }, (_, index) => createPlaceholderStep(batchId, index, strategy, currentIndex, currentStatus));

  while (steps.length < totalCalls) {
    const index = steps.length;
    steps.push(createPlaceholderStep(batchId, index, strategy, currentIndex, currentStatus));
  }

  const targetIndex = currentIndex !== null
    ? currentIndex
    : Math.max(steps.findIndex(step => step.id === currentStepId), 0);

  while (steps.length <= targetIndex) {
    steps.push(createPlaceholderStep(batchId, steps.length, strategy, targetIndex, currentStatus));
  }

  const updatedStep = updateStepFromToolCall(
    steps[targetIndex] || createPlaceholderStep(batchId, targetIndex, strategy, targetIndex, currentStatus),
    {
      ...toolCall,
      id: currentStepId
    },
    currentStatus
  );
  updatedStep.id = currentStepId;
  updatedStep.parametersComplete = toolCall.parametersComplete !== undefined
    ? Boolean(toolCall.parametersComplete)
    : updatedStep.parametersComplete;
  updatedStep.callIndex = currentIndex ?? updatedStep.callIndex;
  updatedStep.totalCalls = totalCalls;
  updatedStep.batchId = batchId;
  updatedStep.parentToolCallId = toolCall.parentToolCallId || batchId;

  steps[targetIndex] = updatedStep;

  const status = computeGroupStatusFromSteps(steps);

  return {
    id: batchId,
    displayName: formatToolGroupHeader({
      id: batchId,
      displayName: existingGroup?.displayName || toolCall.displayName || toolCall.name || technicalName,
      technicalName,
      kind: 'batch',
      strategy,
      status,
      steps,
      isVirtual: toolCall.isVirtual ?? existingGroup?.isVirtual
    }),
    technicalName,
    kind: 'batch',
    strategy,
    status,
    steps,
    isVirtual: toolCall.isVirtual ?? existingGroup?.isVirtual
  };
}

function computeGroupStatusFromSteps(steps: ToolDisplayStep[]): ToolDisplayStatus {
  if (steps.some(step => step.status === 'failed')) {
    return 'failed';
  }

  if (steps.length > 0 && steps.every(step => step.status === 'completed')) {
    return 'completed';
  }

  if (steps.some(step => step.status === 'executing')) {
    return 'executing';
  }

  if (steps.some(step => step.status === 'streaming')) {
    return 'streaming';
  }

  if (steps.some(step => step.status === 'queued')) {
    return 'pending';
  }

  return 'pending';
}

function buildSingleStep(toolCall: ToolCallLike, status: ToolDisplayStatus): ToolDisplayStep {
  const technicalName = normalizeTechnicalName(toolCall);
  const metadata = getToolNameMetadata(technicalName);
  const parametersValue = parseParameterValue(
    toolCall.parameters !== undefined ? toolCall.parameters : getToolCallArguments(toolCall)
  );
  const parameters = isRecord(parametersValue) ? parametersValue : undefined;

  return {
    id: toolCall.id || technicalName,
    displayName: formatToolDisplayLabel({
      technicalName,
      parameters,
      status,
      result: toolCall.result
    }),
    technicalName,
    parameters,
    result: toolCall.result,
    error: toolCall.error,
    status,
    isVirtual: toolCall.isVirtual,
    agentName: metadata.agentName,
    actionName: metadata.actionName
  };
}

function buildDiscoveryStep(toolCall: ToolCallLike): ToolDisplayStep {
  const technicalName = normalizeTechnicalName(toolCall);
  const parametersValue = parseParameterValue(
    toolCall.parameters !== undefined ? toolCall.parameters : getToolCallArguments(toolCall)
  );
  const parameters = isRecord(parametersValue) ? parametersValue : undefined;
  const status = getPersistedTerminalStatus(toolCall) || 'executing';

  return {
    id: toolCall.id || technicalName,
    displayName: formatToolDisplayLabel({
      technicalName,
      parameters,
      status,
      result: toolCall.result
    }),
    technicalName,
    parameters,
    result: toolCall.result,
    error: toolCall.error,
    status
  };
}

function buildUseToolGroup(toolCall: ToolCallLike): ToolDisplayGroup {
  const technicalName = normalizeTechnicalName(toolCall);
  const params = normalizeUseToolParams(toolCall);
  const strategy = params.strategy === 'parallel' ? 'parallel' : 'serial';
  const calls = Array.isArray(params.calls) ? params.calls : [];
  let results = normalizeUseToolResults(toolCall.result as UseToolResultLike | undefined);
  const rawStatus = (toolCall.status) || '';
  const isCompleted = rawStatus === 'completed' || Boolean(toolCall.result && toolCall.success !== false);
  const isFailed = rawStatus === 'failed' || toolCall.success === false;

  if (results.length === 0 && calls.length === 1 && isRecord(toolCall.result)) {
    const directResult = toolCall.result;
    results = [{
      success: directResult.success !== false,
      error: typeof directResult.error === 'string' ? directResult.error : undefined,
      data: directResult
    }];
  }

  const steps: ToolDisplayStep[] = [];

  if (calls.length > 0) {
    for (let index = 0; index < calls.length; index += 1) {
      const call = calls[index] as UseToolCallLike;
      const result = results[index];
      const fullTechnicalName = getInnerCallTechnicalName(call, result) || technicalName;
      const paramsValue = parseParameterValue(call.params || call.parameters || {});
      const parameters = isRecord(paramsValue) ? paramsValue : undefined;

      let status: ToolDisplayStatus = 'pending';
      if (result) {
        status = result.success === false ? 'failed' : 'completed';
      } else if (calls.length === 1 && isCompleted && isRecord(toolCall.result)) {
        status = isFailed ? 'failed' : 'completed';
      } else if (isFailed && strategy === 'serial' && index >= results.length) {
        status = 'skipped';
      } else if (rawStatus === 'executing' || rawStatus === 'streaming') {
        if (strategy === 'parallel') {
          status = 'executing';
        } else if (index === 0) {
          status = 'executing';
        } else {
          status = 'queued';
        }
      } else if (strategy === 'serial' && index > 0) {
        status = 'queued';
      }

      const metadata = getToolNameMetadata(fullTechnicalName);
      steps.push({
        id: `${toolCall.id || technicalName}_${index}`,
        displayName: formatToolDisplayLabel({
          technicalName: fullTechnicalName,
          parameters,
          status,
          result: result?.data ?? (calls.length === 1 && isRecord(toolCall.result) ? toolCall.result : undefined)
        }),
        technicalName: fullTechnicalName,
        parameters,
        result: result?.data ?? (calls.length === 1 && isRecord(toolCall.result) ? toolCall.result : undefined),
        error: result?.error ?? (calls.length === 1 && isFailed ? toolCall.error : undefined),
        status,
        agentName: metadata.agentName,
        actionName: metadata.actionName
      });
    }
  } else if (results.length > 0) {
    results.forEach((result, index) => {
      const fallbackCall = Array.isArray(params.calls) ? params.calls[index] as UseToolCallLike | undefined : undefined;
      const fullTechnicalName = getInnerCallTechnicalName(fallbackCall, result) || technicalName;
      const metadata = getToolNameMetadata(fullTechnicalName);
      const status: ToolDisplayStatus = result.success === false ? 'failed' : 'completed';
      steps.push({
        id: `${toolCall.id || technicalName}_${index}`,
        displayName: formatToolDisplayLabel({
          technicalName: fullTechnicalName,
          status,
          result: result.data
        }),
        technicalName: fullTechnicalName,
        result: result.data,
        error: result.error,
        status,
        agentName: metadata.agentName,
        actionName: metadata.actionName
      });
    });
  }

  const status = isFailed
    ? 'failed'
    : isCompleted
      ? 'completed'
      : rawStatus === 'executing' || rawStatus === 'streaming'
        ? 'executing'
        : 'pending';

  return {
    id: toolCall.id || technicalName,
    displayName: formatToolGroupHeader({
      id: toolCall.id || technicalName,
      displayName: toolCall.displayName || toolCall.name || technicalName,
      technicalName,
      kind: 'batch',
      strategy,
      status,
      steps,
      isVirtual: toolCall.isVirtual
    }),
    technicalName,
    kind: 'batch',
    strategy,
    status,
    steps,
    isVirtual: toolCall.isVirtual
  };
}

function buildReasoningGroup(toolCall: ToolCallLike): ToolDisplayGroup {
  const technicalName = normalizeTechnicalName(toolCall);
  const step: ToolDisplayStep = {
    id: toolCall.id || technicalName,
    displayName: 'Reasoning',
    technicalName,
    result: toolCall.result,
    error: toolCall.error,
    status: (toolCall.status as ToolDisplayStatus) || 'streaming',
    isVirtual: true
  };

  return {
    id: toolCall.id || technicalName,
    displayName: 'Reasoning',
    technicalName,
    kind: 'reasoning',
    status: step.status,
    steps: [step],
    isVirtual: true
  };
}

function buildDiscoveryGroup(toolCall: ToolCallLike): ToolDisplayGroup {
  const technicalName = normalizeTechnicalName(toolCall);
  const status = getPersistedTerminalStatus(toolCall) || 'executing';
  const step = buildDiscoveryStep(toolCall);

  return {
    id: toolCall.id || technicalName,
    displayName: formatToolGroupHeader({
      id: toolCall.id || technicalName,
      displayName: toolCall.displayName || toolCall.name || technicalName,
      technicalName,
      kind: 'discovery',
      status,
      steps: [step],
      isVirtual: toolCall.isVirtual
    }),
    technicalName,
    kind: 'discovery',
    status,
    steps: [step],
    isVirtual: toolCall.isVirtual
  };
}

export function normalizeToolCallForDisplay(toolCall: ToolCallLike, existingGroup?: ToolDisplayGroup | null): ToolDisplayGroup {
  const technicalName = normalizeTechnicalName(toolCall);

  if (toolCall.type === 'reasoning') {
    return buildReasoningGroup(toolCall);
  }

  if (isDiscoveryCall(technicalName)) {
    return buildDiscoveryGroup(toolCall);
  }

  if (isLiveBatchToolCall(toolCall)) {
    return buildLiveBatchGroup(toolCall, existingGroup);
  }

  if (isUseToolsCall(technicalName)) {
    return buildUseToolGroup(toolCall);
  }

  const status = getPersistedTerminalStatus(toolCall) || 'executing';

  return {
    id: toolCall.id || technicalName,
    displayName: formatToolStepLabel({
      displayName: toolCall.displayName || toolCall.name || technicalName,
      technicalName,
      parameters: isRecord(parseParameterValue(toolCall.parameters !== undefined ? toolCall.parameters : getToolCallArguments(toolCall)))
        ? (parseParameterValue(toolCall.parameters !== undefined ? toolCall.parameters : getToolCallArguments(toolCall)) as Record<string, unknown>)
        : undefined,
      result: toolCall.result,
      error: toolCall.error,
      status,
      isVirtual: toolCall.isVirtual
    }),
    technicalName,
    kind: 'single',
    status,
    steps: [buildSingleStep(toolCall, status)],
    isVirtual: toolCall.isVirtual
  };
}

export function normalizeToolCallsForDisplay(toolCalls: ToolCallLike[] | undefined | null): ToolDisplayGroup[] {
  if (!toolCalls || toolCalls.length === 0) {
    return [];
  }

  return toolCalls.map(toolCall => normalizeToolCallForDisplay(toolCall));
}
