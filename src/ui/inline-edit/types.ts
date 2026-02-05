/**
 * Inline Edit Types
 *
 * Type definitions for the inline AI editing feature.
 * Allows users to select text and transform it via LLM instructions.
 */

import type { EditorPosition, Editor, MarkdownView } from 'obsidian';

/**
 * Context captured when the inline edit is triggered
 * Stores selection state before modal opens (editor loses focus on modal open)
 */
export interface SelectionContext {
  /** The selected text to be edited */
  selectedText: string;
  /** Start position of the selection */
  from: EditorPosition;
  /** End position of the selection */
  to: EditorPosition;
  /** Reference to the editor for applying changes */
  editor: Editor;
  /** Reference to the view containing the editor */
  view: MarkdownView;
  /** Name of the file being edited */
  fileName: string;
}

/**
 * Request parameters for inline text editing
 */
export interface InlineEditRequest {
  /** The selected text to be transformed */
  selectedText: string;
  /** User's instruction for how to transform the text */
  instruction: string;
  /** Optional context about the editing environment */
  context?: {
    fileName: string;
    cursorPosition: EditorPosition;
  };
  /** Model configuration for the LLM request */
  modelConfig: {
    provider: string;
    model: string;
  };
}

/**
 * Result of an inline edit operation
 */
export interface InlineEditResult {
  /** Whether the operation succeeded */
  success: boolean;
  /** The transformed text (on success) */
  editedText?: string;
  /** Error message (on failure) */
  error?: string;
  /** Token usage statistics */
  tokenUsage?: {
    input: number;
    output: number;
  };
}

/**
 * State machine for the inline edit modal
 *
 * Flow:
 * INPUT -> LOADING -> RESULT
 *            ^          |
 *            +-- Retry -+
 *
 * INPUT -> ERROR (on validation failure)
 * LOADING -> ERROR (on LLM failure)
 * ERROR -> INPUT (on retry from error)
 */
export type InlineEditState =
  | { phase: 'input'; selectedText: string }
  | { phase: 'loading'; progress?: string; streamedText?: string }
  | { phase: 'result'; original: string; edited: string }
  | { phase: 'error'; message: string; lastInstruction?: string };

/**
 * Available model information for the dropdown
 */
export interface AvailableModel {
  providerId: string;
  modelId: string;
  displayName: string;
}

/**
 * Events emitted by the InlineEditService
 */
export type InlineEditEvent =
  | { type: 'state-change'; state: InlineEditState }
  | { type: 'stream-chunk'; chunk: string }
  | { type: 'complete'; result: InlineEditResult }
  | { type: 'error'; error: string };

/**
 * Callback interface for state changes
 */
export interface InlineEditCallbacks {
  onStateChange?: (state: InlineEditState) => void;
  onStreamChunk?: (chunk: string) => void;
  onComplete?: (result: InlineEditResult) => void;
  onError?: (error: string) => void;
}
