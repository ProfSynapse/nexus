/**
 * ContextNotesManager - Manages context notes for chat conversations
 *
 * Responsibilities:
 * - Maintain list of note paths to include as context
 * - Add/remove/clear context notes
 * - Validate note paths
 * - Provide note list for system prompt building
 *
 * Follows Single Responsibility Principle - only handles context note management.
 */

export class ContextNotesManager {
  private notes: string[] = [];

  /**
   * Get all context note paths
   */
  getNotes(): string[] {
    return [...this.notes];
  }

  /**
   * Set context notes (replaces existing list)
   */
  setNotes(notes: string[]): void {
    this.notes = [...notes];
  }

  /**
   * Add a note to context
   * @param notePath - Path to the note file
   * @returns true if added, false if already exists
   */
  addNote(notePath: string): boolean {
    if (!this.notes.includes(notePath)) {
      this.notes.push(notePath);
      return true;
    }
    return false;
  }

  /**
   * Remove a note from context by index
   * @param index - Index of the note to remove
   * @returns true if removed, false if index invalid
   */
  removeNote(index: number): boolean {
    if (index >= 0 && index < this.notes.length) {
      this.notes.splice(index, 1);
      return true;
    }
    return false;
  }

  /**
   * Remove a note from context by path
   * @param notePath - Path to the note file
   * @returns true if removed, false if not found
   */
  removeNoteByPath(notePath: string): boolean {
    const index = this.notes.indexOf(notePath);
    if (index !== -1) {
      this.notes.splice(index, 1);
      return true;
    }
    return false;
  }

  /**
   * Clear all context notes
   */
  clear(): void {
    this.notes = [];
  }

  /**
   * Check if a note is already in context
   */
  hasNote(notePath: string): boolean {
    return this.notes.includes(notePath);
  }

  /**
   * Get count of context notes
   */
  count(): number {
    return this.notes.length;
  }
}
