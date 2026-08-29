/**
 * ToolStatusLine — word-streaming ticker behavior.
 *
 * The line streams entries word-by-word (no ellipsis; it follows the newest
 * word past the row edge via scrollLeft) and guarantees an entry finishes —
 * full reveal plus dwell — before the next replaces it, however mistimed the
 * incoming events are. While one entry plays, later ones collapse into a
 * single queued slot (latest wins). A same-text tense flip restyles the
 * visible line in place instead of re-rolling it.
 */

import { Component, createMockElement } from 'obsidian';
import { ToolStatusLine } from '../../src/ui/chat/components/toolStatusLine';

const WORD_MS = 90;
const DWELL_MS = 450;

function makeLine() {
  const slot = createMockElement('div');
  const component = new Component();
  const line = new ToolStatusLine(slot, component);
  const createdSlots = () =>
    (slot.createDiv as jest.Mock).mock.results.map(r => r.value as HTMLElement);
  return { slot, line, createdSlots };
}

describe('ToolStatusLine — word streaming', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('reveals the text word by word at the streaming cadence', () => {
    const { line, createdSlots } = makeLine();

    line.update('one two three', 'present');

    const [el] = createdSlots();
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
    expect(first.textContent).toBe('alpha beta');
    expect(createdSlots()).toHaveLength(1);

    // …and only after the dwell does the queued entry take the line.
    jest.advanceTimersByTime(DWELL_MS - 1);
    expect(createdSlots()).toHaveLength(1);
    jest.advanceTimersByTime(1);

    const slots = createdSlots();
    expect(slots).toHaveLength(2);
    expect(slots[1].textContent).toBe('gamma');
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
    expect(slots[1].textContent).toBe('third entry');
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
    const { slot, line, createdSlots } = makeLine();

    line.update('one two three four', 'present');
    const [el] = createdSlots();
    expect(el.textContent).toBe('one');

    line.clear();
    expect(slot.empty).toHaveBeenCalled();

    // Cancelled: no further words are written
    jest.advanceTimersByTime(WORD_MS * 5);
    expect(el.textContent).toBe('one');
  });

  it('starts fresh after clear', () => {
    const { line, createdSlots } = makeLine();

    line.update('before clear', 'present');
    line.clear();

    line.update('after clear', 'present');
    const slots = createdSlots();
    expect(slots[slots.length - 1].textContent).toBe('after');
  });
});
