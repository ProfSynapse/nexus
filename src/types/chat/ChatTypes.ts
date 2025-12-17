/**
 * Chat Types - Minimal type definitions for native chatbot
 * Pure JSON-based chat
 */

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  timestamp: number;
  conversationId: string;
  state?: 'draft' | 'streaming' | 'complete' | 'aborted' | 'invalid'; // Message lifecycle state
  toolCalls?: ToolCall[];
  tokens?: number;
  alternatives?: ChatMessage[];
  activeAlternativeIndex?: number;
  isLoading?: boolean;
  metadata?: Record<string, any>;
  // Reasoning/thinking content from LLMs that support it (Claude, GPT-5, Gemini)
  reasoning?: string;
}

export interface ToolCall {
  id: string;
  type: string;
  name?: string;
  displayName?: string;
  technicalName?: string;
  function: {
    name: string;
    arguments: string;
  };
  result?: any;
  success?: boolean;
  error?: string;
  parameters?: any;
  executionTime?: number;
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
    cost?: {
      totalCost: number;
      currency: string;
    };
    totalCost?: number;
    currency?: string;
    [key: string]: any;
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

export interface MessageBranch {
  id: string;
  parentId?: string;
  message: ChatMessage;
  children: string[];
  isActive: boolean;
}

// Legacy type aliases for compatibility
export type ConversationData = Conversation;
export type ConversationMessage = ChatMessage;

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
  metadata?: Record<string, any>;
}

export interface UpdateConversationParams {
  id: string;
  title?: string;
  metadata?: Record<string, any>;
}

export function documentToConversationData(doc: ConversationDocument): Conversation {
  return doc.data;
}
