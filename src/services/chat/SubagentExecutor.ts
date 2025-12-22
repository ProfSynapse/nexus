/**
 * SubagentExecutor - Orchestrates autonomous subagent execution
 *
 * Uses SAME infrastructure as main chat:
 * - LLMService.generateResponseStream handles tool pingpong internally
 * - ToolContinuationService executes tools automatically during streaming
 * - SubagentExecutor just provides initial context and saves final result
 *
 * Responsibilities:
 * - Create subagent branches with initial context (system prompt + task)
 * - Stream response using existing LLM infrastructure
 * - Save final assistant message to branch
 * - Support cancellation via AbortController
 * - Queue results back to parent conversation
 * - Track agent status for UI display
 *
 * Follows Single Responsibility Principle - orchestration only, no tool execution.
 */

import type { ChatMessage, ToolCall } from '../../types/chat/ChatTypes';
import type {
  SubagentParams,
  SubagentResult,
  SubagentExecutorEvents,
  AgentStatusItem,
  BranchState,
  QueuedMessage,
  SubagentToolCall,
  ToolSchemaInfo,
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

  // In-memory streaming state for active branches
  // This allows UI to render directly from memory without storage
  private streamingBranchMessages: Map<string, ChatMessage[]> = new Map(); // branchId -> messages

  constructor(private dependencies: SubagentExecutorDependencies) {
    // Validate critical dependencies
    if (!dependencies.branchService) {
      console.error('[SubagentExecutor] Missing branchService dependency');
    }
    if (!dependencies.streamingGenerator) {
      console.error('[SubagentExecutor] Missing streamingGenerator dependency');
    }
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
    const subagentId = `subagent_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;

    const abortController = new AbortController();
    this.activeSubagents.set(subagentId, abortController);

    // Create the branch
    let branchId: string;
    try {
      branchId = await this.dependencies.branchService.createSubagentBranch(
        params.parentConversationId,
        params.parentMessageId,
        params.task,
        subagentId,
        params.maxIterations ?? 10
      );
    } catch (error) {
      console.error('[Subagent] Failed to create branch:', error);
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

    // Fire started event
    this.events.onSubagentStarted?.(subagentId, params.task, branchId);

    // Fire and forget - don't await
    this.runSubagentLoop(subagentId, branchId, params, abortController.signal)
      .then(result => {
        this.activeSubagents.delete(subagentId);
        this.updateStatus(subagentId, { state: result.success ? 'complete' : 'max_iterations' });
        this.events.onSubagentComplete?.(subagentId, result);
        this.queueResultToParent(params, result);
      })
      .catch(error => {
        this.activeSubagents.delete(subagentId);
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.updateStatus(subagentId, { state: 'cancelled' });
        this.events.onSubagentError?.(subagentId, errorMessage);
      });

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
   * Clear agent status list (call when switching conversations)
   * Also triggers a status change event for UI updates
   */
  clearAgentStatus(): void {
    this.agentStatus.clear();
    this.subagentBranches.clear();
    this.streamingBranchMessages.clear();
  }

  /**
   * Get in-memory messages for a streaming branch
   * Returns null if branch is not actively streaming
   * UI can use this to render directly from memory without storage read
   */
  getStreamingBranchMessages(branchId: string): ChatMessage[] | null {
    return this.streamingBranchMessages.get(branchId) || null;
  }

  /**
   * Check if a branch is actively streaming
   */
  isBranchStreaming(branchId: string): boolean {
    return this.streamingBranchMessages.has(branchId);
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
    // 1. Pre-fetch tool schemas FIRST (if parent specified tools to hand off)
    let toolSchemasText = '';
    if (params.tools && Object.keys(params.tools).length > 0 && this.dependencies.getToolSchemas) {
      const schemas = await this.prefetchToolSchemas(params.tools);
      if (schemas.length > 0) {
        toolSchemasText = this.formatToolSchemas(schemas);
      }
    }

    // 2. Read context files if provided (inherited from parent + tool params)
    // These go into the SYSTEM PROMPT so the subagent has full context
    let contextFilesContent = '';
    if (params.contextFiles?.length) {
      contextFilesContent = await this.readContextFiles(params.contextFiles);
    }

    // 3. Build system prompt WITH tool schemas + context files included
    const systemPrompt = await this.buildSystemPrompt(params, toolSchemasText, contextFilesContent);

    // 4. Build initial user message (just task + any additional context string)
    const initialMessage = this.buildInitialMessage(params.task, params.context || '');

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

    await this.dependencies.branchService.addMessageToBranch(branchId, systemMessage);
    await this.dependencies.branchService.addMessageToBranch(branchId, userMessage);

    // 6. Stream response - LLMService handles ALL tool pingpong internally
    // The streaming generator (via LLMService → StreamingOrchestrator → ToolContinuationService)
    // already executes all tool calls and continues until the LLM responds with no more tool calls.
    // We just need to collect the response and save it.

    // Check abort signal FIRST
    if (abortSignal.aborted) {
      await this.dependencies.branchService.updateBranchState(branchId, 'cancelled', 0);
      // Clear from in-memory map if cancelled before streaming started
      this.streamingBranchMessages.delete(branchId);
      return {
        success: false,
        content: '',
        branchId,
        conversationId: params.parentConversationId,
        iterations: 0,
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

    // Generate response - streaming handles tool pingpong automatically
    let responseContent = '';
    let toolCalls: SubagentToolCall[] | undefined;
    let reasoning = '';
    let toolIterations = 0;
    let lastToolUsed: string | undefined;

    const streamMessages = branchInfo.branch.messages;

    // Create streaming placeholder assistant message
    const assistantMessageId = `msg_${Date.now()}_assistant`;
    const streamingAssistantMessage: ChatMessage = {
      id: assistantMessageId,
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      conversationId: params.parentConversationId,
      state: 'streaming',
    };

    // ADD the assistant message to branch storage (like parent chat does)
    // This allows updateMessageInBranch to work later
    await this.dependencies.branchService.addMessageToBranch(branchId, streamingAssistantMessage);

    // Build in-memory messages array (system + user from storage, plus streaming assistant)
    const inMemoryMessages: ChatMessage[] = [
      ...streamMessages,
      streamingAssistantMessage,
    ];

    // Store in map so UI can access when navigating to this branch
    this.streamingBranchMessages.set(branchId, inMemoryMessages);

    for await (const chunk of this.dependencies.streamingGenerator(streamMessages, {
      abortSignal,
      workspaceId: params.workspaceId,
      sessionId: params.sessionId,
      provider: params.provider,
      model: params.model,
    })) {
      // Check abort during streaming
      if (abortSignal.aborted) {
        await this.dependencies.branchService.updateBranchState(branchId, 'cancelled', toolIterations);
        // Clear from in-memory map on cancellation
        this.streamingBranchMessages.delete(branchId);
        return {
          success: false,
          content: responseContent,
          branchId,
          conversationId: params.parentConversationId,
          iterations: toolIterations,
          error: 'Cancelled by user',
        };
      }

      responseContent += chunk.chunk;
      if (chunk.toolCalls) {
        // These are ALREADY-EXECUTED tool calls (with results)
        // They accumulate across all pingpong iterations
        toolCalls = chunk.toolCalls;
        toolIterations = chunk.toolCalls.length; // Approximate iteration count

        // Track the last tool used for UI display
        const latestTool = chunk.toolCalls[chunk.toolCalls.length - 1];
        if (latestTool?.function?.name) {
          lastToolUsed = latestTool.function.name;
          this.updateStatus(subagentId, { iterations: toolIterations, lastToolUsed });
        }
      }
      if (chunk.reasoning) {
        reasoning += chunk.reasoning;
      }

      // Update IN-MEMORY message (like parent chat does) - NO storage writes during streaming
      const convertedToolCalls: ToolCall[] | undefined = toolCalls?.map(tc => ({
        ...tc,
        type: tc.type || 'function',
      }));
      streamingAssistantMessage.content = responseContent;
      streamingAssistantMessage.toolCalls = convertedToolCalls;
      streamingAssistantMessage.reasoning = reasoning || undefined;

      // Emit tool calls event - SAME as parent chat does
      // This allows ToolEventCoordinator to dynamically create/update tool bubbles
      if (convertedToolCalls && convertedToolCalls.length > 0) {
        this.events.onToolCallsDetected?.(branchId, assistantMessageId, convertedToolCalls);
      }

      // Emit progress
      this.events.onSubagentProgress?.(subagentId, responseContent, toolIterations);

      // Emit INCREMENTAL chunk (like parent chat) - chunk.chunk is already the new piece
      // This allows StreamingController to append efficiently without re-rendering
      this.events.onStreamingUpdate?.(
        branchId,
        assistantMessageId,
        chunk.chunk,  // Just the NEW chunk, not full content
        chunk.complete,
        responseContent  // Full content for finalization
      );
    }

    // Update status with final count
    this.updateStatus(subagentId, { iterations: toolIterations || 1, lastToolUsed });

    // Convert tool calls for storage
    const finalToolCalls: ToolCall[] | undefined = toolCalls?.map(tc => ({
      ...tc,
      type: tc.type || 'function',
    }));

    // Update the placeholder message in storage with final content
    await this.dependencies.branchService.updateMessageInBranch(branchId, assistantMessageId, {
      content: responseContent,
      state: 'complete',
      toolCalls: finalToolCalls,
      reasoning: reasoning || undefined,
    });

    // Streaming completed = LLM is done (all tool calls already handled internally)
    await this.dependencies.branchService.updateBranchState(branchId, 'complete', toolIterations || 1);

    // Clear from in-memory map now that streaming is complete and saved
    this.streamingBranchMessages.delete(branchId);

    return {
      success: true,
      content: responseContent,
      branchId,
      conversationId: params.parentConversationId,
      iterations: toolIterations || 1,
    };
  }

  /**
   * Build system prompt for subagent
   * @param params Subagent parameters
   * @param toolSchemas Pre-fetched tool schemas to include (optional)
   * @param contextFilesContent Content from context files to include (optional)
   */
  private async buildSystemPrompt(
    params: SubagentParams,
    toolSchemas?: string,
    contextFilesContent?: string
  ): Promise<string> {
    // Determine if tools were pre-loaded by parent
    const hasPreloadedTools = toolSchemas && toolSchemas.length > 0;

    // Start with inherited agent prompt if available
    let promptParts: string[] = [];

    // 1. Add inherited agent persona/prompt if parent had a custom agent selected
    if (params.agentPrompt) {
      promptParts.push(`## Inherited Agent Context\n${params.agentPrompt}`);
    } else if (params.agentName) {
      promptParts.push(`[Agent persona: ${params.agentName}]`);
    } else if (params.agent) {
      promptParts.push(`[Agent persona: ${params.agent}]`);
    }

    // 2. Add core subagent instructions
    promptParts.push(`## Subagent Instructions

You are an AUTONOMOUS subagent. You MUST complete tasks independently using tools.

### Your Task
${params.task}

### CRITICAL RULES

1. **NEVER ask questions or seek clarification** - You are autonomous. Make reasonable assumptions and proceed.

2. **ALWAYS use tools** - Your first response MUST include tool calls.

3. **Text-only response = Task complete** - Only respond with plain text (no tool calls) when you have FINISHED the task and are reporting results.

4. **Make decisions independently** - If details are ambiguous, choose sensible defaults. Do not ask the user.

5. **Use thinking/reasoning internally** - Deliberate in your thinking, not in your text output.`);

    // 3. Add workspace context if available
    if (params.workspaceData) {
      const workspaceContext = this.formatWorkspaceData(params.workspaceData);
      if (workspaceContext) {
        promptParts.push(`## Workspace Context\n${workspaceContext}`);
      }
    }

    // 4. Add context files content if available (from parent's notes + tool params)
    if (contextFilesContent) {
      promptParts.push(`## Reference Files\nThe following files have been provided as context:\n\n${contextFilesContent}`);
    }

    // 5. Add tool section based on whether tools were pre-loaded
    if (hasPreloadedTools) {
      promptParts.push(`## Pre-loaded Tools (Ready to Use)

The parent agent has equipped you with these specific tools. Use them via toolManager_useTool:

${toolSchemas}

**To call a tool**, use toolManager_useTool with:
\`\`\`json
{
  "context": {
    "workspaceId": "${params.workspaceId || 'default'}",
    "sessionId": "${params.sessionId || 'subagent'}",
    "memory": "Subagent working on: ${params.task.substring(0, 50)}...",
    "goal": "Complete the assigned task"
  },
  "calls": [
    { "agent": "agentName", "tool": "toolName", "params": { ... } }
  ]
}
\`\`\`

BEGIN - Use the pre-loaded tools above to complete the task.`);
    } else {
      promptParts.push(`## Available Tools

Call toolManager_getTools first to discover available tools, then toolManager_useTool to execute them.

Example flow:
1. Call getTools to see what's available
2. Call useTool with the appropriate agent/tool/params
3. Continue until task is complete
4. Respond with final results (no tool calls)

BEGIN - Start by calling getTools to discover available tools.`);
    }

    return promptParts.join('\n\n');
  }

  /**
   * Format workspace data for inclusion in system prompt
   * Uses shared utility for consistency with SystemPromptBuilder
   */
  private formatWorkspaceData(workspaceData: any): string {
    // Import dynamically to avoid circular dependencies
    const { formatWorkspaceDataForPrompt } = require('../../utils/WorkspaceDataFormatter');
    return formatWorkspaceDataForPrompt(workspaceData, { maxStates: 3 });
  }

  /**
   * Build initial user message with task and context
   * Tool schemas are now in the system prompt, not here
   */
  private buildInitialMessage(task: string, context: string): string {
    let message = `Execute this task:\n\n${task}`;

    if (context) {
      message += `\n\n## Additional Context\n${context}`;
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
        const results = await this.dependencies.directToolExecutor.executeToolCalls([{
          id: `ctx_${Date.now()}`,
          function: {
            name: 'contentManager.readContent',
            arguments: JSON.stringify({ filePath: file }),
          },
        }]);
        const result = results[0];

        if (result?.success && (result.result as { content?: string })?.content) {
          contents.push(`--- ${file} ---\n${(result.result as { content: string }).content}`);
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
