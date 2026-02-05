/**
 * InlineEditService - Business logic for inline AI text editing
 *
 * Responsibilities:
 * - State machine management (INPUT -> LOADING -> RESULT)
 * - LLM streaming integration with cancellation support
 * - Concurrent request blocking
 *
 * Uses the same LLMService infrastructure as the chat system.
 */

import type { LLMService } from './llm/core/LLMService';
import type {
  InlineEditState,
  InlineEditRequest,
  InlineEditResult,
  InlineEditCallbacks
} from '../ui/inline-edit/types';

/**
 * System prompt for inline editing operations
 * Instructs the LLM to only return the edited text, no explanations
 */
const INLINE_EDIT_SYSTEM_PROMPT = `You are a precise text editor. Your task is to modify the given text according to the user's instructions.

Rules:
1. Return ONLY the modified text - no explanations, no markdown code blocks, no preamble
2. Preserve the original formatting style (markdown, indentation, etc.) unless instructed otherwise
3. If the instruction is unclear, make your best interpretation
4. If the instruction cannot be applied, return the original text unchanged

You will receive:
- The selected text to edit
- An instruction for how to modify it

Respond with only the edited text.`;

export class InlineEditService {
  private state: InlineEditState = { phase: 'input', selectedText: '' };
  private abortController: AbortController | null = null;
  private isActive = false;
  private callbacks: InlineEditCallbacks = {};

  constructor(private llmService: LLMService) {}

  /**
   * Set callbacks for state changes and events
   */
  setCallbacks(callbacks: InlineEditCallbacks): void {
    this.callbacks = callbacks;
  }

  /**
   * Get current state
   */
  getState(): InlineEditState {
    return this.state;
  }

  /**
   * Check if a generation is currently active
   */
  isGenerating(): boolean {
    return this.isActive;
  }

  /**
   * Initialize with selected text (transition to INPUT state)
   */
  initialize(selectedText: string): void {
    this.state = { phase: 'input', selectedText };
    this.notifyStateChange();
  }

  /**
   * Generate edited text from instruction
   *
   * State transitions:
   * INPUT -> LOADING -> RESULT (success)
   * INPUT -> LOADING -> ERROR (failure)
   *
   * @param request - The edit request parameters
   * @returns Promise resolving to the edit result
   */
  async generate(request: InlineEditRequest): Promise<InlineEditResult> {
    // Block concurrent requests
    if (this.isActive) {
      return {
        success: false,
        error: 'A generation is already in progress. Please wait or cancel first.'
      };
    }

    // Validate instruction
    if (!request.instruction || request.instruction.trim().length === 0) {
      this.transitionToError('Please enter an instruction for how to edit the text.');
      return { success: false, error: 'Empty instruction' };
    }

    // Transition to loading state
    this.isActive = true;
    this.state = { phase: 'loading', progress: 'Connecting...', streamedText: '' };
    this.notifyStateChange();

    // Create abort controller for cancellation
    this.abortController = new AbortController();

    try {
      const result = await this.executeGeneration(request);

      if (result.success && result.editedText) {
        // Transition to result state
        this.state = {
          phase: 'result',
          original: request.selectedText,
          edited: result.editedText
        };
        this.notifyStateChange();
        this.callbacks.onComplete?.(result);
      } else {
        this.transitionToError(result.error || 'Unknown error occurred', request.instruction);
      }

      return result;
    } catch (error) {
      // Handle abort specifically
      if (error instanceof DOMException && error.name === 'AbortError') {
        // User cancelled - return to input state
        this.state = { phase: 'input', selectedText: request.selectedText };
        this.notifyStateChange();
        return { success: false, error: 'Cancelled by user' };
      }

      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
      this.transitionToError(errorMessage, request.instruction);
      return { success: false, error: errorMessage };
    } finally {
      this.isActive = false;
      this.abortController = null;
    }
  }

  /**
   * Execute the LLM generation with streaming
   */
  private async executeGeneration(request: InlineEditRequest): Promise<InlineEditResult> {
    const { selectedText, instruction, modelConfig, context } = request;

    // Build user prompt with context
    let userPrompt = `TEXT TO EDIT:\n${selectedText}\n\nINSTRUCTION: ${instruction}`;
    if (context?.fileName) {
      userPrompt = `[File: ${context.fileName}]\n\n${userPrompt}`;
    }

    // Build messages array for LLM
    const messages = [
      { role: 'system', content: INLINE_EDIT_SYSTEM_PROMPT },
      { role: 'user', content: userPrompt }
    ];

    // Stream options
    const options = {
      provider: modelConfig.provider,
      model: modelConfig.model,
      temperature: 0.3, // Lower temperature for more predictable edits
      abortSignal: this.abortController?.signal
    };

    let accumulatedText = '';
    let inputTokens = 0;
    let outputTokens = 0;

    // Update progress state
    this.state = { phase: 'loading', progress: 'Generating...', streamedText: '' };
    this.notifyStateChange();

    // Stream the response
    for await (const chunk of this.llmService.generateResponseStream(messages, options)) {
      // Check for abort
      if (this.abortController?.signal.aborted) {
        throw new DOMException('Generation aborted by user', 'AbortError');
      }

      // Accumulate text
      if (chunk.chunk) {
        accumulatedText += chunk.chunk;

        // Update state with streamed text
        this.state = {
          phase: 'loading',
          progress: 'Generating...',
          streamedText: accumulatedText
        };
        this.notifyStateChange();
        this.callbacks.onStreamChunk?.(chunk.chunk);
      }

      // Capture usage on completion
      if (chunk.complete && chunk.usage) {
        inputTokens = chunk.usage.promptTokens || 0;
        outputTokens = chunk.usage.completionTokens || 0;
      }
    }

    // Return result
    return {
      success: true,
      editedText: accumulatedText.trim(),
      tokenUsage: {
        input: inputTokens,
        output: outputTokens
      }
    };
  }

  /**
   * Cancel current generation
   */
  cancel(): void {
    if (this.abortController && this.isActive) {
      this.abortController.abort();
    }
  }

  /**
   * Reset to input state (for retry from result)
   */
  reset(selectedText: string, preserveInstruction?: string): void {
    this.cancel();
    this.isActive = false;
    this.state = { phase: 'input', selectedText };
    this.notifyStateChange();
  }

  /**
   * Update the edited text (user editing in result state)
   */
  updateEditedText(newText: string): void {
    if (this.state.phase === 'result') {
      this.state = {
        ...this.state,
        edited: newText
      };
      // Don't notify - this is just tracking local edits
    }
  }

  /**
   * Transition to error state
   */
  private transitionToError(message: string, lastInstruction?: string): void {
    this.state = { phase: 'error', message, lastInstruction };
    this.notifyStateChange();
    this.callbacks.onError?.(message);
  }

  /**
   * Notify callbacks of state change
   */
  private notifyStateChange(): void {
    this.callbacks.onStateChange?.(this.state);
  }

  /**
   * Clean up resources
   */
  dispose(): void {
    this.cancel();
    this.callbacks = {};
  }
}
