import { ConversationMessage } from '../../../types/chat/ChatTypes';
import { Component, setIcon } from 'obsidian';

export class MessageEditController {
  static handleEdit(
    message: ConversationMessage,
    element: HTMLElement | null,
    onEdit: (messageId: string, newContent: string) => void,
    onRetry: (messageId: string) => void,
    component?: Component
  ): void {
    if (!element) return;

    const contentDiv = element.querySelector('.message-bubble .message-content');
    if (!contentDiv) return;

    if (!component) {
      throw new Error('MessageEditController requires a component to register DOM events');
    }

    // Find the sibling actions container
    const actionsContainerEl = element.querySelector('.message-actions-external');
    const actionsContainer = actionsContainerEl instanceof HTMLElement ? actionsContainerEl : null;

    // Hide existing action buttons and track them for restore
    const originalChildren: HTMLElement[] = [];
    if (actionsContainer) {
      Array.from(actionsContainer.children).forEach(child => {
        if (child instanceof HTMLElement) {
          child.addClass('is-hidden');
          originalChildren.push(child);
        }
      });
    }

    // Append ✕ (cancel) and ✓ (confirm) buttons into the actions container
    const cancelBtn = actionsContainer
      ? actionsContainer.createEl('button', {
          cls: 'message-action-btn clickable-icon message-edit-cancel-btn',
          attr: { title: 'Cancel edit', 'aria-label': 'Cancel edit' }
        })
      : null;
    if (cancelBtn) setIcon(cancelBtn, 'x');

    const confirmBtn = actionsContainer
      ? actionsContainer.createEl('button', {
          cls: 'message-action-btn clickable-icon message-edit-confirm',
          attr: { title: 'Save and retry', 'aria-label': 'Save and retry' }
        })
      : null;
    if (confirmBtn) setIcon(confirmBtn, 'check');

    // Create textarea for editing
    const textarea = document.createElement('textarea');
    textarea.className = 'message-edit-textarea';
    textarea.value = message.content;

    // Clone original DOM for cancel restore
    const originalClone = contentDiv.cloneNode(true) as Element;

    contentDiv.empty();
    contentDiv.appendChild(textarea);
    textarea.focus();

    const exitEditMode = () => {
      originalChildren.forEach(el => { el.removeClass('is-hidden'); });
      cancelBtn?.remove();
      confirmBtn?.remove();
      MessageEditController.exitEditMode(contentDiv, originalClone);
    };

    const confirmHandler = () => {
      const newContent = textarea.value.trim();
      if (newContent && newContent !== message.content) {
        onEdit(message.id, newContent);
      }
      exitEditMode();
      onRetry(message.id);
    };

    const cancelHandler = () => {
      exitEditMode();
    };

    const keydownHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        exitEditMode();
      } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        confirmHandler();
      }
    };

    if (confirmBtn) component.registerDomEvent(confirmBtn, 'click', confirmHandler);
    if (cancelBtn) component.registerDomEvent(cancelBtn, 'click', cancelHandler);
    component.registerDomEvent(textarea, 'keydown', keydownHandler);
  }

  static exitEditMode(contentDiv: Element, originalClone: Element): void {
    contentDiv.replaceChildren(...Array.from(originalClone.childNodes).map(n => n.cloneNode(true)));
  }
}
