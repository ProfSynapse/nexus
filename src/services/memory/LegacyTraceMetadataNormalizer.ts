import {
  TraceContextMetadata,
  TraceInputMetadata,
  TraceMetadata,
  TraceOutcomeMetadata,
  TraceToolMetadata
} from '../../database/workspace-types';
import { TraceMetadataBuilder } from './TraceMetadataBuilder';

interface LegacyTraceContextLike extends Record<string, unknown> {
  workspaceId?: string;
  sessionId?: string;
  memory?: string;
  goal?: string;
  constraints?: string;
  tags?: string[];
  sessionDescription?: string;
  sessionMemory?: string;
  toolContext?: Record<string, unknown>;
  primaryGoal?: string;
  subgoal?: string;
  additionalContext?: Record<string, unknown>;
}

interface LegacyTraceOutcomeLike extends Record<string, unknown> {
  success?: boolean;
  error?: {
    type?: string;
    message?: string;
    code?: string | number;
  } | string;
}

interface LegacyTraceMetadataLike extends Record<string, unknown> {
  tool?: string;
  params?: Record<string, unknown>;
  context?: LegacyTraceContextLike;
  relatedFiles?: string[];
  additionalContext?: Record<string, unknown>;
  result?: LegacyTraceOutcomeLike;
  response?: LegacyTraceOutcomeLike;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toLegacyTraceMetadata(value: unknown): LegacyTraceMetadataLike | undefined {
  return isRecord(value) ? (value as LegacyTraceMetadataLike) : undefined;
}

function isTraceMetadata(value: unknown): value is TraceMetadata {
  return (
    isRecord(value) &&
    typeof value.schemaVersion === 'number' &&
    isRecord(value.tool) &&
    isRecord(value.context) &&
    isRecord(value.outcome)
  );
}

export interface LegacyTraceNormalizationInput {
  workspaceId: string;
  sessionId: string;
  traceType?: string;
  metadata?: unknown;
}

export function normalizeLegacyTraceMetadata(
  input: LegacyTraceNormalizationInput
): TraceMetadata | undefined {
  const rawMetadata = toLegacyTraceMetadata(input.metadata);
  if (!rawMetadata) {
    return undefined;
  }

  if (isTraceMetadata(rawMetadata)) {
    return rawMetadata;
  }

  const toolMetadata = buildToolMetadata(rawMetadata.tool || input.traceType || 'unknown');
  const context = buildContextMetadata(input.workspaceId, input.sessionId, rawMetadata);
  const inputFiles =
    Array.isArray(rawMetadata.relatedFiles) && rawMetadata.relatedFiles.length > 0
      ? rawMetadata.relatedFiles
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
  rawMetadata: LegacyTraceMetadataLike
): TraceContextMetadata {
  const legacyContext: LegacyTraceContextLike =
    toLegacyTraceMetadata(rawMetadata.params?.context) ??
    rawMetadata.context ??
    {};

  // Check if new format (memory/goal/constraints) is present
  const hasNewFormat =
    typeof legacyContext.memory === 'string' || typeof legacyContext.goal === 'string';

  if (hasNewFormat) {
    // Return new format (TraceContextMetadataV2)
    return {
      workspaceId,
      sessionId,
      memory: typeof legacyContext.memory === 'string' ? legacyContext.memory : '',
      goal: typeof legacyContext.goal === 'string' ? legacyContext.goal : '',
      constraints: legacyContext.constraints,
      tags: legacyContext.tags
    };
  }

  // Return legacy format (LegacyTraceContextMetadata) for backward compatibility
  const additionalContext = legacyContext.additionalContext || rawMetadata.additionalContext;
  return {
    workspaceId,
    sessionId,
    sessionDescription: legacyContext.sessionDescription,
    sessionMemory: legacyContext.sessionMemory,
    toolContext: legacyContext.toolContext,
    primaryGoal: legacyContext.primaryGoal,
    subgoal: legacyContext.subgoal,
    tags: legacyContext.tags,
    additionalContext
  };
}

function buildInputMetadata(
  rawMetadata: LegacyTraceMetadataLike,
  files?: string[]
): TraceInputMetadata | undefined {
  let normalizedArgs: unknown = rawMetadata.params;
  if (isRecord(normalizedArgs)) {
    const rest: Record<string, unknown> = { ...normalizedArgs };
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

function buildOutcome(rawMetadata: LegacyTraceMetadataLike): TraceOutcomeMetadata {
  const result = isRecord(rawMetadata.result) ? rawMetadata.result : undefined;
  const response = isRecord(rawMetadata.response) ? rawMetadata.response : undefined;

  const success =
    typeof result?.success === 'boolean'
      ? result.success
      : typeof response?.success === 'boolean'
        ? response.success
        : true;

  const errorSource = result?.error || response?.error;
  const errorRecord = isRecord(errorSource) ? errorSource : undefined;
  const errorMessage =
    typeof errorSource === 'string'
      ? errorSource
      : typeof errorRecord?.message === 'string'
        ? errorRecord.message
        : undefined;

  const error = errorSource
    ? {
        type: typeof errorRecord?.type === 'string' ? errorRecord.type : undefined,
        message: errorMessage || 'Unknown error',
        code:
          typeof errorRecord?.code === 'string' || typeof errorRecord?.code === 'number'
            ? errorRecord.code
            : undefined
      }
    : undefined;

  return {
    success,
    error
  };
}
