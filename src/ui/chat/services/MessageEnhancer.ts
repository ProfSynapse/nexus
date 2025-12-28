/**
 * MessageEnhancer - Builds enhancement metadata from suggester selections
 * Collects tool hints, agent references, and note content for system prompt injection
 */

import {
  MessageEnhancement,
  ToolHint,
  PromptReference,
  NoteReference,
  WorkspaceReference,
  EnhancementType,
  EnhancementData
} from '../components/suggesters/base/SuggesterInterfaces';
import { TokenCalculator } from '../utils/TokenCalculator';

/**
 * Service for building message enhancements from suggester selections
 */
export class MessageEnhancer {

  private tools: ToolHint[] = [];
  private prompts: PromptReference[] = [];
  private notes: NoteReference[] = [];
  private workspaces: WorkspaceReference[] = [];

  constructor() {
    // No initialization needed - TokenCalculator is static
  }

  // ==========================================================================
  // Add Enhancement Data
  // ==========================================================================

  /**
   * Add a tool hint from tool suggester
   * @param tool - Tool hint data
   */
  addTool(tool: ToolHint): void {
    // Avoid duplicates
    if (!this.tools.find(t => t.name === tool.name)) {
      this.tools.push(tool);
    }
  }

  /**
   * Add a prompt reference from prompt suggester
   * @param prompt - Prompt reference data
   */
  addPrompt(prompt: PromptReference): void {
    // Avoid duplicates
    if (!this.prompts.find(p => p.id === prompt.id)) {
      this.prompts.push(prompt);
    }
  }

  /**
   * Add a note reference from note suggester
   * @param note - Note reference data
   */
  addNote(note: NoteReference): void {
    // Avoid duplicates by path
    if (!this.notes.find(n => n.path === note.path)) {
      this.notes.push(note);
    }
  }

  /**
   * Add a workspace reference from workspace suggester
   * @param workspace - Workspace reference data
   */
  addWorkspace(workspace: WorkspaceReference): void {
    // Avoid duplicates by ID
    if (!this.workspaces.find(w => w.id === workspace.id)) {
      this.workspaces.push(workspace);
    }
  }

  /**
   * Add enhancement data based on type
   * @param enhancement - Enhancement data with type discriminator
   */
  addEnhancement(enhancement: EnhancementData): void {
    switch (enhancement.type) {
      case EnhancementType.TOOL:
        this.addTool(enhancement.data as ToolHint);
        break;
      case EnhancementType.PROMPT:
        this.addPrompt(enhancement.data as PromptReference);
        break;
      case EnhancementType.NOTE:
        this.addNote(enhancement.data as NoteReference);
        break;
      case EnhancementType.WORKSPACE:
        this.addWorkspace(enhancement.data as WorkspaceReference);
        break;
    }
  }

  // ==========================================================================
  // Build Enhancement
  // ==========================================================================

  /**
   * Build final message enhancement object
   * @param originalMessage - Original user message with trigger characters
   * @returns Complete message enhancement
   */
  buildEnhancement(originalMessage: string): MessageEnhancement {
    const cleanedMessage = this.cleanMessage(originalMessage);
    const totalTokens = this.calculateTotalTokens();

    return {
      originalMessage,
      cleanedMessage,
      tools: [...this.tools],
      prompts: [...this.prompts],
      notes: [...this.notes],
      workspaces: [...this.workspaces],
      totalTokens
    };
  }

  /**
   * Clean message for optional downstream usage.
   * Currently just trims whitespace so the LLM sees the message exactly as typed.
   * @param message - Original message
   * @returns Cleaned message
   */
  private cleanMessage(message: string): string {
    return message.trim();
  }

  /**
   * Calculate total estimated tokens from all enhancements
   * @returns Total token count
   */
  private calculateTotalTokens(): number {
    let total = 0;

    // Tool schemas (estimated)
    total += this.tools.length * 150; // ~150 tokens per tool schema

    // Prompt content
    total += this.prompts.reduce((sum, prompt) => sum + prompt.tokens, 0);

    // Note content
    total += this.notes.reduce((sum, note) => sum + note.tokens, 0);

    return total;
  }

  // ==========================================================================
  // Query Enhancement State
  // ==========================================================================

  /**
   * Get all current tool hints
   * @returns Array of tool hints
   */
  getTools(): ToolHint[] {
    return [...this.tools];
  }

  /**
   * Get all current prompt references
   * @returns Array of prompt references
   */
  getPrompts(): PromptReference[] {
    return [...this.prompts];
  }

  /**
   * Get all current note references
   * @returns Array of note references
   */
  getNotes(): NoteReference[] {
    return [...this.notes];
  }

  /**
   * Get all current workspace references
   * @returns Array of workspace references
   */
  getWorkspaces(): WorkspaceReference[] {
    return [...this.workspaces];
  }

  /**
   * Get current total token count
   * @returns Estimated token count
   */
  getTotalTokens(): number {
    return this.calculateTotalTokens();
  }

  /**
   * Check if any enhancements have been added
   * @returns True if enhancements exist
   */
  hasEnhancements(): boolean {
    return this.tools.length > 0 || this.prompts.length > 0 || this.notes.length > 0 || this.workspaces.length > 0;
  }

  // ==========================================================================
  // Clear State
  // ==========================================================================

  /**
   * Clear all enhancements
   */
  clearEnhancements(): void {
    this.tools = [];
    this.prompts = [];
    this.notes = [];
    this.workspaces = [];
  }

  /**
   * Remove a specific tool hint
   * @param toolName - Name of tool to remove
   */
  removeTool(toolName: string): void {
    this.tools = this.tools.filter(t => t.name !== toolName);
  }

  /**
   * Remove a specific prompt reference
   * @param promptId - ID of prompt to remove
   */
  removePrompt(promptId: string): void {
    this.prompts = this.prompts.filter(p => p.id !== promptId);
  }

  /**
   * Remove a specific note reference
   * @param notePath - Path of note to remove
   */
  removeNote(notePath: string): void {
    this.notes = this.notes.filter(n => n.path !== notePath);
  }

  /**
   * Remove a specific workspace reference
   * @param workspaceId - ID of workspace to remove
   */
  removeWorkspace(workspaceId: string): void {
    this.workspaces = this.workspaces.filter(w => w.id !== workspaceId);
  }
}
