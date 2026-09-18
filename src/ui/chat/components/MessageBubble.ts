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

import { ConversationMessage, ReasoningSegment } from '../../../types/chat/ChatTypes';
import { setIcon, Component, App } from 'obsidian';

// Extracted classes
import { ReferenceBadgeRenderer } from './renderers/ReferenceBadgeRenderer';
import { MessageContentRenderer } from './renderers/MessageContentRenderer';
import { MessageEditController } from '../controllers/MessageEditController';
import { MessageBubbleBranchNavigatorBinder } from './helpers/MessageBubbleBranchNavigatorBinder';
import { MessageBubbleImageRenderer } from './helpers/MessageBubbleImageRenderer';
import { MessageBubbleStateResolver } from './helpers/MessageBubbleStateResolver';
import { ReasoningSegmentSplitter } from './helpers/ReasoningSegmentSplitter';
import { ThinkingLoader } from './ThinkingLoader';

export class MessageBubble extends Component {
  private element: HTMLElement | null = null;
  private loadingInterval: number | null = null;
  private copyFeedbackTimeout: number | null = null;
  private thinkingLoader: ThinkingLoader | null = null;
  // The in-bubble "working" ticker (pre-text wait, tool-first turns, and the
  // silent tool-execution gaps mid-stream). `workingTickerActive` is the intent
  // flag that survives re-renders so a mid-stream reconcile re-applies the
  // ticker instead of dropping it; `workingTickerEl` is its DOM wrapper.
  private workingTickerActive = false;
  private workingTickerEl: HTMLElement | null = null;
  private branchNavigatorBinder: MessageBubbleBranchNavigatorBinder;
  private imageRenderer: MessageBubbleImageRenderer;
  private textBubbleElement: HTMLElement | null = null;
  private imageBubbleElement: HTMLElement | null = null;
  // Open/closed state we last applied to each thinking block, keyed by segment
  // index. The toggle handler compares against it to tell a user's click apart
  // from our own auto-collapse; once they have taken control of a block their
  // choice is recorded and wins over auto-collapse, re-renders included.
  private reasoningAutoState = new Map<number, boolean>();
  private reasoningUserState = new Map<number, boolean>();

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
      const wrapper = createDiv();
      wrapper.addClass('message-group');
      wrapper.setAttribute('data-message-id', this.message.id);

      this.imageRenderer.renderLoadedToolResults(state.activeToolCalls, wrapper);

      this.textBubbleElement = this.createStandardMessageContainer(activeContent);
      wrapper.appendChild(this.textBubbleElement);

      if (this.message.branches && this.message.branches.length > 0) {
        const actions = this.textBubbleElement.querySelector('.message-actions-external');
        if (this.isHTMLElement(actions)) {
          this.branchNavigatorBinder.sync(actions, this.message);
        }
      }

      this.element = wrapper;

      if (this.message.isLoading && !activeContent.trim()) {
        this.ensureWorkingTicker();
      }

      return wrapper;
    }

    const messageContainer = this.createStandardMessageContainer(activeContent);
    this.element = messageContainer;
    return messageContainer;
  }

  private createStandardMessageContainer(messageContent: string): HTMLElement {
    const messageContainer = createDiv();
    messageContainer.addClass('message-container');
    messageContainer.addClass(this.message.role === 'tool' ? 'message-assistant' : `message-${this.message.role}`);
    messageContainer.setAttribute('data-message-id', this.message.id);

    const bubble = messageContainer.createDiv('message-bubble');

    // Message body. `.message-content` holds the turn in the order the model
    // produced it: each "Thinking" block above the stretch of text it preceded.
    // The "working" ticker for empty assistant streaming is attached by
    // createElement() via ensureWorkingTicker() so it sits inside this
    // container (kept attached even when there is no text).
    const content = bubble.createDiv('message-content');
    this.renderBody(content, messageContent).catch(error => {
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
          cls: 'message-action-btn clickable-icon nexus-user-msg-action',
          attr: { title: 'Edit message', 'aria-label': 'Edit message' }
        });
        setIcon(editBtn, 'edit');
        const onEdit = this.onEdit;
        this.registerDomEvent(editBtn, 'click', () => {
          if (onEdit) {
            MessageEditController.handleEdit(this.message, this.element, onEdit, this.onRetry.bind(this), this);
          }
        });
      }

      // Retry button for user messages
      const retryBtn = actions.createEl('button', {
        cls: 'message-action-btn clickable-icon nexus-user-msg-action',
        attr: { title: 'Retry message', 'aria-label': 'Retry message' }
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
        attr: { title: 'Copy tool execution details', 'aria-label': 'Copy tool execution details' }
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
        attr: { title: 'Copy message', 'aria-label': 'Copy message' }
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
   * Render the whole message body into `.message-content`: the turn's thinking
   * blocks and text runs in the order the model produced them, then the source
   * footer. Rebuilds from scratch, so callers empty the container first.
   */
  private async renderBody(container: HTMLElement, content: string): Promise<void> {
    const state = MessageBubbleStateResolver.resolve(this.message);

    // Nothing to lay out yet: an assistant placeholder with neither text nor
    // thinking is the working ticker's job, not this one's.
    const hasReasoning = !!state.activeReasoning?.trim();
    if (this.message.isLoading && this.message.role === 'assistant' && !content.trim() && !hasReasoning) {
      return;
    }

    const parts = ReasoningSegmentSplitter.split(
      content,
      state.activeReasoningSegments,
      state.activeReasoning
    );
    const stillThinking = this.message.state === 'streaming' || !!this.message.isLoading;
    const referenceMetadata = ReferenceBadgeRenderer.getReferenceMetadata(this.message.metadata);

    this.reasoningAutoState.clear();

    // Build the whole structure synchronously so the DOM order is settled before
    // any markdown render resolves — the streaming parser looks for the trailing
    // run the moment the next token lands.
    const pending: Array<Promise<void>> = [];

    for (let index = 0; index < parts.length; index++) {
      const part = parts[index];

      if (part.reasoning && part.reasoningIndex !== undefined) {
        // Only the last block stays open, and only while the turn is still
        // running: once text follows, the thinking that produced it folds away
        // instead of pushing the answer off screen.
        const isLast = index === parts.length - 1;
        this.syncReasoningBlock(
          container,
          part.reasoningIndex,
          part.reasoning.text,
          stillThinking && isLast && !part.text.trim()
        );
      }

      // Always create the run, even when empty: it is what the streaming parser
      // binds to for the next stretch of text.
      const run = container.createDiv('message-turn-text');
      pending.push(
        MessageContentRenderer.renderContent(run, part.text, this.app, this, referenceMetadata)
      );
    }

    this.renderSourceFooter(container);

    await Promise.all(pending);
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
      window.clearInterval(this.loadingInterval);
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
      window.clearInterval(this.loadingInterval);
      this.loadingInterval = null;
    }

    // Terminal stop: clear the working ticker and its intent flag so it is not
    // re-applied on subsequent re-renders.
    this.removeWorkingTicker();
  }

  /**
   * Show the in-bubble "working" ticker (idempotent). Lives inside the bubble's
   * `.message-content` so it stays attached to the message — sitting after the
   * streamed text during a tool gap, or filling an otherwise-empty bubble on a
   * tool-first turn. Safe to call repeatedly; an already-mounted ticker keeps
   * its word animation rather than restarting.
   */
  ensureWorkingTicker(): void {
    this.workingTickerActive = true;
    if (!this.element) return;
    if (this.workingTickerEl && this.element.contains(this.workingTickerEl)) return;

    const contentElement = this.element.querySelector('.message-content');
    if (!this.isHTMLElement(contentElement)) return;

    this.workingTickerEl = contentElement.createDiv('ai-loading-continuation');
    this.startThinkingLoader(this.workingTickerEl);
  }

  /** Hide the in-bubble working ticker and clear its intent flag. */
  removeWorkingTicker(): void {
    this.workingTickerActive = false;
    this.clearWorkingTickerEl();
  }

  /**
   * Tear down the ticker DOM + timers WITHOUT clearing the intent flag, so a
   * re-render can re-apply it (see updateWithNewMessage).
   */
  private clearWorkingTickerEl(): void {
    if (this.thinkingLoader) {
      this.thinkingLoader.stop();
      this.thinkingLoader.unload();
      this.thinkingLoader = null;
    }
    if (this.workingTickerEl) {
      this.workingTickerEl.remove();
      this.workingTickerEl = null;
    }
  }

  /**
   * Create or update one collapsible "Thinking" block inside `.message-content`,
   * keyed by its index in the turn's reasoning segments. New blocks are appended
   * after everything rendered so far (above the working ticker), which is where
   * the thinking belongs: directly over the text it is about to produce.
   */
  private syncReasoningBlock(
    container: HTMLElement,
    segmentIndex: number,
    text: string,
    open: boolean
  ): HTMLDetailsElement | null {
    if (!text || !text.trim()) {
      return null;
    }

    let details = this.findReasoningBlock(container, segmentIndex);

    if (!details) {
      // Avoid `instanceof HTMLDetailsElement` (unreliable across Obsidian popout
      // windows, like the file's isHTMLElement helper) — match on tagName instead.
      details = createEl('details');
      details.addClass('message-reasoning');
      details.setAttribute('data-reasoning-index', String(segmentIndex));
      details.createEl('summary', { cls: 'message-reasoning-summary', text: 'Thinking' });
      details.createDiv('message-reasoning-content');

      const block = details;
      this.registerDomEvent(details, 'toggle', () => {
        // `toggle` fires for our own auto-collapse too, and asynchronously, so
        // compare against the state we last applied rather than assuming a click.
        if (block.open !== this.reasoningAutoState.get(segmentIndex)) {
          this.reasoningUserState.set(segmentIndex, block.open);
        }
      });

      if (this.workingTickerEl && this.workingTickerEl.parentElement === container) {
        container.insertBefore(details, this.workingTickerEl);
      } else {
        container.appendChild(details);
      }
    }

    const body = details.querySelector('.message-reasoning-content');
    if (this.isHTMLElement(body)) {
      body.textContent = text;
    }

    const desired = this.reasoningUserState.get(segmentIndex) ?? open;
    this.reasoningAutoState.set(segmentIndex, desired);
    details.open = desired;

    return details;
  }

  private findReasoningBlock(container: HTMLElement, segmentIndex: number): HTMLDetailsElement | null {
    const existing = container.querySelector(
      `:scope > .message-reasoning[data-reasoning-index="${segmentIndex}"]`
    );
    return this.isHTMLElement(existing) && existing.tagName === 'DETAILS'
      ? existing as HTMLDetailsElement
      : null;
  }

  /** Fold every thinking block before `segmentIndex` the reader has not opened themselves. */
  private collapseReasoningBlocksBefore(container: HTMLElement, segmentIndex: number): void {
    const blocks = container.querySelectorAll(':scope > .message-reasoning');
    blocks.forEach(block => {
      if (!this.isHTMLElement(block) || block.tagName !== 'DETAILS') return;
      const index = Number.parseInt(block.getAttribute('data-reasoning-index') ?? '', 10);
      if (!Number.isInteger(index) || index >= segmentIndex) return;
      if (this.reasoningUserState.has(index)) return;
      this.reasoningAutoState.set(index, false);
      (block as HTMLDetailsElement).open = false;
    });
  }

  /**
   * Live update during streaming: write the newest thinking into its own block.
   *
   * Returns true when this delta opened a NEW block, which is the caller's cue
   * to seal the text run above it so the next tokens start a fresh run below.
   */
  updateReasoning(
    reasoningText: string,
    isComplete: boolean,
    segments?: ReasoningSegment[]
  ): boolean {
    if (!this.element) return false;
    const container = this.element.querySelector('.message-bubble .message-content');
    if (!this.isHTMLElement(container)) return false;

    // Reflect the incoming reasoning on the in-memory message so a later
    // re-render (updateContent, reconcile) rebuilds the same layout.
    this.message = { ...this.message, reasoning: reasoningText, reasoningSegments: segments };

    const list: ReasoningSegment[] = segments && segments.length > 0
      ? segments
      : [{ text: reasoningText, contentOffset: 0 }];
    const lastIndex = list.length - 1;

    const isNewBlock = this.findReasoningBlock(container, lastIndex) === null;
    if (isNewBlock) {
      this.collapseReasoningBlocksBefore(container, lastIndex);
    }

    const block = this.syncReasoningBlock(container, lastIndex, list[lastIndex].text, !isComplete);

    // Only report a block that actually rendered: a segment whose first delta is
    // whitespace must not seal the text run above an element that is not there.
    return isNewBlock && block !== null;
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
    // The message the bubble holds carries the turn's reasoning segments (kept
    // current by updateReasoning), so the rebuild reproduces the interleaving.
    this.message = { ...this.message, content };

    this.renderBody(contentElement as HTMLElement, content).catch(error => {
      console.error('[MessageBubble] Error rendering content:', error);
      const fallbackDiv = createDiv();
      fallbackDiv.textContent = content;
      contentElement.appendChild(fallbackDiv);
    });
  }

  /**
   * Update MessageBubble with new message data
   */
  updateWithNewMessage(newMessage: ConversationMessage): void {
    const nextState = MessageBubbleStateResolver.resolve(newMessage);

    // Clear the ticker DOM before re-render but PRESERVE the intent flag, so a
    // mid-stream reconcile (e.g. LM Studio persisting a Responses API id during
    // a tool gap) re-applies the ticker below instead of dropping it.
    if (this.loadingInterval) {
      window.clearInterval(this.loadingInterval);
      this.loadingInterval = null;
    }
    this.clearWorkingTickerEl();
    this.message = newMessage;

    this.imageRenderer.clear();

    if (this.element) {
      const actions = this.element.querySelector('.message-actions-external');
      if (this.isHTMLElement(actions)) {
        this.branchNavigatorBinder.sync(actions, newMessage);
      }
    }

    if (!this.element) return;
    const contentElement = this.element.querySelector('.message-content');
    if (!this.isHTMLElement(contentElement)) {
      this.rebuildElement();
      return;
    }

    contentElement.empty();

    // Thinking blocks live inside .message-content, so the rebuild below
    // reproduces them from the new message's segments in one pass.
    const activeContent = nextState.activeContent;
    this.renderBody(contentElement, activeContent).catch(error => {
      console.error('[MessageBubble] Error re-rendering content:', error);
    });

    if (this.message.role === 'assistant' && this.isHTMLElement(this.element)) {
      this.imageRenderer.renderLoadedToolResults(nextState.activeToolCalls, this.element);
      if (this.textBubbleElement && this.textBubbleElement.parentElement === this.element) {
        this.element.appendChild(this.textBubbleElement);
      }
    }

    // Re-apply the working ticker if the turn is still mid-flight: either the
    // message is still loading (pre-text / tool-first) or the gap controller had
    // it showing when this reconcile fired.
    if (newMessage.role === 'assistant' && (newMessage.isLoading || this.workingTickerActive)) {
      this.ensureWorkingTicker();
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

  private startThinkingLoader(container: HTMLElement): void {
    if (this.thinkingLoader) {
      this.thinkingLoader.stop();
      this.thinkingLoader.unload();
    }

    const loader = new ThinkingLoader();
    this.thinkingLoader = loader;
    this.addChild(loader);
    loader.start(container);
  }

  private isHTMLElement(value: Element | null | undefined): value is HTMLElement {
    if (!value) {
      return false;
    }

    const candidate = value as Element & {
      instanceOf?: (type: typeof HTMLElement) => boolean;
      setAttribute?: unknown;
      appendChild?: unknown;
    };

    if (typeof candidate.instanceOf === 'function') {
      return candidate.instanceOf(HTMLElement);
    }

    return typeof candidate.setAttribute === 'function' && typeof candidate.appendChild === 'function';
  }

  /**
   * Show visual feedback when copy button is clicked
   */
  private showCopyFeedback(button: HTMLElement): void {
    if (this.copyFeedbackTimeout) {
      window.clearTimeout(this.copyFeedbackTimeout);
      this.copyFeedbackTimeout = null;
    }

    const originalTitle = button.getAttribute('title') || '';
    button.setAttribute('title', 'Copied!');
    button.classList.add('copy-success');

    this.copyFeedbackTimeout = window.setTimeout(() => {
      this.copyFeedbackTimeout = null;
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
      window.clearTimeout(this.copyFeedbackTimeout);
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
