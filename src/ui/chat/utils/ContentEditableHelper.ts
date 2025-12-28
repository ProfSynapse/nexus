/**
 * ContentEditableHelper - Utility functions for contenteditable operations
 *
 * Provides DOM manipulation and cursor management for contenteditable elements
 */

export class ContentEditableHelper {
  /**
   * Get current cursor position as offset from start
   */
  static getCursorPosition(element: HTMLElement): number {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return 0;

    const range = selection.getRangeAt(0);
    const preCaretRange = range.cloneRange();
    preCaretRange.selectNodeContents(element);
    preCaretRange.setEnd(range.endContainer, range.endOffset);

    return preCaretRange.toString().length;
  }

  /**
   * Set cursor position by offset from start
   */
  static setCursorPosition(element: HTMLElement, offset: number): void {
    const selection = window.getSelection();
    if (!selection) return;

    const range = this.createRangeAtOffset(element, offset);
    if (range) {
      selection.removeAllRanges();
      selection.addRange(range);
    }
  }

  /**
   * Create a Range at a specific text offset
   */
  private static createRangeAtOffset(element: HTMLElement, offset: number): Range | null {
    const range = document.createRange();
    let currentOffset = 0;

    const traverse = (node: Node): boolean => {
      if (node.nodeType === Node.TEXT_NODE) {
        const textLength = node.textContent?.length || 0;
        if (currentOffset + textLength >= offset) {
          range.setStart(node, offset - currentOffset);
          range.setEnd(node, offset - currentOffset);
          return true;
        }
        currentOffset += textLength;
      } else {
        for (const child of Array.from(node.childNodes)) {
          if (traverse(child)) return true;
        }
      }
      return false;
    };

    if (traverse(element)) {
      return range;
    }

    // If offset is beyond content, place at end
    range.selectNodeContents(element);
    range.collapse(false);
    return range;
  }

  /**
   * Get text before cursor on current line
   */
  static getTextBeforeCursor(element: HTMLElement): string {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return '';

    const range = selection.getRangeAt(0);
    const preCaretRange = range.cloneRange();
    preCaretRange.selectNodeContents(element);
    preCaretRange.setEnd(range.endContainer, range.endOffset);

    return preCaretRange.toString();
  }

  /**
   * Insert a styled reference node at cursor position
   */
  static insertReferenceNode(
    element: HTMLElement,
    type: 'tool' | 'prompt' | 'note' | 'workspace',
    displayText: string,
    technicalName: string
  ): void {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return;

    const range = selection.getRangeAt(0);

    // Create reference span
    const refSpan = document.createElement('span');
    refSpan.className = `chat-reference chat-reference-${type}`;
    refSpan.contentEditable = 'false';
    refSpan.setAttribute('data-type', type);
    refSpan.setAttribute('data-name', technicalName);
    refSpan.textContent = displayText;

    // Add space after reference
    const space = document.createTextNode(' ');

    // Insert nodes
    range.deleteContents();
    range.insertNode(space);
    range.insertNode(refSpan);

    // Move cursor after space
    range.setStartAfter(space);
    range.setEndAfter(space);
    selection.removeAllRanges();
    selection.addRange(range);

    // Trigger input event
    element.dispatchEvent(new Event('input', { bubbles: true }));
  }

  /**
   * Delete text at cursor position
   */
  static deleteTextAtCursor(element: HTMLElement, startOffset: number, endOffset: number): void {
    const range = this.createRangeAtOffset(element, startOffset);
    if (!range) return;

    const endRange = this.createRangeAtOffset(element, endOffset);
    if (!endRange) return;

    range.setEnd(endRange.endContainer, endRange.endOffset);
    range.deleteContents();

    // Update selection
    const selection = window.getSelection();
    if (selection) {
      selection.removeAllRanges();
      selection.addRange(range);
    }

    element.dispatchEvent(new Event('input', { bubbles: true }));
  }

  /**
   * Get plain text content from contenteditable element
   */
  static getPlainText(element: HTMLElement): string {
    return element.textContent || '';
  }

  /**
   * Set plain text content (replaces all content)
   */
  static setPlainText(element: HTMLElement, text: string): void {
    element.textContent = text;
  }

  /**
   * Clear all content
   */
  static clear(element: HTMLElement): void {
    element.innerHTML = '';
  }

  /**
   * Focus the contenteditable element
   */
  static focus(element: HTMLElement): void {
    element.focus();

    // Place cursor at end
    const selection = window.getSelection();
    if (selection) {
      const range = document.createRange();
      range.selectNodeContents(element);
      range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);
    }
  }

  /**
   * Check if element is empty (no text content)
   */
  static isEmpty(element: HTMLElement): boolean {
    return !element.textContent?.trim();
  }

  /**
   * Insert text at cursor position
   */
  static insertTextAtCursor(element: HTMLElement, text: string): void {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return;

    const range = selection.getRangeAt(0);
    const textNode = document.createTextNode(text);

    range.deleteContents();
    range.insertNode(textNode);

    // Move cursor after inserted text
    range.setStartAfter(textNode);
    range.setEndAfter(textNode);
    selection.removeAllRanges();
    selection.addRange(range);

    element.dispatchEvent(new Event('input', { bubbles: true }));
  }
}
