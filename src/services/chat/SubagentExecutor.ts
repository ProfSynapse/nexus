/**
 * SubagentExecutor - Core execution loop for autonomous subagents
 *
 * Responsibilities:
 * - Create and manage subagent branches
 * - Run autonomous execution loop (LLM → tools → repeat until done)
 * - Handle completion detection (no tool calls = done)
 * - Support cancellation via AbortController
 * - Queue results back to parent conversation
 * - Track agent status for UI display
 *
 * Follows Single Responsibility Principle - only handles subagent execution.
 */

import type { ChatMessage } from '../../types/chat/ChatTypes';
import type {
  SubagentParams,
  SubagentResult,
  SubagentExecutorEvents,
  AgentStatusItem,
  BranchState,
  QueuedMessage,
  SubagentToolCall,
  ToolSchemaInfo,
  ToolExecutionResult,
} from '../../types/branch/BranchTypes';
import type { BranchService } from './BranchService';
import type { MessageQueueService } from './MessageQueueService';
import type { DirectToolExecutor } from './DirectToolExecutor';

export interface SubagentExecutorDependencies {
  branchService: BranchService;
  messageQueueService: MessageQueueService;
  directToolExecutor: DirectToolExecutor;
  // Streaming generator for branch conversations
  streamingGenerator: (
    messages: ChatMessage[],
    options: {
      provider?: string;
      model?: string;
      systemPrompt?: string;
      abortSignal?: AbortSignal;
      workspaceId?: string;
      sessionId?: string;
    }
  ) => AsyncGenerator<{
    chunk: string;
    complete: boolean;
    toolCalls?: SubagentToolCall[];
    reasoning?: string;
  }, void, unknown>;
  // Tool list service for pre-fetching schemas
  getToolSchemas?: (agentName: string, toolSlugs: string[]) => Promise<ToolSchemaInfo[]>;
}

export class SubagentExecutor {
  private activeSubagents: Map<string, AbortController> = new Map();
  private agentStatus: Map<string, AgentStatusItem> = new Map();
  private subagentBranches: Map<string, string> = new Map(); // subagentId -> branchId
  private events: Partial<SubagentExecutorEvents> = {};

  constructor(private dependencies: SubagentExecutorDependencies) {
    console.log('[SubagentExecutor] Constructor called');
    console.log('[SubagentExecutor] Dependencies:', {
      hasBranchService: !!dependencies.branchService,
      hasMessageQueueService: !!dependencies.messageQueueService,
      hasDirectToolExecutor: !!dependencies.directToolExecutor,
      hasStreamingGenerator: !!dependencies.streamingGenerator,
      hasGetToolSchemas: !!dependencies.getToolSchemas,
    });
  }

  /**
   * Set event handlers
   */
  setEventHandlers(events: Partial<SubagentExecutorEvents>): void {
    this.events = events;
  }

  /**
   * Execute subagent - runs async, returns immediately with IDs
   * Result delivered via events + message queue
   */
  async executeSubagent(params: SubagentParams): Promise<{ subagentId: string; branchId: string }> {
    console.log('[SubagentExecutor] executeSubagent called with params:', {
      task: params.task,
      parentConversationId: params.parentConversationId,
      parentMessageId: params.parentMessageId,
      agent: params.agent,
      maxIterations: params.maxIterations,
      hasTools: params.tools ? Object.keys(params.tools).length : 0,
      contextFilesCount: params.contextFiles?.length || 0,
      continueBranchId: params.continueBranchId,
    });

    const subagentId = `subagent_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    console.log('[SubagentExecutor] Generated subagentId:', subagentId);

    const abortController = new AbortController();
    this.activeSubagents.set(subagentId, abortController);
    console.log('[SubagentExecutor] AbortController created, active subagents:', this.activeSubagents.size);

    // Create the branch first to get branchId
    console.log('[SubagentExecutor] Creating subagent branch...');
    let branchId: string;
    try {
      branchId = await this.dependencies.branchService.createSubagentBranch(
        params.parentConversationId,
        params.parentMessageId,
        params.task,
        subagentId,
        params.maxIterations ?? 10
      );
      console.log('[SubagentExecutor] ✓ Branch created:', branchId);
    } catch (error) {
      console.error('[SubagentExecutor] ✗ Failed to create branch:', error);
      throw error;
    }

    this.subagentBranches.set(subagentId, branchId);

    // Initialize status tracking
    const statusItem: AgentStatusItem = {
      subagentId,
      branchId,
      conversationId: params.parentConversationId,
      parentMessageId: params.parentMessageId,
      task: params.task,
      state: 'running',
      iterations: 0,
      maxIterations: params.maxIterations ?? 10,
      startedAt: Date.now(),
    };
    this.agentStatus.set(subagentId, statusItem);
    console.log('[SubagentExecutor] Status initialized:', statusItem);

    // Fire started event
    console.log('[SubagentExecutor] Firing onSubagentStarted event...');
    this.events.onSubagentStarted?.(subagentId, params.task, branchId);

    // Fire and forget - don't await
    console.log('[SubagentExecutor] Starting runSubagentLoop (fire-and-forget)...');
    this.runSubagentLoop(subagentId, branchId, params, abortController.signal)
      .then(result => {
        console.log('[SubagentExecutor] runSubagentLoop completed:', { subagentId, success: result.success, iterations: result.iterations });
        this.activeSubagents.delete(subagentId);
        this.updateStatus(subagentId, { state: result.success ? 'complete' : 'max_iterations' });
        this.events.onSubagentComplete?.(subagentId, result);
        this.queueResultToParent(params, result);
      })
      .catch(error => {
        console.error('[SubagentExecutor] runSubagentLoop failed:', { subagentId, error });
        this.activeSubagents.delete(subagentId);
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.updateStatus(subagentId, { state: 'cancelled' });
        this.events.onSubagentError?.(subagentId, errorMessage);
      });

    console.log('[SubagentExecutor] Returning immediately with IDs:', { subagentId, branchId });
    return { subagentId, branchId };
  }

  /**
   * Cancel a running subagent by ID
   */
  cancelSubagent(subagentId: string): boolean {
    const controller = this.activeSubagents.get(subagentId);
    if (controller) {
      controller.abort();
      this.activeSubagents.delete(subagentId);
      this.updateStatus(subagentId, { state: 'cancelled' });
      return true;
    }
    return false;
  }

  /**
   * Cancel a subagent by branch ID
   */
  cancelSubagentByBranch(branchId: string): boolean {
    for (const [subagentId, controller] of this.activeSubagents.entries()) {
      if (this.subagentBranches.get(subagentId) === branchId) {
        controller.abort();
        this.activeSubagents.delete(subagentId);
        this.updateStatus(subagentId, { state: 'cancelled' });
        return true;
      }
    }
    return false;
  }

  /**
   * Get all active subagent IDs
   */
  getActiveSubagents(): string[] {
    return Array.from(this.activeSubagents.keys());
  }

  /**
   * Check if a subagent is running
   */
  isSubagentRunning(subagentId: string): boolean {
    return this.activeSubagents.has(subagentId);
  }

  /**
   * Get agent status list for UI
   */
  getAgentStatusList(): AgentStatusItem[] {
    return Array.from(this.agentStatus.values()).sort((a, b) => {
      // Running first, then by start time
      if (a.state === 'running' && b.state !== 'running') return -1;
      if (b.state === 'running' && a.state !== 'running') return 1;
      return b.startedAt - a.startedAt;
    });
  }

  /**
   * Get subagent state (for already-finished subagents)
   */
  getSubagentState(subagentId: string): BranchState | null {
    const status = this.agentStatus.get(subagentId);
    return status?.state ?? null;
  }

  /**
   * Core execution loop
   */
  private async runSubagentLoop(
    subagentId: string,
    branchId: string,
    params: SubagentParams,
    abortSignal: AbortSignal
  ): Promise<SubagentResult> {
    const maxIterations = params.maxIterations ?? 10;
    let iterations = 0;
    let lastContent = '';

    // 1. Build system prompt
    const systemPrompt = await this.buildSystemPrompt(params);

    // 2. Read context files if provided
    let contextContent = params.context || '';
    if (params.contextFiles?.length) {
      const fileContents = await this.readContextFiles(params.contextFiles);
      contextContent += '\n\n' + fileContents;
    }

    // 3. Pre-fetch tool schemas if specified
    let toolSchemasText = '';
    if (params.tools && Object.keys(params.tools).length > 0 && this.dependencies.getToolSchemas) {
      const schemas = await this.prefetchToolSchemas(params.tools);
      if (schemas.length > 0) {
        toolSchemasText = this.formatToolSchemas(schemas);
      }
    }

    // 4. Build initial user message
    const initialMessage = this.buildInitialMessage(params.task, contextContent, toolSchemasText);

    // 5. Add initial messages to branch
    const systemMessage: ChatMessage = {
      id: `msg_${Date.now()}_system`,
      role: 'system',
      content: systemPrompt,
      timestamp: Date.now(),
      conversationId: params.parentConversationId,
      state: 'complete',
    };

    const userMessage: ChatMessage = {
      id: `msg_${Date.now()}_user`,
      role: 'user',
      content: initialMessage,
      timestamp: Date.now(),
      conversationId: params.parentConversationId,
      state: 'complete',
    };

    await this.dependencies.branchService.addMessageToBranch(
      params.parentConversationId,
      params.parentMessageId,
      branchId,
      systemMessage
    );

    await this.dependencies.branchService.addMessageToBranch(
      params.parentConversationId,
      params.parentMessageId,
      branchId,
      userMessage
    );

    // 6. Run conversation loop
    while (iterations < maxIterations) {
      // Check abort signal FIRST
      if (abortSignal.aborted) {
        await this.dependencies.branchService.updateBranchState(
          params.parentConversationId,
          branchId,
          'cancelled',
          iterations
        );
        return {
          success: false,
          content: lastContent,
          branchId,
          conversationId: params.parentConversationId,
          iterations,
          error: 'Cancelled by user',
        };
      }

      // Get branch messages for context
      const branchInfo = await this.dependencies.branchService.getBranch(
        params.parentConversationId,
        branchId
      );

      if (!branchInfo) {
        throw new Error('Branch not found');
      }

      // Generate response
      let responseContent = '';
      let toolCalls: SubagentToolCall[] | undefined;
      let reasoning = '';

      const streamMessages = branchInfo.branch.messages;

      for await (const chunk of this.dependencies.streamingGenerator(streamMessages, {
        abortSignal,
        workspaceId: params.workspaceId,
        sessionId: params.sessionId,
      })) {
        responseContent += chunk.chunk;
        if (chunk.toolCalls) {
          toolCalls = chunk.toolCalls;
        }
        if (chunk.reasoning) {
          reasoning += chunk.reasoning;
        }

        // Emit progress
        this.events.onSubagentProgress?.(subagentId, responseContent, iterations);
        this.events.onStreamingUpdate?.(branchId, responseContent, chunk.complete);
      }

      lastContent = responseContent;
      iterations++;

      // Update iteration count
      this.updateStatus(subagentId, { iterations });
      await this.dependencies.branchService.updateBranchState(
        params.parentConversationId,
        branchId,
        'running',
        iterations
      );

      // Add assistant message to branch
      const assistantMessage: ChatMessage = {
        id: `msg_${Date.now()}_assistant`,
        role: 'assistant',
        content: responseContent,
        timestamp: Date.now(),
        conversationId: params.parentConversationId,
        state: 'complete',
        toolCalls,
        reasoning: reasoning || undefined,
      };

      await this.dependencies.branchService.addMessageToBranch(
        params.parentConversationId,
        params.parentMessageId,
        branchId,
        assistantMessage
      );

      // 7. Check completion: no tool calls = done
      if (!toolCalls || toolCalls.length === 0) {
        await this.dependencies.branchService.updateBranchState(
          params.parentConversationId,
          branchId,
          'complete',
          iterations
        );
        return {
          success: true,
          content: responseContent,
          branchId,
          conversationId: params.parentConversationId,
          iterations,
        };
      }

      // 8. Execute tool calls
      for (const toolCall of toolCalls) {
        if (abortSignal.aborted) break;

        const toolResult = await this.executeToolCall(toolCall);

        // Add tool result message to branch
        const toolMessage: ChatMessage = {
          id: `msg_${Date.now()}_tool`,
          role: 'tool',
          content: JSON.stringify(toolResult.result ?? toolResult.error),
          timestamp: Date.now(),
          conversationId: params.parentConversationId,
          state: 'complete',
          metadata: {
            toolCallId: toolCall.id,
            toolName: toolCall.function?.name,
            success: toolResult.success,
          },
        };

        await this.dependencies.branchService.addMessageToBranch(
          params.parentConversationId,
          params.parentMessageId,
          branchId,
          toolMessage
        );
      }
    }

    // Max iterations reached
    await this.dependencies.branchService.updateBranchState(
      params.parentConversationId,
      branchId,
      'max_iterations',
      iterations
    );

    return {
      success: false,
      content: lastContent,
      branchId,
      conversationId: params.parentConversationId,
      iterations,
      error: 'Max iterations reached',
    };
  }

  /**
   * Build system prompt for subagent
   */
  private async buildSystemPrompt(params: SubagentParams): Promise<string> {
    let basePrompt = `You are an autonomous subagent working on a specific task.

Your task: ${params.task}

Instructions:
- Work independently to complete this task
- Use available tools as needed via tool calls
- You can use getTools to discover available tools
- When you have completed the task, respond with your findings WITHOUT calling any tools
- Be thorough but efficient
- Your final response (without tool calls) will be returned to the parent agent

`;

    // If custom agent specified, we could load its prompt here
    // For now, use base prompt
    if (params.agent) {
      basePrompt = `[Using agent persona: ${params.agent}]\n\n` + basePrompt;
    }

    return basePrompt;
  }

  /**
   * Build initial user message with task and context
   */
  private buildInitialMessage(task: string, context: string, toolSchemas: string): string {
    let message = task;

    if (context) {
      message += `\n\n## Context\n${context}`;
    }

    if (toolSchemas) {
      message += `\n\n## Pre-loaded Tool Schemas\n\nThese tools are available for immediate use:\n\n${toolSchemas}\n\nYou can also use getTools to discover additional tools if needed.`;
    }

    return message;
  }

  /**
   * Pre-fetch tool schemas based on params.tools
   */
  private async prefetchToolSchemas(tools: Record<string, string[]>): Promise<ToolSchemaInfo[]> {
    if (!this.dependencies.getToolSchemas) return [];

    const schemas: ToolSchemaInfo[] = [];

    for (const [agentName, toolSlugs] of Object.entries(tools)) {
      try {
        const agentSchemas = await this.dependencies.getToolSchemas(agentName, toolSlugs);
        schemas.push(...agentSchemas);
      } catch {
        // Tool not found - skip silently
      }
    }

    return schemas;
  }

  /**
   * Format tool schemas for inclusion in message
   */
  private formatToolSchemas(schemas: ToolSchemaInfo[]): string {
    return schemas
      .map(schema => {
        const name = schema.name || `${schema.agent}.${schema.slug}`;
        const desc = schema.description || '';
        const params = schema.parameters
          ? `\nParameters:\n\`\`\`json\n${JSON.stringify(schema.parameters, null, 2)}\n\`\`\``
          : '';
        return `### ${name}\n${desc}${params}`;
      })
      .join('\n\n');
  }

  /**
   * Read context files
   */
  private async readContextFiles(files: string[]): Promise<string> {
    const contents: string[] = [];

    for (const file of files) {
      try {
        const result = await this.dependencies.directToolExecutor.executeToolCall({
          id: `ctx_${Date.now()}`,
          function: {
            name: 'contentManager.readContent',
            arguments: JSON.stringify({ filePath: file }),
          },
        });

        if (result.success && result.result?.content) {
          contents.push(`--- ${file} ---\n${result.result.content}`);
        } else {
          contents.push(`--- ${file} --- (failed to read)`);
        }
      } catch {
        contents.push(`--- ${file} --- (error reading file)`);
      }
    }

    return contents.join('\n\n');
  }

  /**
   * Execute a single tool call
   */
  private async executeToolCall(toolCall: SubagentToolCall): Promise<ToolExecutionResult> {
    try {
      const result = await this.dependencies.directToolExecutor.executeToolCall({
        id: toolCall.id,
        function: toolCall.function,
      });
      return {
        success: result.success,
        result: result.result,
        error: result.error,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Queue result back to parent conversation
   */
  private queueResultToParent(params: SubagentParams, result: SubagentResult): void {
    const message: QueuedMessage = {
      id: `subagent_result_${Date.now()}`,
      type: 'subagent_result',
      content: JSON.stringify({
        success: result.success,
        task: params.task,
        status: result.success ? 'complete' : (result.error === 'Max iterations reached' ? 'max_iterations' : 'error'),
        iterations: result.iterations,
        result: result.content,
        error: result.error,
      }),
      metadata: {
        subagentId: result.branchId.replace('branch_subagent_', 'subagent_'),
        subagentTask: params.task,
        branchId: result.branchId,
        conversationId: result.conversationId,
        parentMessageId: params.parentMessageId,
      },
      queuedAt: Date.now(),
    };

    this.dependencies.messageQueueService.enqueue(message);
  }

  /**
   * Update agent status
   */
  private updateStatus(subagentId: string, updates: Partial<AgentStatusItem>): void {
    const status = this.agentStatus.get(subagentId);
    if (status) {
      Object.assign(status, updates);
      if (updates.state && updates.state !== 'running') {
        status.completedAt = Date.now();
      }
    }
  }
}
