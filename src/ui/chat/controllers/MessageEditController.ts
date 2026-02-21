/**
 * MessageEditController - Manages message edit mode functionality
 * Location: /src/ui/chat/controllers/MessageEditController.ts
 *
 * This class is responsible for:
 * - Entering edit mode with textarea interface
 * - Managing edit controls (save/cancel)
 * - Handling keyboard shortcuts (ESC to cancel)
 * - Exiting edit mode and restoring original content
 *
 * Used by MessageBubble to enable editing of user messages,
 * following the Controller pattern for state management.
 */

import { ConversationMessage } from '../../../types/chat/ChatTypes';
import { Component } from 'obsidian';

export class MessageEditController {
  /**
   * Enter edit mode for a message
   */
  static handleEdit(
    message: ConversationMessage,
    element: HTMLElement | null,
    onEdit: (messageId: string, newContent: string) => void,
    component?: Component
  ): void {
    if (!element) return;

    const contentDiv = element.querySelector('.message-bubble .message-content');
    if (!contentDiv) return;

    // Create textarea for editing
    const textarea = document.createElement('textarea');
    textarea.className = 'message-edit-textarea';
    textarea.value = message.content;

    // Create edit controls
    const editControls = document.createElement('div');
    editControls.className = 'message-edit-controls';

    const saveBtn = editControls.createEl('button', {
      text: 'Save',
      cls: 'message-edit-save'
    });

    const cancelBtn = editControls.createEl('button', {
      text: 'Cancel',
      cls: 'message-edit-cancel'
    });

    // Store original content as cloned DOM nodes (avoids innerHTML XSS risk)
    const originalNodes = document.createDocumentFragment();
    Array.from(contentDiv.childNodes).forEach(node => {
      originalNodes.appendChild(node.cloneNode(true));
    });

    // Replace content with edit interface
    contentDiv.empty();
    contentDiv.appendChild(textarea);
    contentDiv.appendChild(editControls);

    // Focus textarea
    textarea.focus();

    // Save handler
    const saveHandler = () => {
      const newContent = textarea.value.trim();
      if (newContent && newContent !== message.content) {
        onEdit(message.id, newContent);
      }
      MessageEditController.exitEditMode(contentDiv, originalNodes);
    };

    // Cancel handler
    const cancelHandler = () => {
      MessageEditController.exitEditMode(contentDiv, originalNodes);
    };

    // ESC key handler
    const keydownHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        MessageEditController.exitEditMode(contentDiv, originalNodes);
      }
    };

    component!.registerDomEvent(saveBtn, 'click', saveHandler);
    component!.registerDomEvent(cancelBtn, 'click', cancelHandler);
    component!.registerDomEvent(textarea, 'keydown', keydownHandler);
  }

  /**
   * Exit edit mode and restore original content
   */
  static exitEditMode(contentDiv: Element, originalNodes: DocumentFragment): void {
    contentDiv.empty();
    contentDiv.appendChild(originalNodes.cloneNode(true));
  }
}
