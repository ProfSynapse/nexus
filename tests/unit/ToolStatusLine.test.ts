/**
 * ToolStatusLine — word-streaming ticker behavior.
 *
 * The line streams entries word-by-word (no ellipsis; it follows the newest
 * word past the row edge via scrollLeft) and guarantees an entry finishes —
 * full reveal plus dwell — before the next replaces it, however mistimed the
 * incoming events are. While one entry plays, later ones collapse into a
 * single queued slot (latest wins). A same-text tense flip restyles the
 * visible line in place instead of re-rolling it. Once a revealed line that
 * overflows the row has no successor waiting, it repeats continuously so the whole sentence stays readable.
 * Layout dimensions below are fixtures; browser checks verify CSS continuity.
 */

import { Component, createMockElement } from 'obsidian';
import { ToolStatusLine } from '../../src/ui/chat/components/toolStatusLine';

const WORD_MS = 90;
const DWELL_MS = 450;

/** The clipping row contains a moving track with one or two text copies. */
function trackOf(outer: HTMLElement): HTMLElement {
  return (outer.createSpan as jest.Mock).mock.results[0].value as HTMLElement;
}

function innerOf(outer: HTMLElement): HTMLElement {
  return (trackOf(outer).createSpan as jest.Mock).mock.results[0].value as HTMLElement;
}

/** Give a played line real geometry so the overflow measurement can run. */
function measure(outer: HTMLElement, rowWidth: number, textWidth: number): void {
  (outer as unknown as { clientWidth: number }).clientWidth = rowWidth;
  (innerOf(outer) as unknown as { scrollWidth: number }).scrollWidth = textWidth;
  // Simulate the two-copy layout; real CSS geometry is checked in a browser.
  trackOf(outer).getBoundingClientRect = jest.fn(() => ({ width: 2 * (textWidth + 32) } as DOMRect));
}

/**
 * Stand in for the ResizeObserver the line uses to track the row's width.
 * jsdom has none, and ToolStatusLine guards on `typeof ResizeObserver`, so
 * without this the resize path is simply inert.
 */
function stubResizeObserver() {
  const callbacks: Array<() => void> = [];
  const observed: unknown[] = [];
  const disconnect = jest.fn();
  class StubResizeObserver {
    constructor(cb: () => void) { callbacks.push(cb); }
    observe(target: unknown) { observed.push(target); }
    unobserve() { /* unused */ }
    disconnect() { disconnect(); }
  }
  const previous = (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = StubResizeObserver;
  return {
    observed,
    disconnect,
    fire: () => callbacks.forEach(cb => cb()),
    restore: () => { (globalThis as { ResizeObserver?: unknown }).ResizeObserver = previous; }
  };
}

function makeLine() {
  const slot = createMockElement('div');
  const component = new Component();
  component.load(); // Obsidian only runs cleanups for a loaded component.
  const line = new ToolStatusLine(slot, component);
  const createdSlots = () =>
    (slot.createDiv as jest.Mock).mock.results.map(r => r.value as HTMLElement);
  const createdTexts = () => createdSlots().map(innerOf);
  return { slot, line, component, createdSlots, createdTexts };
}

describe('ToolStatusLine — word streaming', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('reveals the text word by word at the streaming cadence', () => {
    const { line, createdTexts } = makeLine();

    line.update('one two three', 'present');

    const [el] = createdTexts();
    expect(el.textContent).toBe('one');

    jest.advanceTimersByTime(WORD_MS);
    expect(el.textContent).toBe('one two');

    jest.advanceTimersByTime(WORD_MS);
    expect(el.textContent).toBe('one two three');
  });

  it('follows the newest word by scrolling the line as it streams', () => {
    const { line, createdSlots } = makeLine();

    line.update('alpha beta', 'present');
    const [el] = createdSlots();

    // scrollWidth is undefined on the mock; the behavior under test is that
    // every reveal step re-anchors scrollLeft to scrollWidth.
    (el as unknown as { scrollWidth: number }).scrollWidth = 500;
    jest.advanceTimersByTime(WORD_MS);
    expect((el as unknown as { scrollLeft: number }).scrollLeft).toBe(500);
  });

  it('ignores an exact duplicate instead of re-rolling the line', () => {
    const { line, createdSlots } = makeLine();

    line.update('same text', 'present');
    jest.advanceTimersByTime(WORD_MS * 2 + DWELL_MS);

    line.update('same text', 'present');
    jest.advanceTimersByTime(WORD_MS * 2 + DWELL_MS);

    expect(createdSlots()).toHaveLength(1);
  });
});

describe('ToolStatusLine — finish before moving on', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('lets the current entry finish its reveal + dwell before the next plays, even when the next arrives immediately', () => {
    const { line, createdSlots } = makeLine();

    line.update('alpha beta', 'present');
    line.update('gamma', 'present'); // arrives mid-reveal — mistimed on purpose

    // Still streaming the first entry
    jest.advanceTimersByTime(WORD_MS - 1);
    expect(createdSlots()).toHaveLength(1);
    const [first] = createdSlots();

    // First entry completes its words…
    jest.advanceTimersByTime(1);
    expect(innerOf(first).textContent).toBe('alpha beta');
    expect(createdSlots()).toHaveLength(1);

    // …and only after the dwell does the queued entry take the line.
    jest.advanceTimersByTime(DWELL_MS - 1);
    expect(createdSlots()).toHaveLength(1);
    jest.advanceTimersByTime(1);

    const slots = createdSlots();
    expect(slots).toHaveLength(2);
    expect(innerOf(slots[1]).textContent).toBe('gamma');
  });

  it('collapses superseded intermediates: only the latest queued entry plays', () => {
    const { line, createdSlots } = makeLine();

    line.update('first entry', 'present');
    line.update('second entry', 'present');
    line.update('third entry', 'present');

    // Play out the first entry (2 words) + dwell, then the queued one fully.
    jest.advanceTimersByTime(WORD_MS + DWELL_MS + WORD_MS * 2 + DWELL_MS);

    const slots = createdSlots();
    expect(slots).toHaveLength(2);
    expect(innerOf(slots[1]).textContent).toBe('third entry');
  });

  it('restyles a same-text tense flip in place instead of re-rolling', () => {
    const { line, createdSlots } = makeLine();

    line.update('Reorganize the archive', 'present');
    jest.advanceTimersByTime(WORD_MS * 3 + DWELL_MS);

    line.update('Reorganize the archive', 'past');

    expect(createdSlots()).toHaveLength(1);
    const [el] = createdSlots();
    expect(el.removeClass).toHaveBeenCalledWith('tool-status-text-present');
    expect(el.addClass).toHaveBeenCalledWith('tool-status-text-past');
  });
});

describe('ToolStatusLine — clear', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('stops a stream mid-reveal and empties the host slot', () => {
    const { slot, line, createdTexts } = makeLine();

    line.update('one two three four', 'present');
    const [el] = createdTexts();
    expect(el.textContent).toBe('one');

    line.clear();
    expect(slot.empty).toHaveBeenCalled();

    // Cancelled: no further words are written
    jest.advanceTimersByTime(WORD_MS * 5);
    expect(el.textContent).toBe('one');
  });

  it('starts fresh after clear', () => {
    const { line, createdTexts } = makeLine();

    line.update('before clear', 'present');
    line.clear();

    line.update('after clear', 'present');
    const texts = createdTexts();
    expect(texts[texts.length - 1].textContent).toBe('after');
  });
});

describe('ToolStatusLine — continuous carousel', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('repeats the complete text once, hidden from screen readers, and loops the full copy distance', () => {
    const { line, createdSlots } = makeLine();
    const goal = 'a goal far wider than the row';
    line.update(goal, 'present');
    const [outer] = createdSlots();
    measure(outer, 200, 500);
    const track = trackOf(outer);

    jest.advanceTimersByTime(WORD_MS * 6);
    expect(track.createSpan).toHaveBeenCalledTimes(1);
    expect(track.addClass).not.toHaveBeenCalledWith('tool-status-marquee');

    jest.advanceTimersByTime(DWELL_MS);
    expect(track.createSpan).toHaveBeenLastCalledWith({
      cls: 'tool-status-text-inner', text: goal, attr: { 'aria-hidden': 'true' },
    });
    expect(track.addClass).toHaveBeenCalledWith('tool-status-marquee');
    expect((outer as unknown as { scrollLeft: number }).scrollLeft).toBe(0);
    // The lap covers a whole copy plus its 32px gap at 45px/s, with no holds.
    expect(track.style.setProperty).toHaveBeenCalledWith('--tool-status-marquee-duration', '11822ms');

    jest.advanceTimersByTime(60_000);
    expect(track.createSpan).toHaveBeenCalledTimes(2);
    expect(createdSlots()).toHaveLength(1);
  });

  it('floors the lap time for a short overflowing line', () => {
    const { line, createdSlots } = makeLine();
    line.update('just over', 'present');
    measure(createdSlots()[0], 50, 70);
    jest.advanceTimersByTime(WORD_MS + DWELL_MS);
    expect(trackOf(createdSlots()[0]).style.setProperty).toHaveBeenCalledWith(
      '--tool-status-marquee-duration', '3000ms'
    );
  });

  it('leaves a line that fits the row alone', () => {
    const { line, createdSlots } = makeLine();
    line.update('short goal', 'present');
    measure(createdSlots()[0], 400, 402);
    jest.advanceTimersByTime(WORD_MS + DWELL_MS);
    const track = trackOf(createdSlots()[0]);
    expect(track.addClass).not.toHaveBeenCalledWith('tool-status-marquee');
    expect(track.createSpan).toHaveBeenCalledTimes(1);
  });

  it('does not loop a line that is about to be replaced', () => {
    const { line, createdSlots } = makeLine();
    line.update('first long goal', 'present');
    measure(createdSlots()[0], 100, 500);
    line.update('second long goal', 'present');
    jest.advanceTimersByTime(WORD_MS * 3 + DWELL_MS);
    expect(trackOf(createdSlots()[0]).addClass).not.toHaveBeenCalledWith('tool-status-marquee');
    expect(createdSlots()).toHaveLength(2);
  });

  it('keeps the same track and copies across duplicate events and tense flips', () => {
    const { line, createdSlots } = makeLine();
    const goal = 'a goal far wider than the row';
    line.update(goal, 'present');
    const [outer] = createdSlots();
    measure(outer, 200, 500);
    jest.advanceTimersByTime(WORD_MS * 7 + DWELL_MS);
    const track = trackOf(outer);
    (track.addClass as jest.Mock).mockClear();
    (track.style.setProperty as jest.Mock).mockClear();

    line.update(goal, 'present');
    line.update(goal, 'past');
    expect(createdSlots()).toHaveLength(1);
    expect(outer.addClass).toHaveBeenCalledWith('tool-status-text-past');
    expect(track.createSpan).toHaveBeenCalledTimes(2);
    expect(track.addClass).not.toHaveBeenCalled();
    expect(track.style.setProperty).not.toHaveBeenCalled();
  });

  it('replaces the looping entry when a new tool status arrives', () => {
    const { line, createdSlots } = makeLine();
    line.update('first long goal', 'present');
    const [first] = createdSlots();
    measure(first, 100, 500);
    jest.advanceTimersByTime(WORD_MS * 3 + DWELL_MS);
    line.update('next tool', 'present');
    jest.advanceTimersByTime(WORD_MS);
    expect(innerOf(createdSlots()[1]).textContent).toBe('next tool');
    expect(first.classList.add).toHaveBeenCalledWith('exiting');
    jest.advanceTimersByTime(200);
    expect(first.remove).toHaveBeenCalled();
  });

  it('skips the carousel under reduced motion and exposes the full text on the row', () => {
    (window as unknown as { matchMedia: unknown }).matchMedia = jest.fn().mockReturnValue({ matches: true });
    try {
      const { line, createdSlots } = makeLine();
      line.update('a goal far wider than the row', 'present');
      const [outer] = createdSlots();
      measure(outer, 200, 500);
      jest.advanceTimersByTime(DWELL_MS);
      expect(innerOf(outer).textContent).toBe('a goal far wider than the row');
      expect(trackOf(outer).createSpan).toHaveBeenCalledTimes(1);
      expect(trackOf(outer).addClass).not.toHaveBeenCalledWith('tool-status-marquee');
      expect(outer.setAttribute).toHaveBeenCalledWith('title', 'a goal far wider than the row');
    } finally {
      (window as unknown as { matchMedia: unknown }).matchMedia = undefined;
    }
  });
});

describe('ToolStatusLine — carousel follows the row width', () => {
  const RESIZE_SETTLE_MS = 150;
  let resize: ReturnType<typeof stubResizeObserver>;

  beforeEach(() => {
    jest.useFakeTimers();
    resize = stubResizeObserver();
  });
  afterEach(() => {
    resize.restore();
    jest.useRealTimers();
  });

  function looping(rowWidth: number, textWidth: number) {
    const line = makeLine();
    line.line.update('a goal far wider than the row', 'present');
    const [outer] = line.createdSlots();
    measure(outer, rowWidth, textWidth);
    jest.advanceTimersByTime(WORD_MS * 7 + DWELL_MS);
    return { ...line, outer, track: trackOf(outer) };
  }

  it('observes the row the line is drawn into', () => {
    const { slot } = makeLine();
    expect(resize.observed).toEqual([slot]);
  });

  it('keeps the same lap and speed when the pane narrows or its height changes', () => {
    const { outer, track } = looping(200, 500);
    (track.style.setProperty as jest.Mock).mockClear();
    measure(outer, 120, 500);
    resize.fire();
    jest.advanceTimersByTime(RESIZE_SETTLE_MS);
    resize.fire();
    jest.advanceTimersByTime(RESIZE_SETTLE_MS);
    // Viewport width does not change the distance between repeated copies.
    expect(track.style.setProperty).not.toHaveBeenCalled();
    expect(track.createSpan).toHaveBeenCalledTimes(2);
  });

  it('removes the repeated copy when the pane widens enough, then can loop again', () => {
    const { outer, track } = looping(200, 500);
    const repeat = (track.createSpan as jest.Mock).mock.results[1].value as HTMLElement;
    measure(outer, 520, 500);
    resize.fire();
    jest.advanceTimersByTime(RESIZE_SETTLE_MS);
    expect(track.removeClass).toHaveBeenCalledWith('tool-status-marquee');
    expect(track.style.removeProperty).toHaveBeenCalledWith('--tool-status-marquee-duration');
    expect(repeat.remove).toHaveBeenCalled();

    measure(outer, 200, 500);
    resize.fire();
    jest.advanceTimersByTime(RESIZE_SETTLE_MS);
    expect(track.createSpan).toHaveBeenCalledTimes(3);
    expect(track.addClass).toHaveBeenLastCalledWith('tool-status-marquee');
  });

  it('starts looping when a row that had no width gets one', () => {
    const { line, createdSlots } = makeLine();
    line.update('a goal far wider than the row', 'present');
    const [outer] = createdSlots();
    measure(outer, 0, 500);
    jest.advanceTimersByTime(WORD_MS * 7 + DWELL_MS);
    expect(trackOf(outer).addClass).not.toHaveBeenCalledWith('tool-status-marquee');
    measure(outer, 200, 500);
    resize.fire();
    jest.advanceTimersByTime(RESIZE_SETTLE_MS);
    expect(trackOf(outer).addClass).toHaveBeenCalledWith('tool-status-marquee');
    expect((outer as unknown as { scrollLeft: number }).scrollLeft).toBe(0);
  });

  it('ignores a resize mid-reveal and measures after the reveal ends', () => {
    const { line, createdSlots } = makeLine();
    line.update('a goal far wider than the row', 'present');
    const [outer] = createdSlots();
    measure(outer, 200, 500);
    jest.advanceTimersByTime(WORD_MS * 2);
    resize.fire();
    jest.advanceTimersByTime(RESIZE_SETTLE_MS);
    expect(trackOf(outer).addClass).not.toHaveBeenCalledWith('tool-status-marquee');
    jest.advanceTimersByTime(WORD_MS * 7 + DWELL_MS);
    expect(trackOf(outer).addClass).toHaveBeenCalledWith('tool-status-marquee');
  });

  it('disconnects the observer when the owning component unloads', () => {
    const { component } = makeLine();
    component.unload();
    expect(resize.disconnect).toHaveBeenCalled();
  });
});
