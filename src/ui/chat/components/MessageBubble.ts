/**
 * MessageBubble - Individual message bubble component
 * Location: /src/ui/chat/components/MessageBubble.ts
 *
 * Renders user/AI messages with retry, edit, and action bar actions.
 * Delegates rendering responsibilities to specialized classes following SOLID principles.
 *
 * Used by MessageDisplay to render individual messages in the chat interface.
 * Coordinates with ReferenceBadgeRenderer, ToolBubbleFactory, ToolEventParser,
 * MessageContentRenderer, and MessageEditController for specific concerns.
 */

import { ConversationMessage } from '../../../types/chat/ChatTypes';
import { ProgressiveToolAccordion } from './ProgressiveToolAccordion';
import { MessageBranchNavigator, MessageBranchNavigatorEvents } from './MessageBranchNavigator';
import { MessageActionBar } from './MessageActionBar';
import { setIcon, Component, App } from 'obsidian';

// Extracted classes
import { ReferenceBadgeRenderer } from './renderers/ReferenceBadgeRenderer';
import { ToolBubbleFactory } from './factories/ToolBubbleFactory';
import { ToolEventParser } from '../utils/ToolEventParser';
import { normalizeToolCallForDisplay } from '../utils/toolDisplayNormalizer';
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
  private actionBar: MessageActionBar | null = null;

  constructor(
    private message: ConversationMessage,
    private app: App,
    private onCopy: (messageId: string) => void,
    private onRetry: (messageId: string) => void,
    private onEdit?: (messageId: string, newContent: string) => void,
    private onToolEvent?: (messageId: string, event: 'detected' | 'started' | 'completed', data: any) => void,
    private onMessageAlternativeChanged?: (messageId: string, alternativeIndex: number) => void,
    private onViewBranch?: (branchId: string) => void
  ) {
    super();
  }

  /**
   * Create the message bubble element
   * For assistant messages with toolCalls or reasoning, returns a fragment containing tool bubble + text bubble
   */
  createElement(): HTMLElement {
    const activeToolCalls = this.getActiveToolCalls(this.message);
    const activeReasoning = this.getActiveReasoning(this.message);
    const showToolBubble = this.getRenderMode(this.message) === 'group';
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
        progressiveToolAccordions: this.progressiveToolAccordions,
        component: this
      });
      wrapper.appendChild(this.toolBubbleElement);

      // Wire up onViewBranch callback to all accordions
      if (this.onViewBranch) {
        this.progressiveToolAccordions.forEach(accordion => {
          accordion.setCallbacks({ onViewBranch: this.onViewBranch });
        });
      }

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

      // Create text bubble if there's content OR if streaming (need element for StreamingController)
      if (this.shouldRenderTextBubble(this.message)) {
        this.textBubbleElement = ToolBubbleFactory.createTextBubble(
          renderMessage,
          (container, content) => this.renderContent(container, content),
          this.messageBranchNavigator
        );
        wrapper.appendChild(this.textBubbleElement);

        // Add branch navigator for assistant messages with branches
        if (renderMessage.branches && renderMessage.branches.length > 0) {
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

        const contentElement = this.textBubbleElement.querySelector('.message-content');
        if (contentElement instanceof HTMLElement && this.message.isLoading && !activeContent.trim()) {
          this.appendLoadingIndicator(contentElement);
        }
      }

      this.element = wrapper;
      this.appendActionBar(wrapper, this.message);
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
    this.appendActionBar(messageContainer, this.message);
    return messageContainer;
  }

  /**
   * Create action buttons (edit, retry, branch navigator)
   */
  private createActionButtons(actions: HTMLElement, _bubble: HTMLElement): void {
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
      // Message branch navigator for AI messages with branches
      if (this.message.branches && this.message.branches.length > 0) {
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
    const previousRenderMode = this.getRenderMode(this.message);
    const nextRenderMode = this.getRenderMode(newMessage);
    const previousHadTextBubble = this.shouldRenderTextBubble(this.message);
    const nextNeedsTextBubble = this.shouldRenderTextBubble(newMessage);

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

    if (previousRenderMode !== nextRenderMode || previousHadTextBubble !== nextNeedsTextBubble) {
      this.message = newMessage;
      this.rebuildElement();
      return;
    }

    this.message = newMessage;

    // Clear tool accordions and tool bubble when new message has no tool calls (e.g., retry clear)
    if (!activeToolCalls || activeToolCalls.length === 0) {
      this.cleanupProgressiveAccordions();

      if (this.toolBubbleElement) {
        this.toolBubbleElement.remove();
        this.toolBubbleElement = null;
      }

      if (this.imageBubbleElement) {
        this.imageBubbleElement.remove();
        this.imageBubbleElement = null;
      }
    }

    if (this.messageBranchNavigator) {
      this.messageBranchNavigator.updateMessage(newMessage);
    } else if (newMessage.branches && newMessage.branches.length > 0 && this.element) {
      // Branch navigator doesn't exist yet but message now has branches (e.g. after retry).
      // Create the navigator dynamically so the user can switch between alternatives.
      const actions = this.element.querySelector('.message-actions-external');
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
        this.messageBranchNavigator.updateMessage(newMessage);
      }
    }

    if (!this.element) return;
    const contentElement = this.element.querySelector('.message-content');
    if (!(contentElement instanceof HTMLElement)) {
      this.rebuildElement();
      return;
    }

    contentElement.empty();

    const activeContent = this.getActiveMessageContent(newMessage);
    this.renderContent(contentElement as HTMLElement, activeContent).catch(error => {
      console.error('[MessageBubble] Error re-rendering content:', error);
    });

    if (newMessage.isLoading && newMessage.role === 'assistant') {
      this.appendLoadingIndicator(contentElement);
    } else if (this.element) {
      this.appendActionBar(this.element, newMessage);
    }
  }

  /**
   * Handle tool events from MessageManager
   */
  handleToolEvent(event: 'detected' | 'updated' | 'started' | 'completed', data: any): void {
    const info = ToolEventParser.getToolEventInfo(data, event);
    const toolId = info.toolId || info.batchId || info.parentToolCallId || info.stepId;
    if (!toolId) {
      return;
    }

    let accordion = this.progressiveToolAccordions.get(toolId);

    if (!accordion && (event === 'detected' || event === 'started' || event === 'completed')) {
      accordion = new ProgressiveToolAccordion(this);
      const accordionElement = accordion.createElement();

      // Wire up onViewBranch callback for subagent navigation
      if (this.onViewBranch) {
        accordion.setCallbacks({ onViewBranch: this.onViewBranch });
      }

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

    const hasToolMetadata =
      Boolean(data?.toolCall) ||
      Boolean(data?.name) ||
      Boolean(data?.technicalName) ||
      Boolean(data?.displayName);

    const isLiveBatchStep = Boolean(info.isBatchStepEvent);

    if (event === 'completed' && !hasToolMetadata) {
      accordion.completeTool(toolId, data.result, data.success !== false, data.error);
    } else {
      const currentGroup = accordion.getDisplayGroup();
      const nextDisplayGroup = isLiveBatchStep
        ? normalizeToolCallForDisplay({
            ...data,
            id: toolId,
            toolId,
            parentToolCallId: info.parentToolCallId ?? info.batchId ?? toolId,
            batchId: info.batchId ?? toolId,
            callIndex: info.callIndex,
            totalCalls: info.totalCalls,
            strategy: info.strategy,
            stepId: info.stepId,
            status: info.status
          }, currentGroup)
        : info.displayGroup;

      const shouldPreserveCurrentBatch =
        !isLiveBatchStep &&
        Boolean(currentGroup) &&
        currentGroup?.kind === 'batch' &&
        currentGroup.steps.length > 0 &&
        nextDisplayGroup.kind === 'batch' &&
        nextDisplayGroup.steps.length === 0 &&
        (
          nextDisplayGroup.technicalName === 'useTools' ||
          nextDisplayGroup.technicalName?.endsWith('.useTools')
        );

      const displayGroup = shouldPreserveCurrentBatch ? currentGroup! : nextDisplayGroup;

      accordion.setDisplayGroup(displayGroup);
    }

    if (event === 'completed' && data.success && data.result) {
      this.checkAndRenderImageResult(data.result);
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
   * Determine which DOM structure this message needs.
   */
  private getRenderMode(message: ConversationMessage): 'group' | 'standard' {
    const activeToolCalls = this.getActiveToolCalls(message);
    const hasToolCalls = message.role === 'assistant' && !!activeToolCalls && activeToolCalls.length > 0;
    const activeReasoning = this.getActiveReasoning(message);
    const hasReasoning = message.role === 'assistant' && !!activeReasoning;
    return hasToolCalls || hasReasoning ? 'group' : 'standard';
  }

  /**
   * Tool/reasoning messages still need a text bubble while loading so streaming
   * updates always have a content container to target.
   */
  private shouldRenderTextBubble(message: ConversationMessage): boolean {
    if (message.role !== 'assistant') {
      return false;
    }

    const activeContent = this.getActiveMessageContent(message);
    return !!activeContent.trim() || message.state === 'streaming' || !!message.isLoading;
  }

  /**
   * Replace the current DOM node when the message switches between incompatible
   * layouts, such as tool-only -> plain loading bubble during retry.
   */
  private rebuildElement(): void {
    const previousElement = this.element;
    const parentElement = previousElement?.parentElement ?? null;

    this.stopLoadingAnimation();
    this.cleanupProgressiveAccordions();

    if (this.messageBranchNavigator) {
      this.messageBranchNavigator.destroy();
      this.messageBranchNavigator = null;
    }

    this.toolBubbleElement = null;
    this.textBubbleElement = null;
    this.imageBubbleElement = null;
    this.cleanupActionBar();

    const nextElement = this.createElement();

    if (previousElement && parentElement) {
      previousElement.replaceWith(nextElement);
    } else {
      this.element = nextElement;
    }
  }

  /**
   * Render the inline loading indicator used after the initial bubble is on screen.
   */
  private appendLoadingIndicator(contentElement: HTMLElement): void {
    const loadingDiv = contentElement.createDiv('ai-loading-continuation');
    const loadingSpan = loadingDiv.createEl('span', { cls: 'ai-loading' });
    loadingSpan.appendText('Thinking');
    loadingSpan.createEl('span', { cls: 'dots', text: '...' });
    this.startLoadingAnimation(loadingDiv);
  }

  /**
   * Get the active content for the message (original or from branch)
   */
  private getActiveMessageContent(message: ConversationMessage): string {
    const activeIndex = message.activeAlternativeIndex || 0;

    if (activeIndex === 0) {
      return message.content;
    }

    // Use branches (new unified model)
    if (message.branches && message.branches.length > 0) {
      const branchIndex = activeIndex - 1;
      if (branchIndex >= 0 && branchIndex < message.branches.length) {
        const branch = message.branches[branchIndex];
        if (branch.messages.length > 0) {
          return branch.messages[branch.messages.length - 1].content;
        }
      }
    }

    return message.content;
  }

  /**
   * Get the active tool calls for the message (original or from branch)
   */
  private getActiveToolCalls(message: ConversationMessage): any[] | undefined {
    const activeIndex = message.activeAlternativeIndex || 0;

    if (activeIndex === 0) {
      return message.toolCalls;
    }

    // Use branches (new unified model)
    if (message.branches && message.branches.length > 0) {
      const branchIndex = activeIndex - 1;
      if (branchIndex >= 0 && branchIndex < message.branches.length) {
        const branch = message.branches[branchIndex];
        if (branch.messages.length > 0) {
          return branch.messages[branch.messages.length - 1].toolCalls;
        }
      }
    }

    return message.toolCalls;
  }

  /**
   * Get the active reasoning for the message (original or from branch)
   */
  private getActiveReasoning(message: ConversationMessage): string | undefined {
    const activeIndex = message.activeAlternativeIndex || 0;

    if (activeIndex === 0) {
      return message.reasoning;
    }

    // Use branches (new unified model)
    if (message.branches && message.branches.length > 0) {
      const branchIndex = activeIndex - 1;
      if (branchIndex >= 0 && branchIndex < message.branches.length) {
        const branch = message.branches[branchIndex];
        if (branch.messages.length > 0) {
          return branch.messages[branch.messages.length - 1].reasoning;
        }
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
   * Populate the existing .message-actions-external pill with action buttons
   * for completed assistant messages that have non-empty text content.
   * Buttons are inserted into the pill that already sits in the upper-right
   * corner — no new wrapper element is created.
   */
  private appendActionBar(container: HTMLElement, message: ConversationMessage): void {
    if (message.role !== 'assistant') return;
    if (message.isLoading || message.state === 'streaming') return;

    const activeContent = this.getActiveMessageContent(message);
    if (!activeContent.trim()) return;

    // Only create once per message lifecycle — rebuildElement resets this.actionBar
    if (this.actionBar !== null) return;

    const actionsEl = container.querySelector('.message-actions-external');
    if (!(actionsEl instanceof HTMLElement)) return;

    this.actionBar = new MessageActionBar(activeContent, this.app);
    this.actionBar.renderInto(actionsEl);
  }

  /**
   * Remove action buttons from the pill and unload event handlers.
   */
  private cleanupActionBar(): void {
    if (!this.actionBar) return;
    this.actionBar.removeFromContainer();
    this.actionBar.unload();
    this.actionBar = null;
  }

  /**
   * Cleanup resources.
   * Calls Component.unload() to auto-clean registerDomEvent/registerInterval handlers.
   */
  private isUnloaded = false;

  cleanup(): void {
    this.stopLoadingAnimation();
    this.cleanupProgressiveAccordions();
    this.cleanupActionBar();

    if (this.messageBranchNavigator) {
      this.messageBranchNavigator.destroy();
      this.messageBranchNavigator = null;
    }

    this.element = null;

    // Call Component.unload() to release registerDomEvent and registerInterval handlers.
    // Guard against double-unload since unload() is not idempotent.
    if (!this.isUnloaded) {
      this.isUnloaded = true;
      this.unload();
    }
  }
}
