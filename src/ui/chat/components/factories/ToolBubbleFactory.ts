/**
 * ToolBubbleFactory - Factory for creating tool and text bubble elements
 * Location: /src/ui/chat/components/factories/ToolBubbleFactory.ts
 *
 * This class is responsible for:
 * - Creating tool bubbles containing progressive tool accordions
 * - Creating text bubbles for assistant responses
 * - Creating tool bubbles on-demand during streaming
 *
 * Used by MessageBubble to separate tool execution UI from text responses,
 * following the Factory pattern for consistent bubble creation.
 */

import { setIcon, Component } from 'obsidian';
import { ConversationMessage } from '../../../../types/chat/ChatTypes';
import { ProgressiveToolAccordion } from '../ProgressiveToolAccordion';
import { normalizeToolCallsForDisplay } from '../../utils/toolDisplayNormalizer';

export interface ToolBubbleFactoryOptions {
  message: ConversationMessage;
  progressiveToolAccordions: Map<string, ProgressiveToolAccordion>;
  component?: Component;
}

export class ToolBubbleFactory {
  /**
   * Create tool bubble containing multiple tool accordions
   */
  static createToolBubble(options: ToolBubbleFactoryOptions): HTMLElement {
    const { message, progressiveToolAccordions, component } = options;

    const toolContainer = document.createElement('div');
    toolContainer.addClass('message-container');
    toolContainer.addClass('message-tool');
    toolContainer.setAttribute('data-message-id', `${message.id}_tools`);

    const bubble = toolContainer.createDiv('message-bubble tool-bubble');

    // Header with wrench icon
    const header = bubble.createDiv('message-header');
    const roleIcon = header.createDiv('message-role-icon');
    setIcon(roleIcon, 'wrench');

    // Content area for tool accordions
    const content = bubble.createDiv('tool-bubble-content');

    // Create reasoning accordion if message has persisted reasoning
    if (message.reasoning) {
      const reasoningAccordion = new ProgressiveToolAccordion(component);
      const reasoningEl = reasoningAccordion.createElement();

      // Create synthetic reasoning tool call for display
      const reasoningId = `reasoning_${message.id}`;
      reasoningAccordion.detectTool({
        id: reasoningId,
        name: 'Reasoning',
        technicalName: 'extended_thinking',
        type: 'reasoning',
        result: message.reasoning,
        status: 'completed',
        isVirtual: true,
        isComplete: true
      });

      content.appendChild(reasoningEl);
      progressiveToolAccordions.set(reasoningId, reasoningAccordion);
    }

    // Create one ProgressiveToolAccordion per outer tool call
    if (message.toolCalls) {
      const displayGroups = normalizeToolCallsForDisplay(message.toolCalls);

      displayGroups.forEach(group => {
        const accordion = new ProgressiveToolAccordion(component);
        const accordionEl = accordion.createElement();

        accordion.setDisplayGroup(group);

        content.appendChild(accordionEl);
        progressiveToolAccordions.set(group.id, accordion);
      });
    }

    return toolContainer;
  }

  /**
   * Create text bubble containing only the assistant response text
   */
  static createTextBubble(
    message: ConversationMessage,
    renderContentCallback: (content: HTMLElement, text: string) => Promise<void>,
    messageBranchNavigator: any | null
  ): HTMLElement {
    const messageContainer = document.createElement('div');
    messageContainer.addClass('message-container');
    messageContainer.addClass('message-assistant');
    messageContainer.setAttribute('data-message-id', `${message.id}_text`);

    const bubble = messageContainer.createDiv('message-bubble');

    // Header with bot icon; actions pill sits in the header top-right
    const header = bubble.createDiv('message-header');
    const roleIcon = header.createDiv('message-role-icon');
    setIcon(roleIcon, 'bot');
    header.createDiv('message-actions-external');

    // Message content
    const content = bubble.createDiv('message-content');

    // Render content with enhanced markdown support
    const activeContent = ToolBubbleFactory.getActiveMessageContent(message);
    renderContentCallback(content, activeContent).catch(error => {
      console.error('[ToolBubbleFactory] Error rendering text bubble content:', error);
    });

    // Message branch navigator for messages with branches
    if (message.branches && message.branches.length > 0 && messageBranchNavigator) {
      messageBranchNavigator.updateMessage(message);
    }

    return messageContainer;
  }

  /**
   * Create tool bubble on-demand during streaming (when first tool is detected)
   */
  static createToolBubbleOnDemand(message: ConversationMessage, parentElement: HTMLElement | null): HTMLElement {
    const toolContainer = document.createElement('div');
    toolContainer.addClass('message-container');
    toolContainer.addClass('message-tool');
    toolContainer.setAttribute('data-message-id', `${message.id}_tools`);

    const bubble = toolContainer.createDiv('message-bubble tool-bubble');

    // Header with wrench icon
    const header = bubble.createDiv('message-header');
    const roleIcon = header.createDiv('message-role-icon');
    setIcon(roleIcon, 'wrench');

    // Content area for tool accordions
    bubble.createDiv('tool-bubble-content');

    // Insert before the main message bubble (or at the beginning if no main bubble yet)
    if (parentElement) {
      parentElement.insertBefore(toolContainer, parentElement.firstChild);
    }

    return toolContainer;
  }

  /**
   * Get the active content for the message (original or from branch)
   */
  private static getActiveMessageContent(message: ConversationMessage): string {
    const activeIndex = message.activeAlternativeIndex || 0;

    // Index 0 is the original message
    if (activeIndex === 0) {
      return message.content;
    }

    // Branch messages start at index 1
    if (message.branches && message.branches.length > 0) {
      const branchIndex = activeIndex - 1;
      if (branchIndex >= 0 && branchIndex < message.branches.length) {
        const branch = message.branches[branchIndex];
        if (branch.messages.length > 0) {
          return branch.messages[branch.messages.length - 1].content;
        }
      }
    }

    // Fallback to original content
    return message.content;
  }

}
