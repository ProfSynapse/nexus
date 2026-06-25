/**
 * WorkingIndicatorController unit tests
 *
 * Covers the gap-ticker state machine that shows a "still working" indicator
 * during the silent parts of a streaming turn (e.g. while tools execute):
 *   - begin() stays idle (the in-bubble loader covers the pre-first-token wait)
 *   - noteText() hides immediately, then the debounce reveals the ticker in a gap
 *   - a fresh text chunk re-arms the debounce (no flicker mid-stream)
 *   - noteToolActivity() shows immediately, but only after text has started
 *   - end() hides and disarms (no late show after the turn finishes)
 *   - show/hide events do not fire redundantly
 *
 * Constraints:
 *   - Node test env has no `window` — shim setTimeout/clearTimeout
 *   - Use jest fake timers to drive the 800ms debounce deterministically
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

if (typeof (global as any).window === 'undefined') {
  (global as any).window = {};
}

// eslint-disable-next-line import/first
import { WorkingIndicatorController } from '../../src/ui/chat/controllers/WorkingIndicatorController';

const GAP_DELAY_MS = 800;

describe('WorkingIndicatorController', () => {
  let show: jest.Mock;
  let hide: jest.Mock;
  let controller: WorkingIndicatorController;

  beforeEach(() => {
    jest.useFakeTimers();
    // Route window.* timers to the (now faked) globals so advanceTimersByTime
    // drives the controller's debounce. Must run after useFakeTimers().
    (global as any).window.setTimeout = (fn: () => void, ms?: number) => setTimeout(fn, ms);
    (global as any).window.clearTimeout = (id: unknown) => clearTimeout(id as any);
    show = jest.fn();
    hide = jest.fn();
    controller = new WorkingIndicatorController({ show, hide });
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('begin() stays idle — the in-bubble loader covers the initial wait', () => {
    controller.begin();
    jest.advanceTimersByTime(GAP_DELAY_MS * 2);
    expect(show).not.toHaveBeenCalled();
  });

  it('shows the ticker after a gap once text has started', () => {
    controller.begin();
    controller.noteText();
    expect(show).not.toHaveBeenCalled(); // text just arrived — not a gap yet

    jest.advanceTimersByTime(GAP_DELAY_MS);
    expect(show).toHaveBeenCalledTimes(1);
  });

  it('re-arms the debounce on each text chunk (no mid-stream flicker)', () => {
    controller.begin();
    controller.noteText();
    jest.advanceTimersByTime(GAP_DELAY_MS - 100);
    controller.noteText(); // resets the timer before it could fire
    jest.advanceTimersByTime(GAP_DELAY_MS - 100);
    expect(show).not.toHaveBeenCalled();

    jest.advanceTimersByTime(100);
    expect(show).toHaveBeenCalledTimes(1);
  });

  it('hides immediately when text resumes after the ticker was shown', () => {
    controller.begin();
    controller.noteText();
    jest.advanceTimersByTime(GAP_DELAY_MS);
    expect(show).toHaveBeenCalledTimes(1);

    controller.noteText(); // continuation text arrived
    expect(hide).toHaveBeenCalledTimes(1);
  });

  it('noteToolActivity() shows immediately once text has started', () => {
    controller.begin();
    controller.noteText();
    controller.noteToolActivity();
    expect(show).toHaveBeenCalledTimes(1); // no need to wait out the debounce
  });

  it('noteToolActivity() is ignored before any text (bubble loader covers it)', () => {
    controller.begin();
    controller.noteToolActivity();
    expect(show).not.toHaveBeenCalled();
  });

  it('end() hides and disarms — no late show after the turn finishes', () => {
    controller.begin();
    controller.noteText();
    controller.end();
    jest.advanceTimersByTime(GAP_DELAY_MS * 2);
    expect(show).not.toHaveBeenCalled();
  });

  it('does not fire show/hide redundantly', () => {
    controller.begin();
    controller.noteText();
    jest.advanceTimersByTime(GAP_DELAY_MS);
    controller.noteToolActivity(); // already shown
    expect(show).toHaveBeenCalledTimes(1);

    controller.end();
    controller.end(); // already hidden
    expect(hide).toHaveBeenCalledTimes(1);
  });

  it('ignores stray signals when no turn is active', () => {
    controller.noteText();
    controller.noteToolActivity();
    jest.advanceTimersByTime(GAP_DELAY_MS * 2);
    expect(show).not.toHaveBeenCalled();
  });
});
