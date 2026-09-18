import type { Component } from 'obsidian';
import { ManagedTimeoutTracker } from '../utils/ManagedTimeoutTracker';
import type { ToolStatusEntry } from '../types/ToolStatus';

export type { ToolStatusEntry };

/**
 * Single-line status ticker that STREAMS its text word-by-word, the way model
 * output streams — no ellipsis, no clipping. When the revealed text outgrows
 * the row, the line follows the newest word (scrolls left) so the reader is
 * always looking at the words being "typed".
 *
 * Once the reveal finishes, a line that does not fit the row does not park on
 * its tail: it rewinds to the head and carousels — hold, travel left at a
 * reading pace, hold, snap back — looping until the next entry replaces it, so
 * an uncapped goal sentence stays readable end to end. The loop is a pure CSS
 * animation (no per-frame timers); JS only measures the overflow and hands the
 * distance and duration to the stylesheet as custom properties.
 *
 * Sequencing contract: an entry always finishes — full reveal plus a short
 * dwell — before the next entry replaces it, no matter how mistimed the
 * incoming events are. While an entry plays, later entries collapse into a
 * single queued slot (latest wins), so the line never lags behind a fast
 * batch by more than one entry. A same-text update that only changes tense
 * (the goal flipping present→past) restyles the current line in place
 * instead of re-rolling it — and leaves the carousel running.
 */
export class ToolStatusLine {
  // Word-streaming cadence: ~11 words/s. A typical one-sentence goal
  // (8–12 words) plays in about a second; goal text is uncapped, so a
  // longer one simply streams longer.
  private static readonly WORD_MS = 90;
  // Minimum time a fully revealed entry holds the line before a queued
  // entry may replace it — fast tool batches stay legible.
  private static readonly DWELL_MS = 450;
  // Matches the CSS exit transition on .tool-status-text-*.exiting.
  private static readonly EXIT_MS = 200;

  // Carousel travel speed. Slow enough to read, brisk enough that a long
  // goal completes a lap while the tools it describes are still running.
  private static readonly MARQUEE_SPEED_PX_PER_S = 45;
  // Fraction of the cycle spent travelling — the remainder is the hold at
  // each end. Must match the keyframe stops of `tool-status-marquee`
  // (0%–15% head hold, 15%–85% travel, 85%–100% tail hold).
  private static readonly MARQUEE_TRAVEL_FRACTION = 0.7;
  // Floor on a full lap so a barely-overflowing line drifts instead of
  // twitching back and forth.
  private static readonly MARQUEE_MIN_CYCLE_MS = 3000;
  // Sub-pixel overflow is a rounding artifact, not text worth scrolling to.
  private static readonly MARQUEE_MIN_OVERFLOW_PX = 4;

  private currentSlot: HTMLElement | null = null;
  private currentText: HTMLElement | null = null;
  private currentEntry: ToolStatusEntry | null = null;
  private queuedEntry: ToolStatusEntry | null = null;
  private animating = false;
  private timeouts: ManagedTimeoutTracker;

  constructor(private readonly slot: HTMLElement, component: Component) {
    this.timeouts = new ManagedTimeoutTracker(component);
  }

  public update(text: string, state: ToolStatusEntry['state']): void {
    const entry: ToolStatusEntry = { text, state };
    // Compare against where the line is headed: the queued entry if one is
    // waiting, else what is currently playing/showing.
    const target = this.queuedEntry ?? this.currentEntry;

    if (target && target.text === text) {
      if (target.state === state) {
        return; // exact duplicate — never re-roll the same line
      }
      if (this.queuedEntry) {
        this.queuedEntry = entry; // upgrade the queued entry's tense
      } else {
        this.restyleCurrent(state); // tense flip on the visible line, in place
      }
      return;
    }

    if (this.animating) {
      // The playing entry must finish its reveal + dwell first; superseded
      // intermediates collapse into this single slot.
      this.queuedEntry = entry;
      return;
    }

    this.play(entry);
  }

  public clear(): void {
    this.timeouts.clear();
    this.queuedEntry = null;
    this.currentEntry = null;
    this.currentSlot = null;
    this.currentText = null;
    this.animating = false;
    // Remove every slot, including any mid-exit one whose scheduled removal
    // was just cancelled by timeouts.clear().
    const host = this.slot as HTMLElement & { empty?: () => void };
    if (typeof host.empty === 'function') {
      host.empty();
    }
  }

  /** Swap the tense class on the visible line without re-rolling it. */
  private restyleCurrent(state: ToolStatusEntry['state']): void {
    if (!this.currentEntry || !this.currentSlot) return;
    const previous = this.currentEntry.state;
    if (previous === state) return;
    this.currentEntry = { ...this.currentEntry, state };
    this.currentSlot.removeClass(`tool-status-text-${previous}`);
    this.currentSlot.addClass(`tool-status-text-${state}`);
  }

  private play(entry: ToolStatusEntry): void {
    this.animating = true;
    this.currentEntry = entry;

    if (this.currentSlot) {
      const oldSlot = this.currentSlot;
      oldSlot.classList.add('exiting');
      this.timeouts.schedule(() => oldSlot.remove(), ToolStatusLine.EXIT_MS);
    }

    const nextSlot = this.slot.createDiv({
      cls: `tool-status-text-${entry.state} entering`,
    });
    // The text lives in an inner element so the carousel can own `transform`
    // without fighting the slot's enter/exit translateY, and so the full text
    // stays available on hover for readers who get no carousel at all.
    const nextText = nextSlot.createSpan({ cls: 'tool-status-text-inner' });
    nextSlot.setAttribute('title', entry.text);
    this.currentSlot = nextSlot;
    this.currentText = nextText;
    this.timeouts.schedule(() => {
      nextSlot.removeClass('entering');
      nextSlot.addClass('active');
    }, 100);

    if (this.prefersReducedMotion()) {
      nextText.textContent = entry.text;
      this.finishReveal();
      return;
    }

    const words = entry.text.split(' ');
    let revealed = 0;
    const step = (): void => {
      // clear() or a newer play() detaches this slot — stop streaming into it.
      if (this.currentSlot !== nextSlot) return;
      revealed++;
      nextText.textContent = words.slice(0, revealed).join(' ');
      // Follow the words: once the line overflows the row, keep the newest
      // word in view instead of clipping the tail.
      nextSlot.scrollLeft = nextSlot.scrollWidth;
      if (revealed >= words.length) {
        this.finishReveal();
      } else {
        this.timeouts.schedule(step, ToolStatusLine.WORD_MS);
      }
    };
    step();
  }

  /** Full text is on screen — dwell, then hand the line to the queued entry. */
  private finishReveal(): void {
    this.timeouts.schedule(() => {
      this.animating = false;
      const next = this.queuedEntry;
      if (!next) {
        // Nothing waiting: the line is this entry's until a later call
        // replaces it, so give the reader the whole sentence on a loop.
        this.startMarquee();
        return;
      }
      this.queuedEntry = null;
      if (this.currentEntry && next.text === this.currentEntry.text) {
        this.restyleCurrent(next.state);
        this.startMarquee();
        return;
      }
      this.play(next);
    }, ToolStatusLine.DWELL_MS);
  }

  /**
   * Rewind the revealed line to its head and loop it through the row. A no-op
   * when the text already fits, when the row has no width (status bar
   * collapsed), or under reduced motion — the `title` attribute carries the
   * full text in those cases.
   */
  private startMarquee(): void {
    const outer = this.currentSlot;
    const inner = this.currentText;
    if (!outer || !inner) return;
    if (this.prefersReducedMotion()) return;
    if (inner.hasClass?.('tool-status-marquee')) return; // already looping

    const rowWidth = outer.clientWidth;
    const textWidth = inner.scrollWidth;
    if (!rowWidth || !textWidth) return;

    const overflow = textWidth - rowWidth;
    if (!(overflow > ToolStatusLine.MARQUEE_MIN_OVERFLOW_PX)) return;

    const travelMs = (overflow / ToolStatusLine.MARQUEE_SPEED_PX_PER_S) * 1000;
    const cycleMs = Math.max(
      ToolStatusLine.MARQUEE_MIN_CYCLE_MS,
      travelMs / ToolStatusLine.MARQUEE_TRAVEL_FRACTION
    );

    // The reveal left the row scrolled to the tail; the loop drives the text
    // with `transform`, so hand it back a row scrolled to the head.
    outer.scrollLeft = 0;
    inner.style.setProperty('--tool-status-marquee-shift', `${-Math.round(overflow)}px`);
    inner.style.setProperty('--tool-status-marquee-duration', `${Math.round(cycleMs)}ms`);
    inner.addClass('tool-status-marquee');
  }

  private prefersReducedMotion(): boolean {
    try {
      return window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ?? false;
    } catch {
      return false;
    }
  }
}
