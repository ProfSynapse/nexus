/**
 * WorkingIndicatorController - drives the "still working" ticker during the
 * silent gaps of a streaming turn (e.g. while tools execute, which do NOT
 * stream, unlike text).
 *
 * Why this exists
 * ---------------
 * The in-bubble ThinkingLoader is rendered inside `.message-content`. The
 * moment the first text token arrives, StreamingController.startStreaming →
 * MarkdownRenderer.initializeStreamingParser calls `container.empty()`, which
 * wipes that loader from the DOM (see MarkdownRenderer.ts). After that nothing
 * reinstates a "working" signal during the tool-execution gaps of an agentic
 * turn, so the ticker visibly "stops once it starts generating" and never
 * returns while tools run.
 *
 * This controller decides WHEN a "still working" ticker should be visible. The
 * ticker itself is rendered in-bubble by MessageBubble (so it stays attached to
 * the message and survives reconciliation); the controller only toggles it via
 * the show/hide callbacks, passing the streaming message id.
 *
 * State machine (a single generation is active at a time)
 * -------------------------------------------------------
 * - begin():           a turn started. We stay idle — the bubble's own loader
 *                      already covers the pre-first-token wait (and any leading
 *                      tool calls before text), so we do nothing until text
 *                      actually starts to avoid toggling a ticker the bubble is
 *                      already showing.
 * - noteText(id):      a text chunk arrived. Hide the ticker (text is visible)
 *                      and arm a debounce; if no further text arrives within
 *                      GAP_DELAY_MS we treat the silence as a gap and show the
 *                      ticker. This is the provider-agnostic path that works
 *                      even when a provider emits no tool events (some local
 *                      models).
 * - noteToolActivity(id): a tool was detected / started executing. If text has
 *                      already started, show the ticker immediately — more
 *                      responsive than waiting out the debounce. Ignored before
 *                      the first token (the bubble's loader covers that).
 * - end():             the turn finished / aborted / errored. Hide and disarm.
 */
export interface WorkingIndicatorEvents {
  show: (messageId: string) => void;
  hide: (messageId: string) => void;
}

export class WorkingIndicatorController {
  // Debounce window after the last text chunk before we treat the silence as a
  // gap. Tuned above the typical inter-token delay of choppy local models so
  // the ticker does not flicker mid-sentence, while staying well under the
  // multi-second latency of a tool round-trip / continuation request.
  private static readonly GAP_DELAY_MS = 800;

  private active = false;
  private hasText = false;
  private shown = false;
  private messageId: string | null = null;
  private gapTimer: number | null = null;

  constructor(private readonly events: WorkingIndicatorEvents) {}

  /** A new generation has begun. */
  begin(): void {
    this.active = true;
    this.hasText = false;
    this.messageId = null;
    this.shown = false;
    this.clearGapTimer();
  }

  /** A streamed text chunk arrived for the active turn. */
  noteText(messageId: string): void {
    if (!this.active) return;
    this.messageId = messageId;

    if (!this.hasText) {
      // First token: the bubble showed its own pre-text ticker (on isLoading).
      // Force it down — even though the controller never "showed" it — so a
      // mid-stream reconcile does not re-stamp the ticker over streaming text.
      this.hasText = true;
      this.shown = false;
      this.events.hide(messageId);
    } else {
      this.hideTicker();
    }

    this.armGapTimer();
  }

  /** A tool was detected or started executing for the active turn. */
  noteToolActivity(messageId: string): void {
    if (!this.active || !this.hasText) return;
    this.messageId = messageId;
    this.clearGapTimer();
    this.showTicker();
  }

  /** The active generation completed, aborted, or errored. */
  end(): void {
    this.active = false;
    this.hasText = false;
    this.clearGapTimer();
    this.hideTicker();
    this.messageId = null;
  }

  cleanup(): void {
    this.end();
  }

  private armGapTimer(): void {
    this.clearGapTimer();
    this.gapTimer = window.setTimeout(() => {
      this.gapTimer = null;
      if (this.active && this.hasText) {
        this.showTicker();
      }
    }, WorkingIndicatorController.GAP_DELAY_MS);
  }

  private clearGapTimer(): void {
    if (this.gapTimer !== null) {
      window.clearTimeout(this.gapTimer);
      this.gapTimer = null;
    }
  }

  private showTicker(): void {
    if (this.shown || !this.messageId) return;
    this.shown = true;
    this.events.show(this.messageId);
  }

  private hideTicker(): void {
    if (!this.shown || !this.messageId) return;
    this.shown = false;
    this.events.hide(this.messageId);
  }
}
