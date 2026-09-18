/**
 * ToolStatusLine — word-streaming ticker behavior.
 *
 * The line streams entries word-by-word (no ellipsis; it follows the newest
 * word past the row edge via scrollLeft) and guarantees an entry finishes —
 * full reveal plus dwell — before the next replaces it, however mistimed the
 * incoming events are. While one entry plays, later ones collapse into a
 * single queued slot (latest wins). A same-text tense flip restyles the
 * visible line in place instead of re-rolling it. Once a revealed line that
 * overflows the row has no successor waiting, it rewinds and carousels on a
 * loop so the whole sentence stays readable.
 */

import { Component, createMockElement } from 'obsidian';
import { ToolStatusLine } from '../../src/ui/chat/components/toolStatusLine';

const WORD_MS = 90;
const DWELL_MS = 450;

/** The text lives in an inner span; the outer div is the clipping row. */
function innerOf(outer: HTMLElement): HTMLElement {
  return (outer.createSpan as jest.Mock).mock.results[0].value as HTMLElement;
}

/** Give a played line real geometry so the overflow measurement can run. */
function measure(outer: HTMLElement, rowWidth: number, textWidth: number): void {
  (outer as unknown as { clientWidth: number }).clientWidth = rowWidth;
  (innerOf(outer) as unknown as { scrollWidth: number }).scrollWidth = textWidth;
}

function makeLine() {
  const slot = createMockElement('div');
  const component = new Component();
  const line = new ToolStatusLine(slot, component);
  const createdSlots = () =>
    (slot.createDiv as jest.Mock).mock.results.map(r => r.value as HTMLElement);
  const createdTexts = () => createdSlots().map(innerOf);
  return { slot, line, createdSlots, createdTexts };
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

describe('ToolStatusLine — carousel', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('rewinds and loops a revealed line that outgrows the row', () => {
    const { line, createdSlots, createdTexts } = makeLine();

    line.update('a goal far wider than the row', 'present');
    const [outer] = createdSlots();
    measure(outer, 200, 500); // 300px of text hangs off the row

    // Mid-reveal the line is still following the newest word, not looping.
    jest.advanceTimersByTime(WORD_MS * 6);
    expect(createdTexts()[0].addClass).not.toHaveBeenCalledWith('tool-status-marquee');

    // Reveal done + dwell → the carousel takes over from the parked tail.
    jest.advanceTimersByTime(DWELL_MS);

    const [text] = createdTexts();
    expect(text.addClass).toHaveBeenCalledWith('tool-status-marquee');
    expect((outer as unknown as { scrollLeft: number }).scrollLeft).toBe(0);
    // 300px at 45px/s = 6.67s of travel, held either side → ~9.5s per lap.
    expect(text.style.setProperty).toHaveBeenCalledWith('--tool-status-marquee-shift', '-300px');
    expect(text.style.setProperty).toHaveBeenCalledWith(
      '--tool-status-marquee-duration',
      '9524ms'
    );
  });

  it('floors the lap time so a barely-overflowing line drifts instead of twitching', () => {
    const { line, createdSlots, createdTexts } = makeLine();

    line.update('just over', 'present');
    measure(createdSlots()[0], 200, 220);
    jest.advanceTimersByTime(WORD_MS + DWELL_MS);

    expect(createdTexts()[0].style.setProperty).toHaveBeenCalledWith(
      '--tool-status-marquee-duration',
      '3000ms'
    );
  });

  it('leaves a line that fits the row alone', () => {
    const { line, createdSlots, createdTexts } = makeLine();

    line.update('short goal', 'present');
    measure(createdSlots()[0], 400, 402); // 2px: rounding, not text
    jest.advanceTimersByTime(WORD_MS + DWELL_MS);

    expect(createdTexts()[0].addClass).not.toHaveBeenCalledWith('tool-status-marquee');
  });

  it('does not loop a line that is about to be replaced', () => {
    const { line, createdSlots, createdTexts } = makeLine();

    line.update('first long goal', 'present');
    measure(createdSlots()[0], 100, 500);
    line.update('second long goal', 'present'); // queued mid-reveal

    jest.advanceTimersByTime(WORD_MS * 3 + DWELL_MS);

    expect(createdTexts()[0].addClass).not.toHaveBeenCalledWith('tool-status-marquee');
    expect(createdSlots()).toHaveLength(2);
  });

  it('keeps looping across a tense flip instead of re-rolling the line', () => {
    const { line, createdSlots, createdTexts } = makeLine();

    line.update('a goal far wider than the row', 'present');
    const [outer] = createdSlots();
    measure(outer, 200, 500);
    jest.advanceTimersByTime(WORD_MS * 7 + DWELL_MS);

    const [text] = createdTexts();
    (text.addClass as jest.Mock).mockClear();

    line.update('a goal far wider than the row', 'past');

    expect(createdSlots()).toHaveLength(1); // same line, restyled in place
    expect(outer.addClass).toHaveBeenCalledWith('tool-status-text-past');
    // The loop lives on the inner element, so the tense swap never touches it.
    expect(text.addClass).not.toHaveBeenCalled();
  });

  it('skips the carousel under reduced motion and exposes the full text on the row', () => {
    const matchMedia = jest.fn().mockReturnValue({ matches: true });
    (window as unknown as { matchMedia: unknown }).matchMedia = matchMedia;

    const { line, createdSlots, createdTexts } = makeLine();
    line.update('a goal far wider than the row', 'present');
    const [outer] = createdSlots();
    measure(outer, 200, 500);
    jest.advanceTimersByTime(DWELL_MS);

    expect(createdTexts()[0].textContent).toBe('a goal far wider than the row');
    expect(createdTexts()[0].addClass).not.toHaveBeenCalledWith('tool-status-marquee');
    expect(outer.setAttribute).toHaveBeenCalledWith('title', 'a goal far wider than the row');

    (window as unknown as { matchMedia: unknown }).matchMedia = undefined;
  });
});
