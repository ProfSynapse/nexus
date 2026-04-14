/**
 * ContextPreservationService
 *
 * Forces the LLM to save important context via createState tool before compaction.
 * This is a subprocess that runs at 90% context threshold.
 *
 * Flow:
 * 1. Swap system prompt to one that REQUIRES createState tool use
 * 2. Send conversation to LLM with this special prompt
 * 3. Wait for createState tool call
 * 4. Validate tool was called correctly
 * 5. Retry up to MAX_RETRIES times if validation fails
 * 6. Return saved state content for injection into previous_context
 */

import { ConversationMessage } from '../../types/chat/ChatTypes';
import type { IAgent } from '../../agents/interfaces/IAgent';
import { GLOBAL_WORKSPACE_ID } from '../WorkspaceService';

/**
 * System prompt that forces the model to use createState
 */
const SAVE_STATE_SYSTEM_PROMPT = `You are about to reach your context limit. You MUST use the createState tool to save important context from this conversation before it is compacted.

CRITICAL: You MUST call the createState tool. Do not respond with text - only use the tool.

Include in your state:
- The user's overall goal/task
- Key decisions made so far
- Important files/paths discussed
- Current status/progress
- Any constraints or preferences the user mentioned
- Critical context needed to continue the conversation

Call the createState tool NOW with a descriptive id and comprehensive content.`;

/**
 * Result of a preservation attempt
 */
export interface PreservationResult {
  success: boolean;
  stateId?: string;
  stateContent?: string;
  error?: string;
  attempts: number;
}

/**
 * Options for the preservation service
 */
export interface PreservationOptions {
  maxRetries?: number;
  timeout?: number;
}

const DEFAULT_OPTIONS: Required<PreservationOptions> = {
  maxRetries: 2,
  timeout: 30000,
};

/**
 * Tool call format from LLM response
 */
interface ToolCall {
  id?: string;
  function?: {
    name: string;
    arguments: string;
  };
  name?: string;
  params?: Record<string, unknown>;
  parameters?: Record<string, unknown>;
  input?: Record<string, unknown>;
}

/**
 * DirectToolCall format for executor
 */
interface DirectToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

/** OpenAI-format tool schema */
interface OpenAIToolSchema {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: unknown;
  };
}

/**
 * Dependencies for the preservation service
 */
export interface PreservationDependencies {
  /** LLM service for generating responses */
  llmService: {
    generateResponseStream: (
      messages: ConversationMessage[],
      options: {
        provider?: string;
        model?: string;
        systemPrompt?: string;
        tools?: OpenAIToolSchema[];
      }
    ) => AsyncGenerator<{
      chunk: string;
      complete: boolean;
      toolCalls?: ToolCall[];
    }>;
  };
  /** Agent provider for getting tool schemas */
  getAgent: (name: string) => IAgent | null;
  /** Tool executor for running createState */
  executeToolCalls: (
    toolCalls: DirectToolCall[],
    context?: { sessionId?: string; workspaceId?: string }
  ) => Promise<Array<{ success: boolean; result?: unknown; error?: string }>>;
}

export class ContextPreservationService {
  private deps: PreservationDependencies;
  private options: Required<PreservationOptions>;

  constructor(
    deps: PreservationDependencies,
    options: PreservationOptions = {}
  ) {
    this.deps = deps;
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  /**
   * Get createState tool schema in OpenAI format
   */
  private getCreateStateToolSchema(): OpenAIToolSchema | null {
    const memoryManager = this.deps.getAgent('memoryManager');
    if (!memoryManager) {
      return null;
    }

    const createStateTool = memoryManager.getTool('createState');
    if (!createStateTool) {
      return null;
    }

    return {
      type: 'function',
      function: {
        name: 'createState',
        description: createStateTool.description,
        parameters: createStateTool.getParameterSchema(),
      },
    };
  }

  /**
   * Force the LLM to save conversation state via createState tool
   *
   * @param messages Current conversation messages
   * @param llmOptions Provider/model options for the LLM call
   * @param contextOptions Workspace/session context for tool execution
   * @returns PreservationResult with saved state content or error
   */
  async forceStateSave(
    messages: ConversationMessage[],
    llmOptions: {
      provider?: string;
      model?: string;
    },
    contextOptions: {
      workspaceId?: string;
      sessionId?: string;
    }
  ): Promise<PreservationResult> {
    // Get createState tool schema
    const createStateSchema = this.getCreateStateToolSchema();
    if (!createStateSchema) {
      return {
        success: false,
        error: 'createState tool not found in memoryManager',
        attempts: 0,
      };
    }

    let attempts = 0;
    let currentMessages = [...messages];

    while (attempts < this.options.maxRetries) {
      attempts++;

      try {
        const result = await this.attemptStateSave(
          currentMessages,
          llmOptions,
          contextOptions,
          createStateSchema
        );

        if (result.success) {
          return { ...result, attempts };
        }

        // If we got a response but no valid tool call, retry with stronger prompt
        if (attempts < this.options.maxRetries) {
          // Add a reminder message for retry
          // Get conversationId from first message (all messages in a conversation share this)
          const conversationId = currentMessages[0]?.conversationId || 'context_save';
          currentMessages = [
            ...currentMessages,
            {
              id: `retry_${attempts}`,
              role: 'user' as const,
              content: 'You did not call the createState tool. You MUST call it now to save the conversation context.',
              timestamp: Date.now(),
              conversationId,
            },
          ];
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);

        if (attempts >= this.options.maxRetries) {
          return {
            success: false,
            error: `Failed after ${attempts} attempts: ${errorMessage}`,
            attempts,
          };
        }
      }
    }

    return {
      success: false,
      error: `Failed to get valid createState call after ${attempts} attempts`,
      attempts,
    };
  }

  /**
   * Serialize conversation messages into a readable transcript string.
   * This is used to pack the conversation into a single user message
   * so that ProviderMessageBuilder always sees a user-role last message.
   */
  private serializeMessagesToTranscript(messages: ConversationMessage[]): string {
    const lines: string[] = [];
    for (const msg of messages) {
      if (msg.role === 'tool' || !msg.content?.trim()) {
        continue;
      }
      const label = msg.role === 'user' ? 'User' : 'Assistant';
      lines.push(`[${label}]: ${msg.content}`);
    }
    return lines.join('\n\n');
  }

  /**
   * Single attempt to get the LLM to save state
   */
  private async attemptStateSave(
    messages: ConversationMessage[],
    llmOptions: {
      provider?: string;
      model?: string;
    },
    contextOptions: {
      workspaceId?: string;
      sessionId?: string;
    },
    createStateSchema: OpenAIToolSchema
  ): Promise<Omit<PreservationResult, 'attempts'>> {
    // Serialize the conversation into a single user message containing the transcript.
    // ProviderMessageBuilder.buildInitialOptions extracts only the last message and
    // requires it to be role=user — passing raw messages fails when the last message
    // is an assistant message (empty prompt → HTTP 400).
    const transcript = this.serializeMessagesToTranscript(messages);

    const conversationId = messages[0]?.conversationId || 'context_save';
    const wrappedMessage: ConversationMessage = {
      id: `state_save_${Date.now()}`,
      role: 'user',
      content: `Here is the conversation to preserve:\n\n${transcript}`,
      timestamp: Date.now(),
      conversationId,
    };

    // Stream response from LLM with save state prompt
    let toolCalls: ToolCall[] = [];

    try {
      for await (const chunk of this.deps.llmService.generateResponseStream(
        [wrappedMessage],
        {
          provider: llmOptions.provider,
          model: llmOptions.model,
          systemPrompt: SAVE_STATE_SYSTEM_PROMPT,
          tools: [createStateSchema],
        }
      )) {
        if (chunk.toolCalls && chunk.toolCalls.length > 0) {
          toolCalls = chunk.toolCalls;
          // Break early once we have a createState call — prevents ping-pong loop
          const hasCreateState = toolCalls.some(tc => {
            const name = tc.function?.name || tc.name || '';
            return name === 'createState' || name.includes('createState');
          });
          if (hasCreateState) break;
        }
      }
    } catch (error) {
      return {
        success: false,
        error: `LLM generation failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    const toolNames = toolCalls.map(tc => tc.function?.name || tc.name || '(unknown)');

    // Validate we got a createState tool call
    const createStateCall = toolCalls.find((tc) => {
      const name = tc.function?.name || tc.name || '';
      return name === 'createState' || name.includes('createState');
    });

    if (!createStateCall) {
      return {
        success: false,
        error: `No createState tool call in response (found: ${JSON.stringify(toolNames)})`,
      };
    }

    // Get raw arguments for tool execution — the createState tool expects
    // the original LLM arguments (name, conversationContext, activeTask, etc.),
    // not our mapped id/content.
    const rawArgs = createStateCall.function?.arguments || '{}';

    // Extract id/content only for validation and our return value
    const params = this.extractToolParams(createStateCall);
    if (!params.id || !params.content) {
      return {
        success: false,
        error: 'createState call missing required fields',
      };
    }

    // Override hallucinated workspace/session IDs with real values from context
    let finalArgs = rawArgs;
    try {
      const parsedArgs = JSON.parse(rawArgs) as Record<string, unknown>;
      if (parsedArgs.context && typeof parsedArgs.context === 'object' && parsedArgs.context !== null) {
        const ctx = parsedArgs.context as Record<string, unknown>;
        // Use real workspace/session IDs, falling back to GLOBAL_WORKSPACE_ID
        ctx.workspaceId = contextOptions.workspaceId || GLOBAL_WORKSPACE_ID;
        if (contextOptions.sessionId) {
          ctx.sessionId = contextOptions.sessionId;
        }
      }
      finalArgs = JSON.stringify(parsedArgs);
    } catch {
      // If parsing fails, use raw args as-is
    }

    // Format as DirectToolCall for executor
    const directToolCall: DirectToolCall = {
      id: createStateCall.id || `createState_${Date.now()}`,
      type: 'function',
      function: {
        name: 'memoryManager_createState', // Full tool path for DirectToolExecutor (underscore format)
        arguments: finalArgs, // Pass original LLM args with corrected workspace/session IDs
      },
    };

    // Execute the tool call
    try {
      const results = await this.deps.executeToolCalls(
        [directToolCall],
        contextOptions
      );

      const result = results[0];
      if (result?.success) {
        return {
          success: true,
          stateId: params.id,
          stateContent: params.content,
        };
      } else {
        return {
          success: false,
          error: result?.error || 'createState execution failed',
        };
      }
    } catch (error) {
      return {
        success: false,
        error: `Tool execution failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /**
   * Extract parameters from a tool call (handles different formats)
   */
  private extractToolParams(toolCall: ToolCall): { id?: string; content?: string } {
    // Try function.arguments format (OpenAI style)
    if (toolCall.function?.arguments) {
      try {
        const args =
          typeof toolCall.function.arguments === 'string'
            ? (JSON.parse(toolCall.function.arguments) as unknown)
            : (toolCall.function.arguments as unknown);
        const argsObj = args as Record<string, unknown>;
        // createState schema uses `name` for the state identifier and
        // `conversationContext` for the summary text. Map to id/content.
        const id = typeof argsObj.name === 'string' ? argsObj.name
          : typeof argsObj.id === 'string' ? argsObj.id
          : undefined;
        const content = typeof argsObj.conversationContext === 'string' ? argsObj.conversationContext
          : typeof argsObj.content === 'string' ? argsObj.content
          : undefined;
        return { id, content };
      } catch {
        // Fall through
      }
    }

    // Try direct params/parameters/input format
    const params = toolCall.params || toolCall.parameters || toolCall.input || {};
    const id = typeof params.name === 'string' ? params.name
      : typeof params.id === 'string' ? params.id
      : undefined;
    const content = typeof params.conversationContext === 'string' ? params.conversationContext
      : typeof params.content === 'string' ? params.content
      : undefined;
    return { id, content };
  }
}
