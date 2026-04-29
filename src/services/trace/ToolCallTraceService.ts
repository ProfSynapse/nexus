// Location: src/services/trace/ToolCallTraceService.ts
// Captures tool call executions and saves them as memory traces
// Used by: MCPConnectionManager via onToolResponse callback
// Dependencies: MemoryService, SessionContextManager, WorkspaceService

import { Plugin } from 'obsidian';
import { MemoryService } from '../../agents/memoryManager/services/MemoryService';
import { SessionContextManager } from '../SessionContextManager';
import { WorkspaceService } from '../WorkspaceService';
import { TraceMetadataBuilder } from '../memory/TraceMetadataBuilder';
import { TraceContextMetadata, TraceOutcomeMetadata } from '../../database/workspace-types';
import { formatTraceContent } from './TraceContentFormatter';
import { splitTopLevelSegments, tokenizeWithMeta } from '../../agents/toolManager/services/ToolCliNormalizer';

type ToolCallParams = unknown;
type ToolCallResponse = unknown;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

export interface ToolCallCaptureData {
  toolName: string;
  params: ToolCallParams;
  response: ToolCallResponse;
  success: boolean;
  executionTime: number;
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
    params: ToolCallParams,
    response: ToolCallResponse,
    success: boolean,
    _executionTime: number
  ): Promise<void> {
    try {
      // 1. Extract agent and mode from tool name
      const { agent, mode } = this.parseToolName(toolName);
      const paramsRecord = asRecord(params);
      const responseRecord = asRecord(response);

      // 2. Get session ID from params
      const sessionId = this.extractSessionId(paramsRecord);
      if (!sessionId) {
        return;
      }

      // 3. Resolve workspace context from the session or explicit tool envelope
      const workspaceId = await this.resolveWorkspaceId(paramsRecord, sessionId);
      if (!workspaceId) {
        return;
      }
      this.sessionContextManager.setWorkspaceContext(sessionId, { workspaceId });

      // 4. Build trace content (human-readable description)
      const traceContent = formatTraceContent({ agent, mode, params: paramsRecord, success });

      // 5. Build trace metadata (structured data)
      const relatedFiles = this.extractRelatedFiles(responseRecord, paramsRecord);
      const traceMetadata = this.buildCanonicalMetadata({
        toolName,
        agent,
        mode,
        params: paramsRecord,
        response: responseRecord,
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
  private extractSessionId(params: ToolCallParams): string | null {
    const paramsRecord = asRecord(params);
    // Try different locations where sessionId might be
    if (typeof paramsRecord.sessionId === 'string') return paramsRecord.sessionId;
    if (isRecord(paramsRecord.context) && typeof paramsRecord.context.sessionId === 'string') return paramsRecord.context.sessionId;
    if (isRecord(paramsRecord.params) && typeof paramsRecord.params.sessionId === 'string') return paramsRecord.params.sessionId;

    return null;
  }

  private async resolveWorkspaceId(params: ToolCallParams, sessionId: string): Promise<string | null> {
    const paramsRecord = asRecord(params);
    const workspaceContext = this.sessionContextManager.getWorkspaceContext(sessionId);
    const explicitCandidate =
      getString(paramsRecord.workspaceId) ||
      getString(isRecord(paramsRecord.workspaceContext) ? paramsRecord.workspaceContext.workspaceId : undefined) ||
      getString(isRecord(paramsRecord.context) ? paramsRecord.context.workspaceId : undefined);
    const commandWorkspaceCandidate = this.extractWorkspaceHandleFromUseTools(paramsRecord);
    const candidate =
      (explicitCandidate && explicitCandidate !== 'default' ? explicitCandidate : undefined) ||
      commandWorkspaceCandidate ||
      explicitCandidate ||
      workspaceContext?.workspaceId ||
      'default';

    if (!candidate) {
      return null;
    }

    try {
      const workspace = await this.workspaceService.getWorkspaceByNameOrId(candidate);
      return workspace?.id || candidate;
    } catch {
      return candidate;
    }
  }

  private extractWorkspaceHandleFromUseTools(params: Record<string, unknown>): string | undefined {
    const toolString = getString(params.tool);
    if (!toolString) {
      return undefined;
    }

    for (const segment of splitTopLevelSegments(toolString)) {
      const tokens = tokenizeWithMeta(segment);
      if (tokens.length < 3) {
        continue;
      }

      const agent = tokens[0].value.replace(/[-_\s]/g, '').toLowerCase();
      const tool = tokens[1].value.replace(/[-_\s]/g, '').toLowerCase();
      if ((agent === 'memory' || agent === 'memorymanager') &&
          (tool === 'loadworkspace' || tool === 'createworkspace')) {
        return tokens[2].value;
      }
    }

    return undefined;
  }

  private buildCanonicalMetadata(options: {
    toolName: string;
    agent: string;
    mode: string;
    params: ToolCallParams;
    response: ToolCallResponse;
    success: boolean;
    sessionId: string;
    workspaceId: string;
    relatedFiles: string[];
  }): ReturnType<typeof TraceMetadataBuilder.create> {
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
    params: ToolCallParams
  ): TraceContextMetadata {
    const paramsRecord = asRecord(params);
    const contextSource = isRecord(paramsRecord.context) ? paramsRecord.context : {};

    // Use new V2 format: memory, goal, constraints
    // These come from the ToolContext provided via getTools/useTool
    return {
      workspaceId,
      sessionId,
      memory: getString(contextSource.memory) || getString(paramsRecord.memory) || '',
      goal: getString(contextSource.goal) || getString(paramsRecord.goal) || '',
      sessionName:
        getString(contextSource.sessionName) ||
        getString(contextSource.displaySessionId) ||
        getString(paramsRecord.sessionName) ||
        getString(paramsRecord._displaySessionId),
      constraints: getString(contextSource.constraints) || getString(paramsRecord.constraints)
    };
  }

  private sanitizeParams(params: ToolCallParams): unknown {
    if (!isRecord(params)) {
      return params;
    }

    const sanitized = { ...params };
    delete sanitized.context;
    delete sanitized.workspaceContext;
    delete sanitized._displaySessionId;
    return Object.keys(sanitized).length > 0 ? sanitized : undefined;
  }

  private buildOutcomeMetadata(success: boolean, response: ToolCallResponse): TraceOutcomeMetadata {
    if (success) {
      return { success: true };
    }

    const responseRecord = asRecord(response);
    const errorSource = responseRecord.error || (isRecord(responseRecord.result) ? responseRecord.result.error : undefined);
    const errorRecord = isRecord(errorSource) ? errorSource : undefined;
    return {
      success: false,
      error: {
        type: getString(errorRecord?.type),
        message:
          getString(errorRecord?.message) || (typeof errorSource === 'string' ? errorSource : 'Unknown error'),
        code:
          typeof errorRecord?.code === 'string' || typeof errorRecord?.code === 'number'
            ? errorRecord.code
            : undefined
      }
    };
  }

  /**
   * Extract file paths from response and params
   * Looks in multiple locations to capture all affected files
   */
  private extractRelatedFiles(response: ToolCallResponse, params: ToolCallParams): string[] {
    const responseRecord = asRecord(response);
    const paramsRecord = asRecord(params);
    const files: string[] = [];

    // From params
    if (typeof paramsRecord.filePath === 'string') files.push(paramsRecord.filePath);
    if (isRecord(paramsRecord.params) && typeof paramsRecord.params.filePath === 'string') files.push(paramsRecord.params.filePath);
    if (Array.isArray(paramsRecord.paths)) {
      files.push(...paramsRecord.paths.filter((path): path is string => typeof path === 'string'));
    }
    if (isRecord(paramsRecord.params) && Array.isArray(paramsRecord.params.paths)) {
      files.push(...paramsRecord.params.paths.filter((path): path is string => typeof path === 'string'));
    }

    // From batch operations
    if (Array.isArray(paramsRecord.operations)) {
      for (const op of paramsRecord.operations) {
        if (!isRecord(op)) {
          continue;
        }

        if (isRecord(op.params) && typeof op.params.filePath === 'string') files.push(op.params.filePath);
        if (typeof op.path === 'string') files.push(op.path);
      }
    }

    // From response
    if (typeof responseRecord.filePath === 'string') files.push(responseRecord.filePath);
    if (Array.isArray(responseRecord.files)) {
      files.push(...responseRecord.files.filter((file): file is string => typeof file === 'string'));
    }
    if (Array.isArray(responseRecord.affectedFiles)) {
      files.push(...responseRecord.affectedFiles.filter((file): file is string => typeof file === 'string'));
    }
    if (Array.isArray(responseRecord.createdFiles)) {
      files.push(...responseRecord.createdFiles.filter((file): file is string => typeof file === 'string'));
    }
    if (Array.isArray(responseRecord.modifiedFiles)) {
      files.push(...responseRecord.modifiedFiles.filter((file): file is string => typeof file === 'string'));
    }

    // Deduplicate and filter empty strings (ensure strings only)
    return [...new Set(files.filter(f => typeof f === 'string' && f.trim()))];
  }

}
