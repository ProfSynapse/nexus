/**
 * Chat Types - Minimal type definitions for native chatbot
 * Pure JSON-based chat
 */

import type { ConversationBranch } from '../branch/BranchTypes';

/** Token usage data for a message */
export interface MessageUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/** Cost data for a message */
export interface MessageCost {
  totalCost: number;
  currency: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  timestamp: number;
  conversationId: string;
  state?: 'draft' | 'streaming' | 'complete' | 'aborted' | 'invalid'; // Message lifecycle state
  toolCalls?: ToolCall[];
  tokens?: number;
  isLoading?: boolean;
  metadata?: Record<string, unknown>;
  // Reasoning/thinking content from LLMs that support it (Claude, GPT-5, Gemini)
  reasoning?: string;

  // Provider/model that generated this message
  provider?: string;
  model?: string;

  // Token usage and cost tracking
  usage?: MessageUsage;
  cost?: MessageCost;

  /**
   * Conversation branches from this message point.
   * Replaces the old alternatives[] system with unified branching.
   * - Human branches: inheritContext=true (includes parent context)
   * - Subagent branches: inheritContext=false (fresh start)
   */
  branches?: ConversationBranch[];

  /** Inline message alternatives for human regeneration (retry/regenerate) */
  alternatives?: ChatMessage[];

  /** Which alternative is active: 0 = original, 1+ = alternative index + 1 */
  activeAlternativeIndex?: number;
}

/** Format the model used to output tool calls */
export type ToolCallFormat = 'bracket' | 'xml' | 'native';

export interface ToolCall {
  id: string;
  type: 'function';
  name?: string;
  displayName?: string;
  technicalName?: string;
  function: {
    name: string;
    arguments: string;
  };
  result?: unknown;
  success?: boolean;
  error?: string;
  parameters?: Record<string, unknown>;
  executionTime?: number;
  /** Format the model used: 'bracket' = [TOOL_CALLS], 'xml' = <tool_call>, 'native' = OpenAI tool_calls */
  sourceFormat?: ToolCallFormat;
}

export interface Conversation {
  id: string;
  title: string;
  messages: ChatMessage[];
  created: number;
  updated: number;
  cost?: {
    totalCost: number;
    currency: string;
  };
  metadata?: {
    previousResponseId?: string; // OpenAI Responses API: Track last response ID for continuations
    responsesApiId?: string; // Alternative name for OpenAI Responses API
    cost?: {
      totalCost: number;
      currency: string;
    };
    totalCost?: number;
    currency?: string;
    // Branch support: when set, this conversation is a branch of another
    parentConversationId?: string;  // The parent conversation this branched from
    parentMessageId?: string;       // The specific message this branched from
    branchType?: 'subagent' | 'alternative';  // Type of branch
    subagentTask?: string;          // For subagent branches: the task description
    // Chat settings
    chatSettings?: {
      providerId?: string;
      modelId?: string;
      systemPrompt?: string;
      workspaceId?: string;
      sessionId?: string;
    };
    [key: string]: unknown;
  };
}

export interface ChatContext {
  conversationId: string;
  currentMessage?: ChatMessage;
  previousMessages: ChatMessage[];
  tokens: {
    input: number;
    output: number;
    total: number;
  };
}

// Legacy type aliases for compatibility
export type ConversationData = Conversation;
export type ConversationMessage = ChatMessage;

// Branch helper functions
export function isBranchConversation(conversation: Conversation): boolean {
  return !!conversation.metadata?.parentConversationId;
}

export function getBranchParent(conversation: Conversation): { parentConversationId: string; parentMessageId: string } | null {
  if (!conversation.metadata?.parentConversationId) {
    return null;
  }
  return {
    parentConversationId: conversation.metadata.parentConversationId,
    parentMessageId: conversation.metadata.parentMessageId || '',
  };
}

export interface ConversationDocument {
  id: string;
  data: Conversation;
}

export interface ConversationSearchOptions {
  query?: string;
  limit?: number;
  offset?: number;
}

export interface ConversationSearchResult {
  conversations: Conversation[];
  total: number;
}

export interface CreateConversationParams {
  title?: string;
  initialMessage?: string;
  provider?: string;
  model?: string;
  systemPrompt?: string;
  workspaceId?: string;
  sessionId?: string;
}

export interface AddMessageParams {
  conversationId: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  toolCalls?: ToolCall[];
  metadata?: Record<string, unknown>;
}

export interface UpdateConversationParams {
  id: string;
  title?: string;
  metadata?: Record<string, unknown>;
}

export function documentToConversationData(doc: ConversationDocument): Conversation {
  return doc.data;
}
