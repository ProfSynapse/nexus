/**
 * ReadAloudProgressModal - Animated "reading aloud" progress modal.
 *
 * Reuses the live-voice visual language: a pulsing dot (.chat-live-dot) and a
 * row of waveform bars (.chat-live-wave-bar + .chat-live-wave-phase-N). The
 * animations are pure CSS (class-driven), so replicating the markup here with
 * the existing classes animates correctly without importing ChatInput — and
 * inherits the prefers-reduced-motion handling already in styles.css (FE-MINOR-1).
 *
 * The modal owns only its own display. The caller drives progress via
 * setProgress() and is notified of user dismissal via onDismiss — wiring the
 * dismiss to the backend session (stopPlayback + listener detach) lives in the
 * command manager, keeping this component free of session/backend coupling.
 */

import { App, Component, Modal } from 'obsidian';

// Number of waveform bars to render. Matches the phase-class cycle (0..11) used
// by the live-voice waveform; bars beyond 12 reuse the cycle via index % 12.
const WAVE_BAR_COUNT = 24;
const WAVE_PHASE_COUNT = 12;

export class ReadAloudProgressModal extends Modal {
  private modalEvents: Component | null = null;
  private statusEl: HTMLElement | null = null;
  private dismissed = true;

  constructor(
    app: App,
    private readonly title: string,
    private readonly onDismiss: () => void
  ) {
    super(app);
  }

  onOpen(): void {
    this.modalEvents = new Component();
    const { contentEl } = this;
    contentEl.addClass('read-aloud-progress');

    contentEl.createEl('h2', { text: 'Reading aloud…' });

    const visual = contentEl.createDiv('read-aloud-progress-visual');
    visual.createSpan('chat-live-dot');

    const waveform = visual.createDiv('chat-live-waveform');
    waveform.setAttribute('aria-hidden', 'true');
    for (let index = 0; index < WAVE_BAR_COUNT; index += 1) {
      const phase = index % WAVE_PHASE_COUNT;
      waveform.createSpan(`chat-live-wave-bar chat-live-wave-phase-${phase}`);
    }

    this.statusEl = contentEl.createDiv({
      cls: 'read-aloud-progress-status',
      text: this.title
    });
  }

  /**
   * Update the progress line. Called by the caller on each session progress
   * tick. No-op once the modal has been closed.
   */
  setProgress(done: number, total: number): void {
    if (!this.statusEl) {
      return;
    }
    this.statusEl.setText(
      total > 0 ? `${this.title} — ${done} of ${total}` : this.title
    );
  }

  /**
   * Close the modal programmatically without firing the user-dismiss callback
   * (e.g. when the session completes on its own).
   */
  finish(): void {
    this.dismissed = false;
    this.close();
  }

  onClose(): void {
    const { contentEl } = this;
    contentEl.empty();
    this.modalEvents?.unload();
    this.modalEvents = null;
    this.statusEl = null;

    // Only a USER dismissal (Esc / click-outside / close button) triggers the
    // stop-playback path; a programmatic finish() does not.
    if (this.dismissed) {
      this.onDismiss();
    }
  }
}
