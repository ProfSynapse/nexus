/**
 * MessageBubble - Individual message bubble component
 * Location: /src/ui/chat/components/MessageBubble.ts
 *
 * Renders user/AI messages with copy, retry, and edit actions.
 * Delegates rendering responsibilities to specialized classes following SOLID principles.
 *
 * Used by MessageDisplay to render individual messages in the chat interface.
 * Coordinates with ReferenceBadgeRenderer, MessageContentRenderer,
 * MessageEditController, and helper renderers for specific concerns.
 */

import { ConversationMessage } from '../../../types/chat/ChatTypes';
import { setIcon, Component, App } from 'obsidian';

// Extracted classes
import { ReferenceBadgeRenderer } from './renderers/ReferenceBadgeRenderer';
import { MessageContentRenderer } from './renderers/MessageContentRenderer';
import { MessageEditController } from '../controllers/MessageEditController';
import { MessageBubbleBranchNavigatorBinder } from './helpers/MessageBubbleBranchNavigatorBinder';
import { MessageBubbleImageRenderer } from './helpers/MessageBubbleImageRenderer';
import { MessageBubbleStateResolver } from './helpers/MessageBubbleStateResolver';
import { ThinkingLoader } from './ThinkingLoader';

export class MessageBubble extends Component {
  private element: HTMLElement | null = null;
  private loadingInterval: number | null = null;
  private copyFeedbackTimeout: ReturnType<typeof setTimeout> | null = null;
  private thinkingLoader: ThinkingLoader | null = null;
  private branchNavigatorBinder: MessageBubbleBranchNavigatorBinder;
  private imageRenderer: MessageBubbleImageRenderer;
  private textBubbleElement: HTMLElement | null = null;
  private imageBubbleElement: HTMLElement | null = null;

  constructor(
    private message: ConversationMessage,
    private app: App,
    private onCopy: (messageId: string) => void,
    private onRetry: (messageId: string) => void,
    private onEdit?: (messageId: string, newContent: string) => void,
    private onMessageAlternativeChanged?: (messageId: string, alternativeIndex: number) => void
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
      getToolBubbleElement: () => null,
      getTextBubbleElement: () => this.textBubbleElement,
      getImageBubbleElement: () => this.imageBubbleElement,
      setImageBubbleElement: (element) => {
        this.imageBubbleElement = element;
      }
    });
  }

  /**
   * Create the message bubble element
    * Assistant messages use a wrapper so generated image results can render beside the text bubble.
   */
  createElement(): HTMLElement {
    const state = MessageBubbleStateResolver.resolve(this.message);
    const activeContent = state.activeContent;

    if (this.message.role === 'assistant') {
      const wrapper = document.createElement('div');
      wrapper.addClass('message-group');
      wrapper.setAttribute('data-message-id', this.message.id);

      this.imageRenderer.renderLoadedToolResults(state.activeToolCalls, wrapper);

      this.textBubbleElement = this.createStandardMessageContainer(activeContent);
      wrapper.appendChild(this.textBubbleElement);

      if (this.message.branches && this.message.branches.length > 0) {
        const actions = this.textBubbleElement.querySelector('.message-actions-external');
        if (actions instanceof HTMLElement) {
          this.branchNavigatorBinder.sync(actions, this.message);
        }
      }

      const contentElement = this.textBubbleElement.querySelector('.message-content');
      if (contentElement instanceof HTMLElement && this.message.isLoading && !activeContent.trim()) {
        this.appendLoadingIndicator(contentElement);
      }

      this.element = wrapper;
      return wrapper;
    }

    const messageContainer = this.createStandardMessageContainer(activeContent);
    this.element = messageContainer;
    return messageContainer;
  }

  private createStandardMessageContainer(messageContent: string): HTMLElement {
    const messageContainer = document.createElement('div');
    messageContainer.addClass('message-container');
    messageContainer.addClass(this.message.role === 'tool' ? 'message-assistant' : `message-${this.message.role}`);
    messageContainer.setAttribute('data-message-id', this.message.id);

    const bubble = messageContainer.createDiv('message-bubble');

    // Loading state for empty assistant streaming — rendered inside the bubble
    // ahead of content so the ThinkingLoader appears in place of the eventual
    // text. No header / role-icon in the glass redesign.
    if (this.message.role === 'assistant' && this.message.isLoading && !this.message.content.trim()) {
      const loadingShell = bubble.createDiv('ai-loading-header');
      this.startThinkingLoader(loadingShell);
    }

    // Message content
    const content = bubble.createDiv('message-content');
    this.renderContent(content, messageContent).catch(error => {
      console.error('[MessageBubble] Error rendering initial content:', error);
    });

    // Action buttons sit OUTSIDE the bubble as a sibling that follows it,
    // so they always render below the message regardless of role. The glass
    // redesign uses subtle muted icons rather than the old hover-revealed pill.
    const actions = messageContainer.createDiv('message-actions-external');
    this.createActionButtons(actions);

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
    this.renderSourceFooter(container);
  }

  private renderSourceFooter(container: HTMLElement): void {
    if (this.message.role !== 'assistant') {
      return;
    }

    const sources = this.getMessageSources();
    if (sources.length === 0) {
      return;
    }

    const footer = container.createDiv('message-sources');
    footer.createDiv({ cls: 'message-sources-title', text: 'Sources' });

    const list = footer.createDiv('message-source-list');
    for (const source of sources) {
      const link = list.createEl('a', {
        cls: 'message-source-link',
        text: source.title,
        attr: {
          href: source.url,
          target: '_blank',
          rel: 'noopener noreferrer'
        }
      });

      if (source.date) {
        link.setAttribute('aria-label', `${source.title} (${source.date})`);
      }
    }
  }

  private getMessageSources(): Array<{ title: string; url: string; date?: string }> {
    const metadata = this.message.metadata;
    if (!metadata) {
      return [];
    }

    const deduped = new Map<string, { title: string; url: string; date?: string }>();
    const webSearchResults = metadata.webSearchResults;
    if (Array.isArray(webSearchResults)) {
      for (const result of webSearchResults) {
        if (!result || typeof result !== 'object') {
          continue;
        }

        const candidate = result as { title?: unknown; url?: unknown; date?: unknown };
        if (typeof candidate.url !== 'string' || !candidate.url.trim()) {
          continue;
        }

        deduped.set(candidate.url, {
          url: candidate.url,
          title: typeof candidate.title === 'string' && candidate.title.trim()
            ? candidate.title
            : this.getSourceLabel(candidate.url),
          date: typeof candidate.date === 'string' && candidate.date.trim()
            ? candidate.date
            : undefined
        });
      }
    }

    const citations = metadata.citations;
    if (Array.isArray(citations)) {
      for (const citation of citations) {
        if (typeof citation !== 'string' || !citation.trim() || deduped.has(citation)) {
          continue;
        }

        deduped.set(citation, {
          url: citation,
          title: this.getSourceLabel(citation)
        });
      }
    }

    return Array.from(deduped.values());
  }

  private getSourceLabel(url: string): string {
    try {
      return new URL(url).hostname.replace(/^www\./, '') || url;
    } catch {
      return url;
    }
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
      this.loadingInterval = window.setInterval(() => {
        dotCount = (dotCount + 1) % 4;
        dotsElement.textContent = '.'.repeat(dotCount);
      }, 500);
      this.registerInterval(this.loadingInterval);
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

    if (this.thinkingLoader) {
      this.thinkingLoader.stop();
      this.thinkingLoader.unload();
      this.thinkingLoader = null;
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

    contentElement.empty();

    this.renderContent(contentElement as HTMLElement, content).catch(error => {
      console.error('[MessageBubble] Error rendering content:', error);
      const fallbackDiv = document.createElement('div');
      fallbackDiv.textContent = content;
      contentElement.appendChild(fallbackDiv);
    });
  }

  /**
   * Update MessageBubble with new message data
   */
  updateWithNewMessage(newMessage: ConversationMessage): void {
    const nextState = MessageBubbleStateResolver.resolve(newMessage);

    this.stopLoadingAnimation();
    this.message = newMessage;

    this.imageRenderer.clear();

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

    if (this.message.role === 'assistant' && this.element instanceof HTMLElement) {
      this.imageRenderer.renderLoadedToolResults(nextState.activeToolCalls, this.element);
      if (this.textBubbleElement && this.textBubbleElement.parentElement === this.element) {
        this.element.appendChild(this.textBubbleElement);
      }
    }

    if (newMessage.isLoading && newMessage.role === 'assistant') {
      this.appendLoadingIndicator(contentElement);
    }
  }

  /**
   * Replace the current DOM node when the message switches between incompatible
   * layouts, such as tool-only -> plain loading bubble during retry.
   */
  private rebuildElement(): void {
    const previousElement = this.element;
    const parentElement = previousElement?.parentElement ?? null;

    this.stopLoadingAnimation();

    this.branchNavigatorBinder.destroy();

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
    this.startThinkingLoader(loadingDiv);
  }

  private startThinkingLoader(container: HTMLElement): void {
    if (this.thinkingLoader) {
      this.thinkingLoader.stop();
      this.thinkingLoader.unload();
    }

    const loader = new ThinkingLoader();
    this.thinkingLoader = loader;
    loader.start(container);
  }

  /**
   * Show visual feedback when copy button is clicked
   */
  private showCopyFeedback(button: HTMLElement): void {
    if (this.copyFeedbackTimeout) {
      clearTimeout(this.copyFeedbackTimeout);
      this.copyFeedbackTimeout = null;
    }

    const originalTitle = button.getAttribute('title') || '';
    setIcon(button, 'check');
    button.setAttribute('title', 'Copied!');
    button.classList.add('copy-success');

    this.copyFeedbackTimeout = setTimeout(() => {
      this.copyFeedbackTimeout = null;
      setIcon(button, 'copy');
      button.setAttribute('title', originalTitle);
      button.classList.remove('copy-success');
    }, 1500);
  }

  /**
   * Cleanup resources.
   * Calls Component.unload() to auto-clean registerDomEvent/registerInterval handlers.
   */
  private isUnloaded = false;

  cleanup(): void {
    if (this.copyFeedbackTimeout) {
      clearTimeout(this.copyFeedbackTimeout);
      this.copyFeedbackTimeout = null;
    }
    this.stopLoadingAnimation();
    this.imageRenderer.clear();

    this.branchNavigatorBinder.destroy();

    this.element = null;
    this.textBubbleElement = null;
    this.imageBubbleElement = null;

    // Call Component.unload() to release registerDomEvent and registerInterval handlers.
    // Guard against double-unload since unload() is not idempotent.
    if (!this.isUnloaded) {
      this.isUnloaded = true;
      this.unload();
    }
  }
}
