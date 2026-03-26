import {
  TraceContextMetadata,
  TraceInputMetadata,
  TraceMetadata,
  TraceOutcomeMetadata,
  TraceToolMetadata
} from '../../database/workspace-types';
import { TraceMetadataBuilder } from './TraceMetadataBuilder';

export interface LegacyTraceNormalizationInput {
  workspaceId: string;
  sessionId: string;
  traceType?: string;
  metadata?: unknown;
}

type LegacyRecord = Record<string, unknown>;

function asLegacyRecord(value: unknown): LegacyRecord | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as LegacyRecord)
    : undefined;
}

function getLegacyProperty<T>(value: unknown, key: string): T | undefined {
  return asLegacyRecord(value)?.[key] as T | undefined;
}

function getNestedLegacyProperty<T>(value: unknown, ...keys: string[]): T | undefined {
  let current: unknown = value;

  for (const key of keys) {
    current = getLegacyProperty<unknown>(current, key);
    if (current === undefined) {
      return undefined;
    }
  }

  return current as T | undefined;
}

export function normalizeLegacyTraceMetadata(
  input: LegacyTraceNormalizationInput
): TraceMetadata | undefined {
  const rawMetadata = input.metadata;
  if (!rawMetadata) {
    return undefined;
  }

  if (getLegacyProperty<unknown>(rawMetadata, 'schemaVersion')) {
    return rawMetadata as TraceMetadata;
  }

  const toolMetadata = buildToolMetadata(
    getLegacyProperty<string>(rawMetadata, 'tool') || input.traceType || 'unknown'
  );
  const context = buildContextMetadata(input.workspaceId, input.sessionId, rawMetadata);
  const relatedFiles = getLegacyProperty<string[]>(rawMetadata, 'relatedFiles');
  const inputFiles =
    Array.isArray(relatedFiles) && relatedFiles.length > 0
      ? relatedFiles
      : undefined;
  const inputSection = buildInputMetadata(rawMetadata, inputFiles);
  const outcome = buildOutcome(rawMetadata);

  return TraceMetadataBuilder.create({
    tool: toolMetadata,
    context,
    input: inputSection,
    outcome,
    legacy: TraceMetadataBuilder.extractLegacyFromMetadata(rawMetadata)
  });
}

function buildToolMetadata(toolId: string): TraceToolMetadata {
  const normalizedId = toolId.includes('.') ? toolId : toolId.replace(/_/g, '.');
  const [agent, mode] = normalizedId.split('.', 2);

  return {
    id: normalizedId,
    agent: agent || normalizedId || 'unknown',
    mode: mode || 'unknown'
  };
}

function buildContextMetadata(
  workspaceId: string,
  sessionId: string,
  rawMetadata: unknown
): TraceContextMetadata {
  const legacyContext =
    getNestedLegacyProperty<unknown>(rawMetadata, 'params', 'context') ||
    getLegacyProperty<unknown>(rawMetadata, 'context') ||
    {};

  // Check if new format (memory/goal/constraints) is present
  const hasNewFormat =
    getLegacyProperty<unknown>(legacyContext, 'memory') ||
    getLegacyProperty<unknown>(legacyContext, 'goal');

  if (hasNewFormat) {
    // Return new format (TraceContextMetadataV2)
    return {
      workspaceId,
      sessionId,
      memory: getLegacyProperty<string>(legacyContext, 'memory') || '',
      goal: getLegacyProperty<string>(legacyContext, 'goal') || '',
      constraints: getLegacyProperty<string>(legacyContext, 'constraints'),
      tags: getLegacyProperty<string[]>(legacyContext, 'tags')
    };
  }

  // Return legacy format (LegacyTraceContextMetadata) for backward compatibility
  const additionalContext =
    getLegacyProperty<Record<string, unknown>>(legacyContext, 'additionalContext') ||
    getLegacyProperty<Record<string, unknown>>(rawMetadata, 'additionalContext');

  return {
    workspaceId,
    sessionId,
    sessionDescription: getLegacyProperty<string>(legacyContext, 'sessionDescription'),
    sessionMemory: getLegacyProperty<string>(legacyContext, 'sessionMemory'),
    toolContext: getLegacyProperty<Record<string, unknown>>(legacyContext, 'toolContext'),
    primaryGoal: getLegacyProperty<string>(legacyContext, 'primaryGoal'),
    subgoal: getLegacyProperty<string>(legacyContext, 'subgoal'),
    tags: getLegacyProperty<string[]>(legacyContext, 'tags'),
    additionalContext
  };
}

function buildInputMetadata(rawMetadata: unknown, files?: string[]): TraceInputMetadata | undefined {
  let normalizedArgs = getLegacyProperty<unknown>(rawMetadata, 'params');
  if (
    normalizedArgs &&
    typeof normalizedArgs === 'object' &&
    !Array.isArray(normalizedArgs)
  ) {
    const rest = { ...(normalizedArgs as LegacyRecord) };
    delete rest.context;
    normalizedArgs = Object.keys(rest).length > 0 ? rest : undefined;
  }

  const hasArguments = normalizedArgs !== undefined;
  const hasFiles = Array.isArray(files) && files.length > 0;

  if (!hasArguments && !hasFiles) {
    return undefined;
  }

  return {
    arguments: normalizedArgs,
    files: hasFiles ? files : undefined
  };
}

function buildOutcome(rawMetadata: unknown): TraceOutcomeMetadata {
  const result = getLegacyProperty<unknown>(rawMetadata, 'result');
  const response = getLegacyProperty<unknown>(rawMetadata, 'response');
  const resultSuccess = getLegacyProperty<boolean>(result, 'success');
  const responseSuccess = getLegacyProperty<boolean>(response, 'success');
  const success =
    typeof resultSuccess === 'boolean'
      ? resultSuccess
      : typeof responseSuccess === 'boolean'
        ? responseSuccess
        : true;

  const errorSource =
    getLegacyProperty<unknown>(result, 'error') || getLegacyProperty<unknown>(response, 'error');
  const errorMessage = getLegacyProperty<string>(errorSource, 'message');

  const error =
    errorSource && (errorMessage || typeof errorSource === 'string')
      ? {
          type: getLegacyProperty<string>(errorSource, 'type'),
          message:
            errorMessage || (typeof errorSource === 'string' ? errorSource : 'Unknown error'),
          code: getLegacyProperty<string | number>(errorSource, 'code')
        }
      : undefined;

  return {
    success,
    error
  };
}
