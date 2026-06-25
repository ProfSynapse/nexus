/**
 * WorkingIndicatorController unit tests
 *
 * Covers the gap-ticker state machine that shows a "still working" indicator
 * during the silent parts of a streaming turn (e.g. while tools execute):
 *   - begin() stays idle (the bubble's own loader covers the pre-first-token wait)
 *   - noteText() hides immediately, then the debounce reveals the ticker in a gap
 *   - a fresh text chunk re-arms the debounce (no flicker mid-stream)
 *   - noteToolActivity() shows immediately, but only after text has started
 *   - end() hides and disarms (no late show after the turn finishes)
 *   - show/hide events do not fire redundantly
 *   - show/hide carry the streaming message id (so the right bubble is targeted)
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
const MSG = 'ai-msg-1';

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

  it('begin() stays idle — the bubble loader covers the initial wait', () => {
    controller.begin();
    jest.advanceTimersByTime(GAP_DELAY_MS * 2);
    expect(show).not.toHaveBeenCalled();
  });

  it('shows the ticker after a gap once text has started', () => {
    controller.begin();
    controller.noteText(MSG);
    expect(show).not.toHaveBeenCalled(); // text just arrived — not a gap yet

    jest.advanceTimersByTime(GAP_DELAY_MS);
    expect(show).toHaveBeenCalledTimes(1);
    expect(show).toHaveBeenCalledWith(MSG);
  });

  it('re-arms the debounce on each text chunk (no mid-stream flicker)', () => {
    controller.begin();
    controller.noteText(MSG);
    jest.advanceTimersByTime(GAP_DELAY_MS - 100);
    controller.noteText(MSG); // resets the timer before it could fire
    jest.advanceTimersByTime(GAP_DELAY_MS - 100);
    expect(show).not.toHaveBeenCalled();

    jest.advanceTimersByTime(100);
    expect(show).toHaveBeenCalledTimes(1);
  });

  it('clears the bubble ticker on the first token (reconcile-safe handoff)', () => {
    controller.begin();
    controller.noteText(MSG); // first token forces the pre-text ticker down
    expect(hide).toHaveBeenCalledWith(MSG);
    expect(show).not.toHaveBeenCalled();
  });

  it('hides immediately when text resumes after the ticker was shown', () => {
    controller.begin();
    controller.noteText(MSG);
    jest.advanceTimersByTime(GAP_DELAY_MS);
    expect(show).toHaveBeenCalledTimes(1);

    const hidesBefore = hide.mock.calls.length;
    controller.noteText(MSG); // continuation text arrived
    expect(hide.mock.calls.length).toBe(hidesBefore + 1);
    expect(hide).toHaveBeenLastCalledWith(MSG);
  });

  it('noteToolActivity() shows immediately once text has started', () => {
    controller.begin();
    controller.noteText(MSG);
    controller.noteToolActivity(MSG);
    expect(show).toHaveBeenCalledTimes(1); // no need to wait out the debounce
    expect(show).toHaveBeenCalledWith(MSG);
  });

  it('noteToolActivity() is ignored before any text (bubble loader covers it)', () => {
    controller.begin();
    controller.noteToolActivity(MSG);
    expect(show).not.toHaveBeenCalled();
  });

  it('end() hides and disarms — no late show after the turn finishes', () => {
    controller.begin();
    controller.noteText(MSG);
    controller.end();
    jest.advanceTimersByTime(GAP_DELAY_MS * 2);
    expect(show).not.toHaveBeenCalled();
  });

  it('does not restart the ticker when already shown, and end hides once', () => {
    controller.begin();
    controller.noteText(MSG);
    jest.advanceTimersByTime(GAP_DELAY_MS);
    expect(show).toHaveBeenCalledTimes(1);
    controller.noteToolActivity(MSG); // already shown — no second show
    expect(show).toHaveBeenCalledTimes(1);

    const hidesBefore = hide.mock.calls.length;
    controller.end();
    controller.end(); // idempotent
    expect(hide.mock.calls.length).toBe(hidesBefore + 1);
  });

  it('ignores stray signals when no turn is active', () => {
    controller.noteText(MSG);
    controller.noteToolActivity(MSG);
    jest.advanceTimersByTime(GAP_DELAY_MS * 2);
    expect(show).not.toHaveBeenCalled();
  });
});
