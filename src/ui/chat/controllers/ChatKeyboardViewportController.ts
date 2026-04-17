/**
 * ChatKeyboardViewportController
 *
 * Owns all iOS/Android on-screen-keyboard viewport handling for the chat input:
 * - visualViewport resize/scroll reconciliation
 * - Capacitor keyboardWill / keyboardDid event wiring
 * - `.chat-keyboard-active` toggling + `--chat-keyboard-offset` /
 *   `--chat-keyboard-editor-height` CSS custom properties on `.chat-main`
 * - Post-event settling probes (the OS reports visualViewport height in
 *   stages during keyboard animation; we re-measure at settled-enough ticks)
 *
 * Extracted from ChatInput to keep that component focused on input/send/suggesters.
 * ChatInput still owns `autoResizeInput()` — the controller notifies it through
 * the `onOffsetChanged` callback so the textarea can re-measure against the new
 * keyboard-reduced available height.
 */

import { Component } from 'obsidian';

const SETTLING_DELAYS_MS = [60, 180, 320];
const NATIVE_HIDE_BASELINE_REFRESH_MS = 160;
const BLUR_CLEAR_DELAY_MS = 120;
const EDITOR_HEIGHT_MIN_PX = 150;
const EDITOR_HEIGHT_MAX_PX = 320;
const EDITOR_HEIGHT_BOTTOM_PADDING_PX = 18;
const KEYBOARD_OFFSET_LIFT_REDUCTION_PX = 22;

export interface ChatKeyboardViewportOptions {
  /** Input container element (used for getBoundingClientRect on the input row). */
  container: HTMLElement;
  /** The contenteditable input — focus/blur listeners + :focus checks. */
  inputElement: HTMLElement;
  /** Resolves the send button (may be null during early render). */
  getSendButton: () => HTMLButtonElement | null;
  /** Called after every offset change so ChatInput can re-run autoResizeInput(). */
  onOffsetChanged: () => void;
  /** Obsidian Component — used for registerDomEvent + register(cleanup). */
  component: Component;
}

export class ChatKeyboardViewportController {
  private readonly options: ChatKeyboardViewportOptions;
  private root: HTMLElement | null = null;
  private pendingFrame: number | null = null;
  private settlingTimers: number[] = [];
  private baselineInnerHeight = 0;
  private nativeKeyboardOffset = 0;
  private editorHeight = 0;
  private teardown: (() => void) | null = null;

  constructor(options: ChatKeyboardViewportOptions) {
    this.options = options;
  }

  attach(): void {
    if (typeof window === 'undefined') {
      return;
    }

    this.teardown?.();
    this.root = this.options.container.closest('.chat-main');
    this.baselineInnerHeight = window.innerHeight;
    if (!this.root) {
      return;
    }

    const { component, inputElement } = this.options;

    const scheduleUpdate = () => this.scheduleOffsetUpdate();
    const scheduleSettled = () => this.scheduleSettledUpdates();
    const handleNativeShow = (event: CapacitorKeyboardEvent) => {
      this.updateNativeKeyboardOffset(event);
      this.scheduleSettledUpdates();
    };
    const handleNativeHide = () => {
      this.nativeKeyboardOffset = 0;
      this.clearSettlingTimers();
      window.setTimeout(() => {
        this.baselineInnerHeight = window.innerHeight;
        this.resetOffset();
      }, NATIVE_HIDE_BASELINE_REFRESH_MS);
    };
    const handleBlur = () => {
      window.setTimeout(() => {
        if (inputElement.matches(':focus')) {
          return;
        }
        const sendButton = this.options.getSendButton();
        if (sendButton && document.activeElement === sendButton) {
          sendButton.blur();
        }
        this.nativeKeyboardOffset = 0;
        this.baselineInnerHeight = window.innerHeight;
        this.resetOffset();
      }, BLUR_CLEAR_DELAY_MS);
    };

    // visualViewport listeners use raw addEventListener because the Obsidian
    // Component API doesn't expose registerDomEvent for the VisualViewport type.
    // We tear them down explicitly via component.register(cleanup).
    window.visualViewport?.addEventListener('resize', scheduleSettled);
    window.visualViewport?.addEventListener('scroll', scheduleUpdate);

    this.teardown = () => {
      window.visualViewport?.removeEventListener('resize', scheduleSettled);
      window.visualViewport?.removeEventListener('scroll', scheduleUpdate);
      this.cancelPendingFrame();
      this.clearSettlingTimers();
      this.resetOffset();
    };
    component.register(this.teardown);

    component.registerDomEvent(inputElement, 'focus', scheduleSettled);
    component.registerDomEvent(inputElement, 'blur', handleBlur);
    component.registerDomEvent(window, 'resize', scheduleSettled);
    component.registerDomEvent(window, 'orientationchange', scheduleSettled);
    component.registerDomEvent(window, 'keyboardWillShow', handleNativeShow);
    component.registerDomEvent(window, 'keyboardDidShow', handleNativeShow);
    component.registerDomEvent(window, 'keyboardWillHide', handleNativeHide);
    component.registerDomEvent(window, 'keyboardDidHide', handleNativeHide);

    this.updateOffset();
  }

  detach(): void {
    this.cancelPendingFrame();
    this.clearSettlingTimers();
    this.teardown?.();
    this.teardown = null;
    this.nativeKeyboardOffset = 0;
    this.resetOffset();
  }

  isActive(): boolean {
    return this.root?.hasClass('chat-keyboard-active') ?? false;
  }

  getEditorHeight(): number {
    return this.editorHeight;
  }

  /**
   * Schedule a single offset recomputation on the next animation frame.
   * Coalesces bursts of visualViewport scroll events into one measurement.
   */
  private scheduleOffsetUpdate(): void {
    if (typeof window === 'undefined') {
      return;
    }
    if (this.pendingFrame !== null) {
      return;
    }
    this.pendingFrame = window.requestAnimationFrame(() => {
      this.pendingFrame = null;
      this.updateOffset();
    });
  }

  /**
   * Run offset updates at staged delays to catch the full visualViewport
   * settle window — iOS reports intermediate heights during keyboard
   * animation, so a single rAF after the triggering event often samples a
   * mid-animation state. Delays: immediate rAF + [60, 180, 320]ms.
   */
  private scheduleSettledUpdates(): void {
    if (typeof window === 'undefined') {
      return;
    }
    this.clearSettlingTimers();
    this.scheduleOffsetUpdate();
    for (const delay of SETTLING_DELAYS_MS) {
      const timerId = window.setTimeout(() => {
        this.settlingTimers = this.settlingTimers.filter((id) => id !== timerId);
        this.scheduleOffsetUpdate();
      }, delay);
      this.settlingTimers.push(timerId);
    }
  }

  private cancelPendingFrame(): void {
    if (this.pendingFrame !== null && typeof window !== 'undefined') {
      window.cancelAnimationFrame(this.pendingFrame);
    }
    this.pendingFrame = null;
  }

  private clearSettlingTimers(): void {
    if (typeof window !== 'undefined') {
      for (const timerId of this.settlingTimers) {
        window.clearTimeout(timerId);
      }
    }
    this.settlingTimers = [];
  }

  private updateOffset(): void {
    if (!this.root || typeof window === 'undefined') {
      return;
    }

    const currentOffset = this.readCurrentOffset();
    const inputBottom = this.options.container.getBoundingClientRect().bottom + currentOffset;
    const keyboardTop = this.getKeyboardTop();
    const visualViewportOffset = keyboardTop !== null
      ? Math.max(0, inputBottom - keyboardTop)
      : 0;
    const keyboardOffset = visualViewportOffset > 1 ? visualViewportOffset : this.nativeKeyboardOffset;
    const roundedOffset = Math.ceil(keyboardOffset);

    if (roundedOffset > 1) {
      this.root.addClass('chat-keyboard-active');
      const liftOffset = Math.max(0, roundedOffset - KEYBOARD_OFFSET_LIFT_REDUCTION_PX);
      this.root.style.setProperty('--chat-keyboard-offset', `${liftOffset}px`);
      this.updateEditorHeight(keyboardTop);
      this.options.onOffsetChanged();
    } else {
      this.resetOffset();
    }
  }

  private resetOffset(): void {
    this.root?.removeClass('chat-keyboard-active');
    this.root?.style.removeProperty('--chat-keyboard-offset');
    this.root?.style.removeProperty('--chat-keyboard-editor-height');
    this.editorHeight = 0;
    this.options.onOffsetChanged();
  }

  private updateNativeKeyboardOffset(event: CapacitorKeyboardEvent): void {
    const keyboardHeight = this.getKeyboardHeight(event);
    if (keyboardHeight <= 0 || typeof window === 'undefined') {
      this.nativeKeyboardOffset = 0;
      return;
    }

    if (this.baselineInnerHeight <= 0) {
      this.baselineInnerHeight = window.innerHeight;
    }

    const layoutResizeAmount = Math.max(0, this.baselineInnerHeight - window.innerHeight);
    this.nativeKeyboardOffset = Math.max(0, keyboardHeight - layoutResizeAmount);
  }

  private getKeyboardHeight(event: CapacitorKeyboardEvent): number {
    const directHeight = event.keyboardHeight;
    if (typeof directHeight === 'number' && Number.isFinite(directHeight)) {
      return Math.round(directHeight);
    }

    const detailHeight = event.detail?.keyboardHeight;
    if (typeof detailHeight === 'number' && Number.isFinite(detailHeight)) {
      return Math.round(detailHeight);
    }

    return 0;
  }

  private readCurrentOffset(): number {
    if (!this.root || typeof window === 'undefined') {
      return 0;
    }
    const rawOffset = window.getComputedStyle(this.root).getPropertyValue('--chat-keyboard-offset');
    const parsedOffset = Number.parseFloat(rawOffset);
    return Number.isFinite(parsedOffset) ? parsedOffset : 0;
  }

  private getKeyboardTop(): number | null {
    if (!this.root || typeof window === 'undefined') {
      return null;
    }

    if (window.visualViewport) {
      return window.visualViewport.height + window.visualViewport.offsetTop;
    }

    if (this.nativeKeyboardOffset > 0) {
      return this.root.getBoundingClientRect().bottom - this.nativeKeyboardOffset;
    }

    return null;
  }

  private updateEditorHeight(keyboardTop: number | null): void {
    if (!this.root || keyboardTop === null) {
      this.editorHeight = 0;
      this.root?.style.removeProperty('--chat-keyboard-editor-height');
      return;
    }

    const header = this.root.querySelector('.chat-header');
    const branchHeaderContainer = this.root.querySelector('.nexus-branch-header-container');
    const statusBarContainer = this.root.querySelector('.tool-status-bar-container');

    const headerBottom = header?.getBoundingClientRect().bottom ?? this.root.getBoundingClientRect().top;
    const branchBottom = branchHeaderContainer && branchHeaderContainer.childElementCount > 0
      ? branchHeaderContainer.getBoundingClientRect().bottom
      : headerBottom;
    const topBoundary = Math.max(headerBottom, branchBottom);
    const statusHeight = statusBarContainer?.getBoundingClientRect().height ?? 0;
    const availableHeight = keyboardTop - topBoundary - statusHeight - EDITOR_HEIGHT_BOTTOM_PADDING_PX;
    const clampedHeight = Math.max(EDITOR_HEIGHT_MIN_PX, Math.min(EDITOR_HEIGHT_MAX_PX, Math.round(availableHeight)));

    this.editorHeight = clampedHeight;
    this.root.style.setProperty('--chat-keyboard-editor-height', `${clampedHeight}px`);
  }
}
