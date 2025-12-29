/**
 * Type definitions and interfaces for the suggester system
 * Supports three suggester types: Tools (/), Agents (@), and Notes ([[)
 */

import { Editor, EditorPosition, TFile } from 'obsidian';

// ============================================================================
// Core Suggester Types
// ============================================================================

/**
 * Base suggester context passed to all suggesters
 */
export interface EditorSuggestContext {
  /** Text after trigger character */
  query: string;
  /** Trigger start position */
  start: EditorPosition;
  /** Current cursor position */
  end: EditorPosition;
  /** Obsidian editor instance */
  editor: Editor;
}

/**
 * Configuration for suggester behavior
 */
export interface SuggesterConfig {
  /** Trigger pattern (e.g., /^\/(\w*)$/ for slash commands) */
  trigger: RegExp;
  /** Maximum suggestions to show */
  maxSuggestions: number;
  /** Cache TTL in milliseconds */
  cacheTTL: number;
  /** Debounce delay in ms */
  debounceDelay?: number;
}

/**
 * Wrapper for suggestion items with metadata
 */
export interface SuggestionItem<T> {
  /** The actual suggestion data */
  data: T;
  /** Match score for ranking (higher = better) */
  score: number;
  /** Display text */
  displayText: string;
  /** Optional description */
  description?: string;
  /** Estimated token count */
  tokens?: number;
}

/**
 * Cache entry with TTL
 */
export interface CacheEntry<T> {
  /** Cached data */
  data: T[];
  /** Timestamp when cached */
  timestamp: number;
}

// ============================================================================
// Tool Suggester Types
// ============================================================================

/**
 * Tool suggestion data
 */
export interface ToolSuggestionItem {
  /** Tool name (e.g., "storageManager.list") */
  name: string;
  /** Human-friendly display name (e.g., "Read File") */
  displayName?: string;
  /** Tool description */
  description: string;
  /** Tool category/manager */
  category: string;
  /** Full tool schema */
  schema: ToolSchema;
}

/**
 * MCP Tool schema structure
 */
export interface ToolSchema {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * Tool hint for injection
 */
export interface ToolHint {
  /** Tool name */
  name: string;
  /** Tool schema */
  schema: ToolSchema;
}

// ============================================================================
// Prompt Suggester Types
// ============================================================================

/**
 * Prompt suggestion data
 */
export interface PromptSuggestionItem {
  /** Prompt unique ID */
  id: string;
  /** Prompt display name */
  name: string;
  /** Prompt description */
  description: string;
  /** Prompt instructions */
  prompt: string;
  /** Estimated prompt token count */
  promptTokens: number;
}

/**
 * Prompt reference for injection
 */
export interface PromptReference {
  /** Prompt ID */
  id: string;
  /** Prompt name */
  name: string;
  /** Prompt content */
  prompt: string;
  /** Token count */
  tokens: number;
}

// ============================================================================
// Note Suggester Types
// ============================================================================

/**
 * Note suggestion data
 */
export interface NoteSuggestionItem {
  /** TFile reference */
  file: TFile;
  /** Display name (basename) */
  name: string;
  /** Full path */
  path: string;
  /** File size in bytes */
  size: number;
  /** Estimated token count */
  estimatedTokens: number;
}

/**
 * Note reference for injection
 */
export interface NoteReference {
  /** File path */
  path: string;
  /** File name */
  name: string;
  /** File content */
  content: string;
  /** Token count */
  tokens: number;
}

// ============================================================================
// Workspace Suggester Types
// ============================================================================

/**
 * Workspace suggestion data
 */
export interface WorkspaceSuggestionItem {
  /** Workspace ID */
  id: string;
  /** Workspace name */
  name: string;
  /** Workspace description */
  description?: string;
  /** Root folder */
  rootFolder: string;
  /** Last accessed timestamp */
  lastAccessed: number;
}

/**
 * Workspace reference for injection
 */
export interface WorkspaceReference {
  /** Workspace ID */
  id: string;
  /** Workspace name */
  name: string;
  /** Workspace description */
  description?: string;
  /** Root folder */
  rootFolder: string;
}

// ============================================================================
// Message Enhancement Types
// ============================================================================

/**
 * Enhancement type discriminator
 */
export enum EnhancementType {
  TOOL = 'tool',
  PROMPT = 'prompt',
  NOTE = 'note',
  WORKSPACE = 'workspace'
}

/**
 * Message enhancement metadata
 */
export interface MessageEnhancement {
  /** Original user message */
  originalMessage: string;
  /** Cleaned message (triggers removed) */
  cleanedMessage: string;
  /** Tool hints */
  tools: ToolHint[];
  /** Prompt references */
  prompts: PromptReference[];
  /** Note references */
  notes: NoteReference[];
  /** Workspace references */
  workspaces: WorkspaceReference[];
  /** Total estimated tokens */
  totalTokens: number;
}

/**
 * Enhancement data for a single selection
 */
export interface EnhancementData {
  type: EnhancementType;
  data: ToolHint | PromptReference | NoteReference | WorkspaceReference;
}

// ============================================================================
// Registry Types
// ============================================================================

/**
 * Suggester type discriminator
 */
export enum SuggesterType {
  TOOL = 'tool',
  PROMPT = 'prompt',
  NOTE = 'note',
  WORKSPACE = 'workspace'
}

/**
 * Suggester status
 */
export interface SuggesterStatus {
  /** Is suggester currently active */
  active: boolean;
  /** Current query text */
  query?: string;
  /** Number of current suggestions */
  suggestionCount?: number;
}

// ============================================================================
// Token Warning Types
// ============================================================================

/**
 * Token warning levels
 */
export enum TokenWarningLevel {
  NONE = 'none',
  INFO = 'info',
  WARNING = 'warning',
  ERROR = 'error'
}

/**
 * Token warning data
 */
export interface TokenWarning {
  level: TokenWarningLevel;
  message: string;
  currentTokens: number;
  maxTokens: number;
  percentage: number;
}
