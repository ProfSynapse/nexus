import {
  TraceMetadata,
  TraceContextMetadata,
  TraceInputMetadata,
  TraceLegacyMetadata,
  TraceOutcomeMetadata,
  TraceToolMetadata,
  isLegacyTraceContextFormat
} from '../../database/types/memory/MemoryTypes';

export interface TraceMetadataBuilderOptions {
  tool: TraceToolMetadata;
  context: TraceContextMetadata;
  input?: TraceInputMetadata;
  outcome: TraceOutcomeMetadata;
  legacy?: TraceLegacyMetadata;
}

/**
 * Helper responsible for producing canonical metadata objects for memory traces.
 * Centralizing this logic keeps all writers aligned and makes future schema
 * evolution straightforward.
 */
export class TraceMetadataBuilder {
  public static readonly CURRENT_SCHEMA_VERSION = 1;

  private static isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  static create(options: TraceMetadataBuilderOptions): TraceMetadata {
    const context = TraceMetadataBuilder.ensureContext(options.context);

    return {
      schemaVersion: TraceMetadataBuilder.CURRENT_SCHEMA_VERSION,
      tool: { ...options.tool },
      context,
      input: TraceMetadataBuilder.normalizeInput(options.input),
      outcome: { ...options.outcome },
      legacy: TraceMetadataBuilder.normalizeLegacy(options.legacy)
    };
  }

  /**
   * Extracts legacy params/result blobs from existing metadata structures so
   * we can persist them under metadata.legacy for backward compatibility.
   */
  static extractLegacyFromMetadata(rawMetadata: unknown): TraceLegacyMetadata | undefined {
    if (!TraceMetadataBuilder.isRecord(rawMetadata)) {
      return undefined;
    }

    const legacy: TraceLegacyMetadata = {};

    if (rawMetadata.params !== undefined) {
      legacy.params = rawMetadata.params;
    }

    if (rawMetadata.result !== undefined) {
      legacy.result = rawMetadata.result;
    } else {
      const response = rawMetadata.response;
      if (TraceMetadataBuilder.isRecord(response) && response.result !== undefined) {
        legacy.result = response.result;
      }
    }

    if (Array.isArray(rawMetadata.relatedFiles) && rawMetadata.relatedFiles.length > 0) {
      legacy.relatedFiles = rawMetadata.relatedFiles.filter(
        (file): file is string => typeof file === 'string'
      );
    }

    return TraceMetadataBuilder.normalizeLegacy(legacy);
  }

  private static ensureContext(context: TraceContextMetadata): TraceContextMetadata {
    if (!context.workspaceId) {
      throw new Error('[TraceMetadataBuilder] workspaceId is required in context');
    }

    if (!context.sessionId) {
      throw new Error('[TraceMetadataBuilder] sessionId is required in context');
    }

    // Handle both legacy and V2 context formats
    if (isLegacyTraceContextFormat(context)) {
      return {
        ...context,
        additionalContext: context.additionalContext ? { ...context.additionalContext } : undefined
      };
    }

    // V2 format - just copy as-is (no additionalContext field)
    return { ...context };
  }

  private static normalizeInput(input?: TraceInputMetadata): TraceInputMetadata | undefined {
    if (!input) {
      return undefined;
    }

    const hasArguments = input.arguments !== undefined;
    const hasFiles = Array.isArray(input.files) && input.files.length > 0;
    const hasNotes = Boolean(input.notes);

    if (!hasArguments && !hasFiles && !hasNotes) {
      return undefined;
    }

    return {
      arguments: input.arguments,
      files: hasFiles ? [...input.files] : undefined,
      notes: input.notes
    };
  }

  private static normalizeLegacy(legacy?: TraceLegacyMetadata): TraceLegacyMetadata | undefined {
    if (!legacy) {
      return undefined;
    }

    const hasParams = legacy.params !== undefined;
    const hasResult = legacy.result !== undefined;
    const hasFiles = Array.isArray(legacy.relatedFiles) && legacy.relatedFiles.length > 0;

    if (!hasParams && !hasResult && !hasFiles) {
      return undefined;
    }

    return {
      params: legacy.params,
      result: legacy.result,
      relatedFiles: hasFiles ? [...legacy.relatedFiles] : undefined
    };
  }
}

export const buildTraceMetadata = TraceMetadataBuilder.create.bind(TraceMetadataBuilder);
