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
  metadata?: any;
}

export function normalizeLegacyTraceMetadata(
  input: LegacyTraceNormalizationInput
): TraceMetadata | undefined {
  const rawMetadata = input.metadata;
  if (!rawMetadata) {
    return undefined;
  }

  if ((rawMetadata as TraceMetadata).schemaVersion) {
    return rawMetadata as TraceMetadata;
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
  rawMetadata: any
): TraceContextMetadata {
  const legacyContext = rawMetadata?.params?.context || rawMetadata?.context || {};

  // Check if new format (memory/goal/constraints) is present
  const hasNewFormat = legacyContext.memory || legacyContext.goal;

  if (hasNewFormat) {
    // Return new format (TraceContextMetadataV2)
    return {
      workspaceId,
      sessionId,
      memory: legacyContext.memory || '',
      goal: legacyContext.goal || '',
      constraints: legacyContext.constraints,
      tags: legacyContext.tags
    };
  }

  // Return legacy format (LegacyTraceContextMetadata) for backward compatibility
  const additionalContext = legacyContext.additionalContext || rawMetadata?.additionalContext;
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

function buildInputMetadata(rawMetadata: any, files?: string[]): TraceInputMetadata | undefined {
  let normalizedArgs = rawMetadata?.params;
  if (
    normalizedArgs &&
    typeof normalizedArgs === 'object' &&
    !Array.isArray(normalizedArgs)
  ) {
    const { context, ...rest } = normalizedArgs;
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

function buildOutcome(rawMetadata: any): TraceOutcomeMetadata {
  const success =
    typeof rawMetadata?.result?.success === 'boolean'
      ? rawMetadata.result.success
      : typeof rawMetadata?.response?.success === 'boolean'
        ? rawMetadata.response.success
        : true;

  const errorSource = rawMetadata?.result?.error || rawMetadata?.response?.error;

  const error =
    errorSource && (errorSource.message || typeof errorSource === 'string')
      ? {
          type: errorSource.type,
          message:
            errorSource.message || (typeof errorSource === 'string' ? errorSource : 'Unknown error'),
          code: errorSource.code
        }
      : undefined;

  return {
    success,
    error
  };
}
