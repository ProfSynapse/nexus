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
import { setIcon, Component, App } from 'obsidian';

// Extracted classes
import { ReferenceBadgeRenderer } from './renderers/ReferenceBadgeRenderer';
import { ToolBubbleFactory } from './factories/ToolBubbleFactory';
import { ToolEventParser } from '../utils/ToolEventParser';
import { MessageContentRenderer } from './renderers/MessageContentRenderer';
import { MessageEditController } from '../controllers/MessageEditController';
import { MessageBubbleBranchNavigatorBinder } from './helpers/MessageBubbleBranchNavigatorBinder';
import { MessageBubbleImageRenderer } from './helpers/MessageBubbleImageRenderer';
import { MessageBubbleToolEventCoordinator } from './helpers/MessageBubbleToolEventCoordinator';
import { MessageBubbleStateResolver } from './helpers/MessageBubbleStateResolver';

export class MessageBubble extends Component {
  private element: HTMLElement | null = null;
  private loadingInterval: ReturnType<typeof setInterval> | null = null;
  private progressiveToolAccordions: Map<string, ProgressiveToolAccordion> = new Map();
  private branchNavigatorBinder: MessageBubbleBranchNavigatorBinder;
  private imageRenderer: MessageBubbleImageRenderer;
  private toolEventCoordinator: MessageBubbleToolEventCoordinator;
  private toolBubbleElement: HTMLElement | null = null;
  private textBubbleElement: HTMLElement | null = null;
  private imageBubbleElement: HTMLElement | null = null;

  constructor(
    private message: ConversationMessage,
    private app: App,
    private onCopy: (messageId: string) => void,
    private onRetry: (messageId: string) => void,
    private onEdit?: (messageId: string, newContent: string) => void,
    private onToolEvent?: (messageId: string, event: 'detected' | 'started' | 'completed', data: Parameters<typeof ToolEventParser.getToolEventInfo>[0]) => void,
    private onMessageAlternativeChanged?: (messageId: string, alternativeIndex: number) => void,
    private onViewBranch?: (branchId: string) => void
  ) {
    super();
    this.branchNavigatorBinder = new MessageBubbleBranchNavigatorBinder({
      component: this,
      onMessageAlternativeChanged: this.onMessageAlternativeChanged
    });
    this.imageRenderer = new MessageBubbleImageRenderer({
      app: this.app,
      component: this,
      getMessage: () => this.message,
      getElement: () => this.element,
      getToolBubbleElement: () => this.toolBubbleElement,
      getTextBubbleElement: () => this.textBubbleElement,
      getImageBubbleElement: () => this.imageBubbleElement,
      setImageBubbleElement: (element) => {
        this.imageBubbleElement = element;
      }
    });
    this.toolEventCoordinator = new MessageBubbleToolEventCoordinator({
      component: this,
      getMessage: () => this.message,
      getElement: () => this.element,
      getToolBubbleElement: () => this.toolBubbleElement,
      setToolBubbleElement: (element) => {
        this.toolBubbleElement = element;
      },
      progressiveToolAccordions: this.progressiveToolAccordions,
      onViewBranch: this.onViewBranch,
      imageRenderer: this.imageRenderer
    });
  }

  /**
   * Create the message bubble element
   * For assistant messages with toolCalls or reasoning, returns a fragment containing tool bubble + text bubble
   */
  createElement(): HTMLElement {
    const state = MessageBubbleStateResolver.resolve(this.message);
    const activeToolCalls = state.activeToolCalls;
    const activeReasoning = state.activeReasoning;
    const showToolBubble = state.renderMode === 'group';
    const activeContent = state.activeContent;

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

      this.imageRenderer.renderLoadedToolResults(activeToolCalls, wrapper);

      // Create text bubble if there's content OR if streaming (need element for StreamingController)
      if (state.shouldRenderTextBubble) {
        this.textBubbleElement = ToolBubbleFactory.createTextBubble(
          renderMessage,
          (container, content) => this.renderContent(container, content),
          this.onCopy,
          (button) => this.showCopyFeedback(button),
          this.branchNavigatorBinder.getNavigator(),
          this.onMessageAlternativeChanged,
          this
        );
        wrapper.appendChild(this.textBubbleElement);

        // Add branch navigator for assistant messages with branches
        if (renderMessage.branches && renderMessage.branches.length > 0) {
          const actions = this.textBubbleElement.querySelector('.message-actions-external');
          if (actions instanceof HTMLElement) {
            this.branchNavigatorBinder.sync(actions, renderMessage);
          }
        }

        const contentElement = this.textBubbleElement.querySelector('.message-content');
        if (contentElement instanceof HTMLElement && this.message.isLoading && !activeContent.trim()) {
          this.appendLoadingIndicator(contentElement);
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

    this.createActionButtons(actions);

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
  private createActionButtons(actions: HTMLElement): void {
    if (this.message.role === 'user') {
      // Edit button for user messages
      if (this.onEdit) {
        const editBtn = actions.createEl('button', {
          cls: 'message-action-btn clickable-icon',
          attr: { title: 'Edit message' }
        });
        setIcon(editBtn, 'edit');
        const onEdit = this.onEdit;
        this.registerDomEvent(editBtn, 'click', () => {
          if (onEdit) {
            MessageEditController.handleEdit(this.message, this.element, onEdit, this);
          }
        });
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

      this.branchNavigatorBinder.sync(actions, this.message);
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
    if (this.loadingInterval) {
      clearInterval(this.loadingInterval);
      this.loadingInterval = null;
    }

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
    const previousState = MessageBubbleStateResolver.resolve(this.message);
    const nextState = MessageBubbleStateResolver.resolve(newMessage);
    const previousRenderMode = previousState.renderMode;
    const nextRenderMode = nextState.renderMode;
    const previousHadTextBubble = previousState.shouldRenderTextBubble;
    const nextNeedsTextBubble = nextState.shouldRenderTextBubble;

    // Handle progressive accordion transition to static
    const activeToolCalls = nextState.activeToolCalls;
    if (this.progressiveToolAccordions.size > 0 && activeToolCalls) {
      const hasCompletedTools = activeToolCalls.some(tc =>
        tc.result !== undefined || tc.success !== undefined
      );

      if (!hasCompletedTools) {
        this.message = newMessage;
        this.branchNavigatorBinder.getNavigator()?.updateMessage(newMessage);
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

      this.imageRenderer.clear();
    }

    if (this.element) {
      const actions = this.element.querySelector('.message-actions-external');
      if (actions instanceof HTMLElement) {
        this.branchNavigatorBinder.sync(actions, newMessage);
      }
    }

    if (!this.element) return;
    const contentElement = this.element.querySelector('.message-content');
    if (!(contentElement instanceof HTMLElement)) {
      this.rebuildElement();
      return;
    }

    contentElement.empty();

    const activeContent = nextState.activeContent;
    this.renderContent(contentElement, activeContent).catch(error => {
      console.error('[MessageBubble] Error re-rendering content:', error);
    });

    if (newMessage.isLoading && newMessage.role === 'assistant') {
      this.appendLoadingIndicator(contentElement);
    }
  }

  /**
   * Handle tool events from MessageManager
   */
  handleToolEvent(event: 'detected' | 'updated' | 'started' | 'completed', data: Parameters<typeof ToolEventParser.getToolEventInfo>[0]): void {
    this.toolEventCoordinator.handleToolEvent(event, data);
  }

  /**
   * Get progressive tool accordions for external updates
   */
  getProgressiveToolAccordions(): Map<string, ProgressiveToolAccordion> {
    return this.progressiveToolAccordions;
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

    this.branchNavigatorBinder.destroy();

    this.toolBubbleElement = null;
    this.textBubbleElement = null;
    this.imageBubbleElement = null;

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
   * Cleanup resources.
   * Calls Component.unload() to auto-clean registerDomEvent/registerInterval handlers.
   */
  private isUnloaded = false;

  cleanup(): void {
    this.stopLoadingAnimation();
    this.cleanupProgressiveAccordions();

    this.branchNavigatorBinder.destroy();

    this.element = null;

    // Call Component.unload() to release registerDomEvent and registerInterval handlers.
    // Guard against double-unload since unload() is not idempotent.
    if (!this.isUnloaded) {
      this.isUnloaded = true;
      this.unload();
    }
  }
}
