// Location: src/services/trace/ToolCallTraceService.ts
// Captures tool call executions and saves them as memory traces
// Used by: MCPConnectionManager via onToolResponse callback
// Dependencies: MemoryService, SessionContextManager, WorkspaceService

import { Plugin } from 'obsidian';
import { MemoryService } from '../../agents/memoryManager/services/MemoryService';
import { SessionContextManager, type WorkspaceContext } from '../SessionContextManager';
import { WorkspaceService } from '../WorkspaceService';
import { TraceMetadataBuilder } from '../memory/TraceMetadataBuilder';
import { TraceContextMetadata, TraceOutcomeMetadata } from '../../database/workspace-types';
import { formatTraceContent } from './TraceContentFormatter';

type TraceRecord = Record<string, unknown>;

interface ToolCallContextPayload extends TraceRecord {
  workspaceId?: unknown;
  sessionId?: unknown;
  memory?: unknown;
  goal?: unknown;
  constraints?: unknown;
}

interface ToolCallParamsPayload extends TraceRecord {
  sessionId?: unknown;
  context?: ToolCallContextPayload;
  workspaceContext?: ToolCallContextPayload;
  params?: TraceRecord;
  filePath?: unknown;
  path?: unknown;
  paths?: unknown;
  operations?: unknown;
  query?: unknown;
  id?: unknown;
  name?: unknown;
}

interface ToolCallResponsePayload extends TraceRecord {
  error?: unknown;
  result?: TraceRecord;
  filePath?: unknown;
  files?: unknown;
  affectedFiles?: unknown;
  createdFiles?: unknown;
  modifiedFiles?: unknown;
}

function isTraceRecord(value: unknown): value is TraceRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getStringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function getStringArray(values: unknown): string[] {
  if (!Array.isArray(values)) {
    return [];
  }

  return values.filter((value): value is string => getStringValue(value) !== undefined);
}

/**
 * ToolCallTraceService
 *
 * Captures tool call executions and persists them as memory traces within
 * the appropriate workspace/session context. Provides searchable history
 * of all tool interactions.
 *
 * Features:
 * - Extracts agent/mode from tool names
 * - Retrieves workspace/session context automatically
 * - Transforms tool call data into WorkspaceMemoryTrace format
 * - Extracts affected files from responses
 * - Non-blocking error handling (traces are nice-to-have)
 */
export class ToolCallTraceService {
  constructor(
    private memoryService: MemoryService,
    private sessionContextManager: SessionContextManager,
    private workspaceService: WorkspaceService,
    private plugin: Plugin
  ) {}

  /**
   * Capture a tool call execution and save as memory trace
   * This is the main entry point called by MCPConnectionManager
   */
  async captureToolCall(
    toolName: string,
    params: ToolCallParamsPayload,
    response: ToolCallResponsePayload,
    success: boolean,
    _executionTime: number
  ): Promise<void> {
    try {
      // 1. Extract agent and mode from tool name
      const { agent, mode } = this.parseToolName(toolName);

      // 2. Get session ID from params
      const sessionId = this.extractSessionId(params);
      if (!sessionId) {
        return;
      }

      // 3. Get workspace context from SessionContextManager
      const workspaceContext: WorkspaceContext | null = this.sessionContextManager.getWorkspaceContext(sessionId);
      const workspaceId =
        getStringValue(workspaceContext?.workspaceId) ||
        getStringValue(params.workspaceContext?.workspaceId) ||
        getStringValue(params.context?.workspaceId) ||
        'default';

      if (!workspaceId) {
        return;
      }

      // 4. Build trace content (human-readable description)
      const traceContent = formatTraceContent({ agent, mode, params, success });

      // 5. Build trace metadata (structured data)
      const relatedFiles = this.extractRelatedFiles(response, params);
      const traceMetadata = this.buildCanonicalMetadata({
        toolName,
        agent,
        mode,
        params,
        response,
        success,
        sessionId,
        workspaceId,
        relatedFiles
      });

      // 6. Record the trace via MemoryService
      await this.memoryService.recordActivityTrace({
        workspaceId: workspaceId,
        sessionId: sessionId,
        type: 'tool_call',
        content: traceContent,
        timestamp: Date.now(),
        metadata: traceMetadata
      });

    } catch (error) {
      // Don't throw - tracing is a secondary operation that shouldn't break the main flow
      console.error('[ToolCallTraceService] Failed to capture tool call:', error);
    }
  }

  /**
   * Parse tool name into agent and mode components
   * Format: "agentName_modeName" or "agentName.modeName" -> { agent: "agentName", mode: "modeName" }
   */
  private parseToolName(toolName: string): { agent: string; mode: string } {
    // Try dot separator first (e.g., "contentManager.createContent")
    const dotIndex = toolName.indexOf('.');
    if (dotIndex !== -1) {
      return {
        agent: toolName.substring(0, dotIndex),
        mode: toolName.substring(dotIndex + 1)
      };
    }

    // Fall back to underscore separator (e.g., "contentManager_createContent")
    const lastUnderscore = toolName.lastIndexOf('_');
    if (lastUnderscore === -1) {
      return { agent: toolName, mode: 'unknown' };
    }

    return {
      agent: toolName.substring(0, lastUnderscore),
      mode: toolName.substring(lastUnderscore + 1)
    };
  }

  /**
   * Extract session ID from various possible locations in params
   */
  private extractSessionId(params: unknown): string | null {
    if (!isTraceRecord(params)) {
      return null;
    }

    // Try different locations where sessionId might be
    const sessionId = getStringValue(params.sessionId);
    if (sessionId) return sessionId;

    const context = isTraceRecord(params.context) ? params.context : undefined;
    const contextSessionId = getStringValue(context?.sessionId);
    if (contextSessionId) return contextSessionId;

    const nestedParams = isTraceRecord(params.params) ? params.params : undefined;
    const nestedSessionId = getStringValue(nestedParams?.sessionId);
    if (nestedSessionId) return nestedSessionId;

    return null;
  }

  private buildCanonicalMetadata(options: {
    toolName: string;
    agent: string;
    mode: string;
    params: ToolCallParamsPayload;
    response: ToolCallResponsePayload;
    success: boolean;
    sessionId: string;
    workspaceId: string;
    relatedFiles: string[];
  }) {
    const context = this.buildContextMetadata(options.workspaceId, options.sessionId, options.params);
    const sanitizedParams = this.sanitizeParams(options.params);
    const input =
      sanitizedParams || options.relatedFiles.length > 0
        ? {
            arguments: sanitizedParams,
            files: options.relatedFiles.length > 0 ? options.relatedFiles : undefined
          }
        : undefined;

    const outcome = this.buildOutcomeMetadata(options.success, options.response);

    return TraceMetadataBuilder.create({
      tool: {
        id: `${options.agent}_${options.mode}`,
        agent: options.agent,
        mode: options.mode
      },
      context,
      input,
      outcome,
      legacy: {
        params: options.params,
        result: options.response,
        relatedFiles: options.relatedFiles
      }
    });
  }

  private buildContextMetadata(
    workspaceId: string,
    sessionId: string,
    params: ToolCallParamsPayload
  ): TraceContextMetadata {
    const contextSource = params.context;

    // Use new V2 format: memory, goal, constraints
    // These come from the ToolContext provided via getTools/useTool
    return {
      workspaceId,
      sessionId,
      memory: getStringValue(contextSource?.memory) ?? '',
      goal: getStringValue(contextSource?.goal) ?? '',
      constraints: getStringValue(contextSource?.constraints)
    };
  }

  private sanitizeParams(params: ToolCallParamsPayload): unknown {
    const sanitized: TraceRecord = {};
    for (const [key, value] of Object.entries(params)) {
      if (key === 'context' || key === 'workspaceContext') {
        continue;
      }

      sanitized[key] = value;
    }

    return Object.keys(sanitized).length > 0 ? sanitized : undefined;
  }

  private buildOutcomeMetadata(success: boolean, response: ToolCallResponsePayload): TraceOutcomeMetadata {
    if (success) {
      return { success: true };
    }

    const errorSource = isTraceRecord(response.error)
      ? response.error
      : isTraceRecord(response.result)
        ? response.result.error
        : response.error;

    return {
      success: false,
      error: {
        type: isTraceRecord(errorSource) ? getStringValue(errorSource.type) : undefined,
        message:
          (isTraceRecord(errorSource) ? getStringValue(errorSource.message) : undefined) ||
          (typeof errorSource === 'string' ? errorSource : 'Unknown error'),
        code: isTraceRecord(errorSource) ? errorSource.code : undefined
      }
    };
  }

  /**
   * Extract file paths from response and params
   * Looks in multiple locations to capture all affected files
   */
  private extractRelatedFiles(response: ToolCallResponsePayload, params: ToolCallParamsPayload): string[] {
    const files: string[] = [];
    const appendString = (value: unknown) => {
      const stringValue = getStringValue(value);
      if (stringValue) {
        files.push(stringValue);
      }
    };

    const appendStringValues = (values: unknown) => {
      files.push(...getStringArray(values));
    };

    // From params
    appendString(params.filePath);
    appendString(isTraceRecord(params.params) ? params.params.filePath : undefined);
    appendStringValues(params.paths);
    appendStringValues(isTraceRecord(params.params) ? params.params.paths : undefined);

    // From batch operations
    if (Array.isArray(params.operations)) {
      for (const operation of params.operations) {
        if (!isTraceRecord(operation)) {
          continue;
        }

        const operationParams = isTraceRecord(operation.params) ? operation.params : undefined;
        appendString(operationParams?.filePath);
        appendString(operation.path);
      }
    }

    // From response
    appendString(response.filePath);
    appendStringValues(response.files);
    appendStringValues(response.affectedFiles);
    appendStringValues(response.createdFiles);
    appendStringValues(response.modifiedFiles);

    // Deduplicate and filter empty strings (ensure strings only)
    return [...new Set(files)];
  }

}
