/**
 * OpenAI-Compatible Chat Helpers
 * Location: src/services/llm/adapters/shared/OpenAICompatHelpers.ts
 *
 * Shared request-building helpers for adapters that speak the OpenAI
 * chat-completions wire shape (Groq, Mistral, DeepSeek, OpenRouter, OpenAI).
 * Extracted from per-adapter copies; behavior-preserving.
 */
import { GenerateOptions, Tool } from '../types';

/**
 * Standard Bearer-token JSON headers used by OpenAI-compatible providers.
 */
export function buildBearerJsonHeaders(apiKey: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${apiKey}`
  };
}

/**
 * Map an OpenAI-compatible finish_reason onto the unified finish reason.
 * Unknown or missing reasons fall back to 'stop'.
 */
export function mapOpenAiCompatFinishReason(
  reason: string | null
): 'stop' | 'length' | 'tool_calls' | 'content_filter' {
  if (!reason) return 'stop';

  const reasonMap: Record<string, 'stop' | 'length' | 'tool_calls' | 'content_filter'> = {
    'stop': 'stop',
    'length': 'length',
    'tool_calls': 'tool_calls',
    'content_filter': 'content_filter'
  };
  return reasonMap[reason] || 'stop';
}

/**
 * Build a chat messages array, using conversationHistory for tool
 * continuations and prepending the system prompt if it was stripped by the
 * context builder. Falls back to [system?, user] built from the prompt.
 */
export function buildMessagesWithConversationHistory(
  prompt: string,
  options?: Pick<GenerateOptions, 'systemPrompt' | 'conversationHistory'>
): Array<Record<string, unknown>> {
  if (options?.conversationHistory && options.conversationHistory.length > 0) {
    const messages = options.conversationHistory;
    if (options.systemPrompt) {
      const hasSystem = (messages as Array<{ role: string }>).some(m => m.role === 'system');
      if (!hasSystem) {
        return [{ role: 'system', content: options.systemPrompt }, ...messages];
      }
    }
    return messages;
  }

  const messages: Array<Record<string, unknown>> = [];
  if (options?.systemPrompt) {
    messages.push({ role: 'system', content: options.systemPrompt });
  }
  messages.push({ role: 'user', content: prompt });
  return messages;
}

/**
 * Convert unified Tool definitions to the OpenAI chat-completions tool shape.
 * Throws on non-function tools (matches prior Groq/DeepSeek behavior).
 */
export function convertFunctionTools(
  tools: Tool[]
): Array<{ type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }> {
  return tools.map(tool => {
    if (tool.type === 'function' && tool.function) {
      return {
        type: 'function' as const,
        function: {
          name: tool.function.name,
          description: tool.function.description,
          parameters: tool.function.parameters
        }
      };
    }
    throw new Error(`Unsupported tool type: ${tool.type}`);
  });
}
