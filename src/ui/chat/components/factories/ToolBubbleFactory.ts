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
import { formatToolDisplayName, normalizeToolName } from '../../../../utils/toolNameUtils';

export interface ToolBubbleFactoryOptions {
  message: ConversationMessage;
  parseParameterValue: (value: any) => any;
  getToolCallArguments: (toolCall: any) => any;
  progressiveToolAccordions: Map<string, ProgressiveToolAccordion>;
  component?: Component;
}

export class ToolBubbleFactory {
  /**
   * Create tool bubble containing multiple tool accordions
   */
  static createToolBubble(options: ToolBubbleFactoryOptions): HTMLElement {
    const { message, parseParameterValue, getToolCallArguments, progressiveToolAccordions, component } = options;

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

    // Create one ProgressiveToolAccordion per tool (unwrapping useTool calls)
    if (message.toolCalls) {
      message.toolCalls.forEach(toolCall => {
        // Unwrap useTool calls to show inner tools
        const unwrappedTools = ToolBubbleFactory.unwrapUseTool(toolCall, parseParameterValue, getToolCallArguments);

        unwrappedTools.forEach(unwrapped => {
          const accordion = new ProgressiveToolAccordion(component);
          const accordionEl = accordion.createElement();

          accordion.detectTool({
            id: unwrapped.id,
            name: unwrapped.displayName,
            technicalName: unwrapped.technicalName,
            parameters: unwrapped.parameters,
            isComplete: true
          });

          // If tool has results, mark as completed
          if (unwrapped.result !== undefined || unwrapped.success !== undefined) {
            accordion.completeTool(
              unwrapped.id,
              unwrapped.result,
              unwrapped.success !== false,
              unwrapped.error
            );
          }

          content.appendChild(accordionEl);
          progressiveToolAccordions.set(unwrapped.id, accordion);
        });
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
    onCopy: (messageId: string) => void,
    showCopyFeedback: (button: HTMLElement) => void,
    messageBranchNavigator: any | null,
    onMessageAlternativeChanged?: (messageId: string, alternativeIndex: number) => void,
    component?: Component
  ): HTMLElement {
    const messageContainer = document.createElement('div');
    messageContainer.addClass('message-container');
    messageContainer.addClass('message-assistant');
    messageContainer.setAttribute('data-message-id', `${message.id}_text`);

    const bubble = messageContainer.createDiv('message-bubble');

    // Actions inside the bubble (for sticky positioning)
    const actions = bubble.createDiv('message-actions-external');

    // Header with bot icon
    const header = bubble.createDiv('message-header');
    const roleIcon = header.createDiv('message-role-icon');
    setIcon(roleIcon, 'bot');

    // Message content
    const content = bubble.createDiv('message-content');

    // Render content with enhanced markdown support
    const activeContent = ToolBubbleFactory.getActiveMessageContent(message);
    renderContentCallback(content, activeContent).catch(error => {
      console.error('[ToolBubbleFactory] Error rendering text bubble content:', error);
    });

    // Copy button
    const copyBtn = actions.createEl('button', {
      cls: 'message-action-btn clickable-icon',
      attr: { title: 'Copy message' }
    });
    setIcon(copyBtn, 'copy');
    const copyHandler = () => {
      showCopyFeedback(copyBtn);
      onCopy(message.id);
    };
    component!.registerDomEvent(copyBtn, 'click', copyHandler);

    // Message branch navigator for messages with branches
    if (message.branches && message.branches.length > 0 && messageBranchNavigator) {
      const navigatorEvents = {
        onAlternativeChanged: (messageId: string, alternativeIndex: number) => {
          if (onMessageAlternativeChanged) {
            onMessageAlternativeChanged(messageId, alternativeIndex);
          }
        },
        onError: (errorMessage: string) => console.error('[ToolBubbleFactory] Branch navigation error:', errorMessage)
      };

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

  /**
   * Unwrap toolManager_useTool calls to show inner tools
   * Returns an array of unwrapped tool info for display
   */
  private static unwrapUseTool(
    toolCall: any,
    parseParameterValue: (value: any) => any,
    getToolCallArguments: (toolCall: any) => any
  ): Array<{
    id: string;
    displayName: string;
    technicalName: string;
    parameters: any;
    result?: any;
    success?: boolean;
    error?: string;
  }> {
    const rawName = toolCall.technicalName || toolCall.name || toolCall.function?.name || 'Unknown Tool';

    // Check if this is a useTool wrapper call
    const isUseTool = rawName === 'toolManager_useTool' ||
                      rawName === 'toolManager.useTool' ||
                      rawName.endsWith('_useTool') ||
                      rawName.endsWith('.useTool');

    if (!isUseTool) {
      // Not a useTool call - return as-is
      const displayName = toolCall.displayName || formatToolDisplayName(rawName);
      const technicalName = toolCall.technicalName || normalizeToolName(rawName) || rawName;
      const fallbackArguments = getToolCallArguments(toolCall);
      const parameters = parseParameterValue(
        toolCall.parameters !== undefined ? toolCall.parameters : fallbackArguments
      );

      return [{
        id: toolCall.id,
        displayName,
        technicalName,
        parameters,
        result: toolCall.result,
        success: toolCall.success,
        error: toolCall.error
      }];
    }

    // Unwrap useTool - extract inner calls
    const fallbackArguments = getToolCallArguments(toolCall);
    const useToolParams = parseParameterValue(
      toolCall.parameters !== undefined ? toolCall.parameters : fallbackArguments
    );

    // Debug: Log what we're getting
    console.log('[ToolBubbleFactory] unwrapUseTool - toolCall.parameters:', JSON.stringify(toolCall.parameters)?.substring(0, 500));
    console.log('[ToolBubbleFactory] unwrapUseTool - fallbackArguments:', JSON.stringify(fallbackArguments)?.substring(0, 500));
    console.log('[ToolBubbleFactory] unwrapUseTool - useToolParams:', JSON.stringify(useToolParams)?.substring(0, 500));

    // useTool format: { context: {...}, calls: [{ agent, tool, params }] }
    const calls = useToolParams?.calls || [];

    // useTool result format: { success, results: [{ success, data?, error? }] }
    const useToolResult = toolCall.result as {
      success?: boolean;
      results?: Array<{ success?: boolean; data?: any; error?: string }>;
    } | undefined;
    const results = useToolResult?.results || [];

    if (calls.length === 0) {
      // No inner calls - show the wrapper itself
      return [{
        id: toolCall.id,
        displayName: 'useTool (empty)',
        technicalName: rawName,
        parameters: useToolParams,
        result: toolCall.result,
        success: toolCall.success,
        error: toolCall.error
      }];
    }

    // Create an unwrapped entry for each inner call
    return calls.map((call: { agent?: string; tool?: string; params?: any }, index: number) => {
      const innerToolName = call.tool || 'unknown';
      const innerAgentName = call.agent || 'unknown';
      const fullName = `${innerAgentName}.${innerToolName}`;
      const innerResult = results[index];

      return {
        id: `${toolCall.id}_${index}`,
        displayName: formatToolDisplayName(fullName),
        technicalName: fullName,
        parameters: call.params || {},
        result: innerResult?.data,
        success: innerResult?.success,
        error: innerResult?.error
      };
    });
  }
}
