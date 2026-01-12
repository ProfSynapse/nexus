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

export interface ToolCallCaptureData {
  toolName: string;
  params: any;
  response: any;
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
    params: any,
    response: any,
    success: boolean,
    executionTime: number
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
      const workspaceContext = this.sessionContextManager.getWorkspaceContext(sessionId);
      const workspaceId = workspaceContext?.workspaceId ||
                         params?.workspaceContext?.workspaceId ||
                         params?.context?.workspaceId ||
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
  private extractSessionId(params: any): string | null {
    // Try different locations where sessionId might be
    if (params?.sessionId) return params.sessionId;
    if (params?.context?.sessionId) return params.context.sessionId;
    if (params?.params?.sessionId) return params.params.sessionId;

    return null;
  }

  private buildCanonicalMetadata(options: {
    toolName: string;
    agent: string;
    mode: string;
    params: any;
    response: any;
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
    params: any
  ): TraceContextMetadata {
    const contextSource = params?.context || {};

    // Use new V2 format: memory, goal, constraints
    // These come from the ToolContext provided via getTools/useTool
    return {
      workspaceId,
      sessionId,
      memory: contextSource.memory || '',
      goal: contextSource.goal || '',
      constraints: contextSource.constraints
    };
  }

  private sanitizeParams(params: any): any {
    if (!params || typeof params !== 'object' || Array.isArray(params)) {
      return params;
    }

    const { context, workspaceContext, ...rest } = params;
    return Object.keys(rest).length > 0 ? rest : undefined;
  }

  private buildOutcomeMetadata(success: boolean, response: any): TraceOutcomeMetadata {
    if (success) {
      return { success: true };
    }

    const errorSource = response?.error || response?.result?.error;
    return {
      success: false,
      error: {
        type: errorSource?.type,
        message:
          errorSource?.message || (typeof errorSource === 'string' ? errorSource : 'Unknown error'),
        code: errorSource?.code
      }
    };
  }

  /**
   * Extract file paths from response and params
   * Looks in multiple locations to capture all affected files
   */
  private extractRelatedFiles(response: any, params: any): string[] {
    const files: string[] = [];

    // From params
    if (params?.filePath) files.push(params.filePath);
    if (params?.params?.filePath) files.push(params.params.filePath);
    if (params?.paths && Array.isArray(params.paths)) {
      files.push(...params.paths);
    }
    if (params?.params?.paths && Array.isArray(params.params.paths)) {
      files.push(...params.params.paths);
    }

    // From batch operations
    if (params?.operations && Array.isArray(params.operations)) {
      for (const op of params.operations) {
        if (op.params?.filePath) files.push(op.params.filePath);
        if (op.path) files.push(op.path);
      }
    }

    // From response
    if (response?.filePath) files.push(response.filePath);
    if (response?.files && Array.isArray(response.files)) {
      files.push(...response.files);
    }
    if (response?.affectedFiles && Array.isArray(response.affectedFiles)) {
      files.push(...response.affectedFiles);
    }
    if (response?.createdFiles && Array.isArray(response.createdFiles)) {
      files.push(...response.createdFiles);
    }
    if (response?.modifiedFiles && Array.isArray(response.modifiedFiles)) {
      files.push(...response.modifiedFiles);
    }

    // Deduplicate and filter empty strings (ensure strings only)
    return [...new Set(files.filter(f => typeof f === 'string' && f.trim()))];
  }

}
