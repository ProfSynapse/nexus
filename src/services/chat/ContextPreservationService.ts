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
  params?: any;
  parameters?: any;
  input?: any;
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
        tools?: any[];
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
  ) => Promise<Array<{ success: boolean; result?: any; error?: string }>>;
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
  private getCreateStateToolSchema(): any | null {
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
    createStateSchema: any
  ): Promise<Omit<PreservationResult, 'attempts'>> {
    // Stream response from LLM with save state prompt
    let toolCalls: ToolCall[] = [];

    try {
      for await (const chunk of this.deps.llmService.generateResponseStream(
        messages,
        {
          provider: llmOptions.provider,
          model: llmOptions.model,
          systemPrompt: SAVE_STATE_SYSTEM_PROMPT,
          tools: [createStateSchema],
        }
      )) {
        if (chunk.toolCalls && chunk.toolCalls.length > 0) {
          toolCalls = chunk.toolCalls;
        }
      }
    } catch (error) {
      return {
        success: false,
        error: `LLM generation failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    // Validate we got a createState tool call
    const createStateCall = toolCalls.find((tc) => {
      const name = tc.function?.name || tc.name || '';
      return name === 'createState' || name.includes('createState');
    });

    if (!createStateCall) {
      return {
        success: false,
        error: 'No createState tool call in response',
      };
    }

    // Extract and validate parameters
    const params = this.extractToolParams(createStateCall);
    if (!params.id || !params.content) {
      return {
        success: false,
        error: 'createState call missing required id or content',
      };
    }

    // Format as DirectToolCall for executor
    const directToolCall: DirectToolCall = {
      id: createStateCall.id || `createState_${Date.now()}`,
      type: 'function',
      function: {
        name: 'memoryManager.createState', // Full tool path for DirectToolExecutor
        arguments: JSON.stringify(params),
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
            ? JSON.parse(toolCall.function.arguments)
            : toolCall.function.arguments;
        return { id: args.id, content: args.content };
      } catch {
        // Fall through
      }
    }

    // Try direct params/parameters/input format
    const params = toolCall.params || toolCall.parameters || toolCall.input || {};
    return { id: params.id, content: params.content };
  }
}
