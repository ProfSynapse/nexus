/**
 * MessageBubble - Individual message bubble component
 * Location: /src/ui/chat/components/MessageBubble.ts
 *
 * Renders user/AI messages with copy, retry, and edit actions.
 * Delegates rendering responsibilities to specialized classes following SOLID principles.
 *
 * Used by MessageDisplay to render individual messages in the chat interface.
 * Coordinates with ReferenceBadgeRenderer, ToolBubbleFactory, ToolEventParser,
 * MessageContentRenderer, and MessageEditController for specific concerns.
 */

import { ConversationMessage } from '../../../types/chat/ChatTypes';
import { ProgressiveToolAccordion } from './ProgressiveToolAccordion';
import { MessageBranchNavigator, MessageBranchNavigatorEvents } from './MessageBranchNavigator';
import { setIcon, Component, App } from 'obsidian';

// Extracted classes
import { ReferenceBadgeRenderer } from './renderers/ReferenceBadgeRenderer';
import { ToolBubbleFactory } from './factories/ToolBubbleFactory';
import { ToolEventParser } from '../utils/ToolEventParser';
import { MessageContentRenderer } from './renderers/MessageContentRenderer';
import { MessageEditController } from '../controllers/MessageEditController';

export class MessageBubble extends Component {
  private element: HTMLElement | null = null;
  private loadingInterval: any = null;
  private progressiveToolAccordions: Map<string, ProgressiveToolAccordion> = new Map();
  private messageBranchNavigator: MessageBranchNavigator | null = null;
  private toolBubbleElement: HTMLElement | null = null;
  private textBubbleElement: HTMLElement | null = null;
  private imageBubbleElement: HTMLElement | null = null;

  constructor(
    private message: ConversationMessage,
    private app: App,
    private onCopy: (messageId: string) => void,
    private onRetry: (messageId: string) => void,
    private onEdit?: (messageId: string, newContent: string) => void,
    private onToolEvent?: (messageId: string, event: 'detected' | 'started' | 'completed', data: any) => void,
    private onMessageAlternativeChanged?: (messageId: string, alternativeIndex: number) => void
  ) {
    super();
  }

  /**
   * Create the message bubble element
   * For assistant messages with toolCalls or reasoning, returns a fragment containing tool bubble + text bubble
   */
  createElement(): HTMLElement {
    const activeToolCalls = this.getActiveToolCalls(this.message);
    const hasToolCalls = this.message.role === 'assistant' && activeToolCalls && activeToolCalls.length > 0;
    const activeReasoning = this.getActiveReasoning(this.message);
    const hasReasoning = this.message.role === 'assistant' && activeReasoning;
    const showToolBubble = hasToolCalls || hasReasoning;
    const activeContent = this.getActiveMessageContent(this.message);

    if (showToolBubble) {
      const wrapper = document.createElement('div');
      wrapper.addClass('message-group');
      wrapper.setAttribute('data-message-id', this.message.id);

      // Render using the active alternative's tool calls and reasoning so retries/branches preserve them
      const renderMessage: ConversationMessage = { ...this.message, toolCalls: activeToolCalls, reasoning: activeReasoning };

      // Create tool bubble using factory
      this.toolBubbleElement = ToolBubbleFactory.createToolBubble({
        message: renderMessage,
        parseParameterValue: ToolEventParser.parseParameterValue,
        getToolCallArguments: ToolEventParser.getToolCallArguments,
        progressiveToolAccordions: this.progressiveToolAccordions,
        component: this
      });
      wrapper.appendChild(this.toolBubbleElement);

      // Check for image results in completed tool calls (for loaded messages)
      if (activeToolCalls) {
        for (const toolCall of activeToolCalls) {
          if (toolCall.result && toolCall.success !== false) {
            const imageData = this.extractImageFromResult(toolCall.result);
            if (imageData) {
              this.createImageBubbleStatic(wrapper, imageData);
            }
          }
        }
      }

      // Create text bubble if there's content
      if (activeContent && activeContent.trim()) {
        this.textBubbleElement = ToolBubbleFactory.createTextBubble(
          renderMessage,
          (container, content) => this.renderContent(container, content),
          this.onCopy,
          (button) => this.showCopyFeedback(button),
          this.messageBranchNavigator,
          this.onMessageAlternativeChanged,
          this
        );
        wrapper.appendChild(this.textBubbleElement);

        // Add branch navigator for assistant messages with tool bubbles
        if (renderMessage.alternatives && renderMessage.alternatives.length > 0) {
          const actions = this.textBubbleElement.querySelector('.message-actions-external');
          if (actions instanceof HTMLElement) {
            const navigatorEvents: MessageBranchNavigatorEvents = {
              onAlternativeChanged: (messageId, alternativeIndex) => {
                if (this.onMessageAlternativeChanged) {
                  this.onMessageAlternativeChanged(messageId, alternativeIndex);
                }
              },
              onError: (message) => console.error('[MessageBubble] Branch navigation error:', message)
            };

            this.messageBranchNavigator = new MessageBranchNavigator(actions, navigatorEvents, this);
            this.messageBranchNavigator.updateMessage(renderMessage);
          }
        }
      }

      this.element = wrapper;
      return wrapper;
    }

    // Normal single bubble for user messages or assistant without tools
    const messageContainer = document.createElement('div');
    messageContainer.addClass('message-container');
    messageContainer.addClass(`message-${this.message.role}`);
    messageContainer.setAttribute('data-message-id', this.message.id);

    const bubble = messageContainer.createDiv('message-bubble');

    // Message header with role icon only
    const header = bubble.createDiv('message-header');
    const roleIcon = header.createDiv('message-role-icon');
    if (this.message.role === 'user') {
      setIcon(roleIcon, 'user');
    } else if (this.message.role === 'tool') {
      setIcon(roleIcon, 'wrench');
    } else {
      setIcon(roleIcon, 'bot');
    }

    // Add loading state in header if AI message is loading with empty content
    if (this.message.role === 'assistant' && this.message.isLoading && !this.message.content.trim()) {
      const loadingSpan = header.createEl('span', { cls: 'ai-loading-header' });
      loadingSpan.appendText('Thinking');
      loadingSpan.createEl('span', { cls: 'dots', text: '...' });
      this.startLoadingAnimation(loadingSpan);
    }

    // Create actions in header for user messages (next to icon), elsewhere for others
    // This prevents action buttons from overlapping message content on mobile
    let actions: HTMLElement;
    if (this.message.role === 'user') {
      actions = header.createDiv('message-actions-external');
    } else if (this.message.role === 'assistant') {
      actions = bubble.createDiv('message-actions-external');
    } else {
      actions = messageContainer.createDiv('message-actions-external');
    }

    this.createActionButtons(actions, bubble);

    // Message content
    const content = bubble.createDiv('message-content');
    this.renderContent(content, activeContent).catch(error => {
      console.error('[MessageBubble] Error rendering initial content:', error);
    });

    this.element = messageContainer;
    return messageContainer;
  }

  /**
   * Create action buttons (edit, retry, copy, branch navigator)
   */
  private createActionButtons(actions: HTMLElement, bubble: HTMLElement): void {
    if (this.message.role === 'user') {
      // Edit button for user messages
      if (this.onEdit) {
        const editBtn = actions.createEl('button', {
          cls: 'message-action-btn clickable-icon',
          attr: { title: 'Edit message' }
        });
        setIcon(editBtn, 'edit');
        this.registerDomEvent(editBtn, 'click', () => MessageEditController.handleEdit(this.message, this.element, this.onEdit!, this));
      }

      // Retry button for user messages
      const retryBtn = actions.createEl('button', {
        cls: 'message-action-btn clickable-icon',
        attr: { title: 'Retry message' }
      });
      setIcon(retryBtn, 'rotate-ccw');
      this.registerDomEvent(retryBtn, 'click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (this.onRetry) {
          this.onRetry(this.message.id);
        }
      });
    } else if (this.message.role === 'tool') {
      // Tool messages get minimal actions - just copy for debugging
      const copyBtn = actions.createEl('button', {
        cls: 'message-action-btn clickable-icon',
        attr: { title: 'Copy tool execution details' }
      });
      setIcon(copyBtn, 'copy');
      this.registerDomEvent(copyBtn, 'click', () => {
        this.showCopyFeedback(copyBtn);
        this.onCopy(this.message.id);
      });
    } else {
      // Copy button for AI messages
      const copyBtn = actions.createEl('button', {
        cls: 'message-action-btn clickable-icon',
        attr: { title: 'Copy message' }
      });
      setIcon(copyBtn, 'copy');
      this.registerDomEvent(copyBtn, 'click', () => {
        this.showCopyFeedback(copyBtn);
        this.onCopy(this.message.id);
      });

      // Message branch navigator for AI messages with alternatives
      if (this.message.alternatives && this.message.alternatives.length > 0) {
        const navigatorEvents: MessageBranchNavigatorEvents = {
          onAlternativeChanged: (messageId, alternativeIndex) => {
            if (this.onMessageAlternativeChanged) {
              this.onMessageAlternativeChanged(messageId, alternativeIndex);
            }
          },
          onError: (message) => console.error('[MessageBubble] Branch navigation error:', message)
        };

        this.messageBranchNavigator = new MessageBranchNavigator(actions, navigatorEvents, this);
        this.messageBranchNavigator.updateMessage(this.message);
      }
    }
  }

  /**
   * Render message content using enhanced markdown renderer
   */
  private async renderContent(container: HTMLElement, content: string): Promise<void> {
    // Skip rendering if loading with empty content
    if (this.message.isLoading && this.message.role === 'assistant' && !content.trim()) {
      return;
    }

    const referenceMetadata = ReferenceBadgeRenderer.getReferenceMetadata(this.message.metadata);
    await MessageContentRenderer.renderContent(container, content, this.app, this, referenceMetadata);
  }

  /**
   * Get the DOM element
   */
  getElement(): HTMLElement | null {
    return this.element;
  }

  /**
   * Start loading animation (animated dots)
   */
  private startLoadingAnimation(container: HTMLElement): void {
    const dotsElement = container.querySelector('.dots');
    if (dotsElement) {
      let dotCount = 0;
      this.loadingInterval = setInterval(() => {
        dotCount = (dotCount + 1) % 4;
        dotsElement.textContent = '.'.repeat(dotCount);
      }, 500);
    }
  }

  /**
   * Stop loading animation and remove loading UI
   */
  stopLoadingAnimation(): void {
    if (this.loadingInterval) {
      clearInterval(this.loadingInterval);
      this.loadingInterval = null;
    }

    if (this.element) {
      const loadingElement = this.element.querySelector('.ai-loading-header');
      if (loadingElement) {
        loadingElement.remove();
      }
    }
  }

  /**
   * Update static message content
   */
  updateContent(content: string): void {
    if (!this.element) return;

    const contentElement = this.element.querySelector('.message-content');
    if (!contentElement) return;

    this.stopLoadingAnimation();

    // Preserve progressive accordions during content update
    const progressiveAccordions: HTMLElement[] = [];
    if (this.progressiveToolAccordions.size > 0) {
      const accordionElements = contentElement.querySelectorAll('.progressive-tool-accordion');
      accordionElements.forEach(el => {
        if (el instanceof HTMLElement) {
          progressiveAccordions.push(el);
          el.remove();
        }
      });
    }

    contentElement.empty();

    this.renderContent(contentElement as HTMLElement, content).catch(error => {
      console.error('[MessageBubble] Error rendering content:', error);
      const fallbackDiv = document.createElement('div');
      fallbackDiv.textContent = content;
      contentElement.appendChild(fallbackDiv);
    });

    // Re-append progressive accordions if they were preserved
    if (this.progressiveToolAccordions.size > 0 && progressiveAccordions.length > 0) {
      progressiveAccordions.forEach(accordion => {
        contentElement.appendChild(accordion);
      });
    }
  }

  /**
   * Update MessageBubble with new message data
   */
  updateWithNewMessage(newMessage: ConversationMessage): void {
    // Handle progressive accordion transition to static
    const activeToolCalls = this.getActiveToolCalls(newMessage);
    if (this.progressiveToolAccordions.size > 0 && activeToolCalls) {
      const hasCompletedTools = activeToolCalls.some(tc =>
        tc.result !== undefined || tc.success !== undefined
      );

      if (!hasCompletedTools) {
        this.message = newMessage;
        if (this.messageBranchNavigator) {
          this.messageBranchNavigator.updateMessage(newMessage);
        }
        return;
      }
    }

    this.message = newMessage;

    if (this.messageBranchNavigator) {
      this.messageBranchNavigator.updateMessage(newMessage);
    }

    if (!this.element) return;
    const contentElement = this.element.querySelector('.message-content');
    if (!contentElement) return;

    contentElement.empty();

    const activeContent = this.getActiveMessageContent(newMessage);
    this.renderContent(contentElement as HTMLElement, activeContent).catch(error => {
      console.error('[MessageBubble] Error re-rendering content:', error);
    });

    if (newMessage.isLoading && newMessage.role === 'assistant') {
      const loadingDiv = contentElement.createDiv('ai-loading-continuation');
      const loadingSpan = loadingDiv.createEl('span', { cls: 'ai-loading' });
      loadingSpan.appendText('Thinking');
      loadingSpan.createEl('span', { cls: 'dots', text: '...' });
      this.startLoadingAnimation(loadingDiv);
    }
  }

  /**
   * Handle tool events from MessageManager
   */
  handleToolEvent(event: 'detected' | 'updated' | 'started' | 'completed', data: any): void {
    const info = ToolEventParser.getToolEventInfo(data);
    const toolId = info.toolId;
    if (!toolId) {
      return;
    }

    let accordion = this.progressiveToolAccordions.get(toolId);

    if (!accordion && (event === 'detected' || event === 'started')) {
      accordion = new ProgressiveToolAccordion(this);
      const accordionElement = accordion.createElement();

      if (!this.toolBubbleElement) {
        this.createToolBubbleOnDemand();
      }

      const toolContent = this.toolBubbleElement?.querySelector('.tool-bubble-content');
      if (toolContent) {
        toolContent.appendChild(accordionElement);
      }

      this.progressiveToolAccordions.set(toolId, accordion);
    }

    if (!accordion) {
      return;
    }

    switch (event) {
      case 'detected':
        accordion.detectTool({
          id: toolId,
          name: info.displayName,
          technicalName: info.technicalName,
          parameters: info.parameters,
          isComplete: info.isComplete,
          // Pass reasoning-specific properties
          type: info.type,
          result: info.result,
          status: info.status,
          isVirtual: info.isVirtual
        });
        break;

      case 'updated':
        accordion.updateToolParameters(toolId, info.parameters, info.isComplete);
        break;

      case 'started':
        accordion.startTool({
          id: toolId,
          name: info.displayName,
          technicalName: info.technicalName,
          parameters: info.parameters
        });
        break;

      case 'completed':
        accordion.completeTool(
          toolId,
          data.result,
          data.success,
          data.error
        );

        // Check if this is an image generation result
        if (data.success && data.result) {
          this.checkAndRenderImageResult(data.result);
        }
        break;
    }
  }

  /**
   * Create tool bubble on-demand during streaming
   */
  private createToolBubbleOnDemand(): void {
    if (this.toolBubbleElement) return;

    this.toolBubbleElement = ToolBubbleFactory.createToolBubbleOnDemand(this.message, this.element);
  }

  /**
   * Check if a tool result contains an image path and render it
   */
  private checkAndRenderImageResult(result: any): void {
    const imageData = this.extractImageFromResult(result);
    if (!imageData) return;

    this.createImageBubble(imageData);
  }

  /**
   * Extract image data from a tool result (supports generateImage tool format)
   */
  private extractImageFromResult(result: any): { imagePath: string; prompt?: string; dimensions?: { width: number; height: number }; model?: string } | null {
    if (!result) return null;

    // Handle both direct result and nested data structure
    const data = result.data || result;

    // Check for imagePath which indicates an image generation result
    if (data && typeof data.imagePath === 'string') {
      return {
        imagePath: data.imagePath,
        prompt: data.prompt || data.revisedPrompt,
        dimensions: data.dimensions,
        model: data.model
      };
    }

    return null;
  }

  /**
   * Create an image bubble to display generated images prominently in the chat
   */
  private createImageBubble(imageData: { imagePath: string; prompt?: string; dimensions?: { width: number; height: number }; model?: string }): void {
    if (!this.element) return;

    const imageBubble = this.buildImageBubbleElement(imageData);

    // Insert image bubble after tool bubble, before text bubble
    if (this.toolBubbleElement && this.textBubbleElement) {
      this.element.insertBefore(imageBubble, this.textBubbleElement);
    } else if (this.toolBubbleElement) {
      this.element.appendChild(imageBubble);
    } else {
      // No tool bubble, append to wrapper
      this.element.appendChild(imageBubble);
    }

    this.imageBubbleElement = imageBubble;
  }

  /**
   * Create an image bubble for static content (during createElement)
   */
  private createImageBubbleStatic(parent: HTMLElement, imageData: { imagePath: string; prompt?: string; dimensions?: { width: number; height: number }; model?: string }): void {
    const imageBubble = this.buildImageBubbleElement(imageData);
    parent.appendChild(imageBubble);
    this.imageBubbleElement = imageBubble;
  }

  /**
   * Build the image bubble element
   */
  private buildImageBubbleElement(imageData: { imagePath: string; prompt?: string; dimensions?: { width: number; height: number }; model?: string }): HTMLElement {
    // Create image bubble container
    const imageBubble = document.createElement('div');
    imageBubble.addClass('message-container');
    imageBubble.addClass('message-image');
    imageBubble.setAttribute('data-message-id', `${this.message.id}_image`);

    const bubble = imageBubble.createDiv('message-bubble image-bubble');

    // Image container
    const imageContainer = bubble.createDiv('generated-image-container');

    // Create image element
    const img = imageContainer.createEl('img', { cls: 'generated-image' });

    // Get the resource path using Obsidian's vault adapter
    const resourcePath = this.app.vault.adapter.getResourcePath(imageData.imagePath);
    img.src = resourcePath;
    img.alt = imageData.prompt || 'Generated image';
    img.setAttribute('loading', 'lazy');

    // Open in Obsidian button
    const openButton = bubble.createEl('button', { cls: 'generated-image-open-btn' });
    setIcon(openButton, 'external-link');
    openButton.createSpan({ text: 'Open in Obsidian' });
    this.registerDomEvent(openButton, 'click', () => {
      this.app.workspace.openLinkText(imageData.imagePath, '', false);
    });

    return imageBubble;
  }

  /**
   * Get progressive tool accordions for external updates
   */
  getProgressiveToolAccordions(): Map<string, ProgressiveToolAccordion> {
    return this.progressiveToolAccordions;
  }

  /**
   * Get the active content for the message (original or alternative)
   */
  private getActiveMessageContent(message: ConversationMessage): string {
    const activeIndex = message.activeAlternativeIndex || 0;

    if (activeIndex === 0) {
      return message.content;
    }

    if (message.alternatives && message.alternatives.length > 0) {
      const alternativeIndex = activeIndex - 1;
      if (alternativeIndex >= 0 && alternativeIndex < message.alternatives.length) {
        return message.alternatives[alternativeIndex].content;
      }
    }

    return message.content;
  }

  /**
   * Get the active tool calls for the message (original or alternative)
   */
  private getActiveToolCalls(message: ConversationMessage): any[] | undefined {
    const activeIndex = message.activeAlternativeIndex || 0;

    if (activeIndex === 0) {
      return message.toolCalls;
    }

    if (message.alternatives && message.alternatives.length > 0) {
      const alternativeIndex = activeIndex - 1;
      if (alternativeIndex >= 0 && alternativeIndex < message.alternatives.length) {
        return message.alternatives[alternativeIndex].toolCalls;
      }
    }

    return message.toolCalls;
  }

  /**
   * Get the active reasoning for the message (original or alternative)
   */
  private getActiveReasoning(message: ConversationMessage): string | undefined {
    const activeIndex = message.activeAlternativeIndex || 0;

    if (activeIndex === 0) {
      return message.reasoning;
    }

    if (message.alternatives && message.alternatives.length > 0) {
      const alternativeIndex = activeIndex - 1;
      if (alternativeIndex >= 0 && alternativeIndex < message.alternatives.length) {
        return message.alternatives[alternativeIndex].reasoning;
      }
    }

    return message.reasoning;
  }

  /**
   * Show visual feedback when copy button is clicked
   */
  private showCopyFeedback(button: HTMLElement): void {
    const originalTitle = button.getAttribute('title') || '';
    setIcon(button, 'check');
    button.setAttribute('title', 'Copied!');
    button.classList.add('copy-success');

    setTimeout(() => {
      setIcon(button, 'copy');
      button.setAttribute('title', originalTitle);
      button.classList.remove('copy-success');
    }, 1500);
  }

  /**
   * Clean up progressive tool accordions
   */
  private cleanupProgressiveAccordions(): void {
    this.progressiveToolAccordions.forEach(accordion => {
      const element = accordion.getElement();
      if (element) {
        element.remove();
      }
      accordion.cleanup();
    });

    this.progressiveToolAccordions.clear();
  }

  /**
   * Cleanup resources
   */
  cleanup(): void {
    this.stopLoadingAnimation();
    this.cleanupProgressiveAccordions();

    if (this.messageBranchNavigator) {
      this.messageBranchNavigator.destroy();
      this.messageBranchNavigator = null;
    }

    this.element = null;
  }
}
