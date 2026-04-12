/**
 * ContextBadge unit tests
 *
 * Plan mandates parametric boundary coverage for percentageToState via it.each.
 * Branch boundaries: 49/50, 74/75, 89/90 (SAFE/WARM/HOT/DANGER).
 *
 * Constraints:
 *   - No jest.useFakeTimers()
 *   - Node test env (not jsdom) — use mock.calls/mock.results for assertions
 */

import { createMockElement } from 'obsidian';
import { percentageToState, CONTEXT_THRESHOLDS } from '../../src/ui/chat/constants/ContextThresholds';
import { ContextBadge } from '../../src/ui/chat/components/ContextBadge';

describe('percentageToState — parametric boundary behavior', () => {
  it.each<[number, string]>([
    // SAFE band: [0, 49]
    [0, 'safe'],
    [1, 'safe'],
    [25, 'safe'],
    [49, 'safe'],
    // WARM band: (49, 74]
    [50, 'warm'],
    [60, 'warm'],
    [74, 'warm'],
    // HOT band: (74, 89]
    [75, 'hot'],
    [80, 'hot'],
    [89, 'hot'],
    // DANGER band: (89, ∞)
    [90, 'danger'],
    [95, 'danger'],
    [100, 'danger'],
    [150, 'danger'], // clamp is applied by caller, function itself accepts any
  ])('at %d%% returns "%s"', (pct, expected) => {
    expect(percentageToState(pct)).toBe(expected);
  });

  it('exposes threshold constants matching plan spec', () => {
    // Locks in the plan-defined boundaries so future drift is caught.
    expect(CONTEXT_THRESHOLDS.SAFE).toBe(49);
    expect(CONTEXT_THRESHOLDS.WARM).toBe(74);
    expect(CONTEXT_THRESHOLDS.HOT).toBe(89);
    expect(CONTEXT_THRESHOLDS.DANGER).toBe(100);
  });
});

describe('ContextBadge', () => {
  /** Retrieve the last element produced by container.createEl. */
  function getCreatedBadge(container: HTMLElement): HTMLElement {
    const mockCreateEl = container.createEl as jest.Mock;
    const results = mockCreateEl.mock.results;
    expect(results.length).toBeGreaterThan(0);
    return results[results.length - 1].value as HTMLElement;
  }

  it('creates a badge element on the container with safe default state', () => {
    const container = createMockElement('div');
    new ContextBadge(container);

    const createElMock = container.createEl as jest.Mock;
    expect(createElMock).toHaveBeenCalledTimes(1);

    const firstCall = createElMock.mock.calls[0];
    expect(firstCall[0]).toBe('div');
    expect(firstCall[1]).toEqual({ cls: 'context-badge context-badge-safe' });

    const badgeEl = getCreatedBadge(container);
    expect(badgeEl.textContent).toBe('0%');
  });

  it('updates className and textContent when setPercentage is called (safe band)', () => {
    const container = createMockElement('div');
    const badge = new ContextBadge(container);
    const badgeEl = getCreatedBadge(container);

    badge.setPercentage(30);

    expect(badgeEl.className).toBe('context-badge context-badge-safe');
    expect(badgeEl.textContent).toBe('30%');
  });

  it('transitions to warm band at exactly 50%', () => {
    const container = createMockElement('div');
    const badge = new ContextBadge(container);
    const badgeEl = getCreatedBadge(container);

    badge.setPercentage(50);

    expect(badgeEl.className).toBe('context-badge context-badge-warm');
    expect(badgeEl.textContent).toBe('50%');
  });

  it('transitions to hot band at exactly 75%', () => {
    const container = createMockElement('div');
    const badge = new ContextBadge(container);
    const badgeEl = getCreatedBadge(container);

    badge.setPercentage(75);

    expect(badgeEl.className).toBe('context-badge context-badge-hot');
    expect(badgeEl.textContent).toBe('75%');
  });

  it('transitions to danger band at exactly 90%', () => {
    const container = createMockElement('div');
    const badge = new ContextBadge(container);
    const badgeEl = getCreatedBadge(container);

    badge.setPercentage(90);

    expect(badgeEl.className).toBe('context-badge context-badge-danger');
    expect(badgeEl.textContent).toBe('90%');
  });

  it('clamps percentages > 100 down to 100 before rounding', () => {
    const container = createMockElement('div');
    const badge = new ContextBadge(container);
    const badgeEl = getCreatedBadge(container);

    badge.setPercentage(150);

    expect(badgeEl.className).toBe('context-badge context-badge-danger');
    expect(badgeEl.textContent).toBe('100%');
  });

  it('clamps negative percentages up to 0 before rounding', () => {
    const container = createMockElement('div');
    const badge = new ContextBadge(container);
    const badgeEl = getCreatedBadge(container);

    badge.setPercentage(-25);

    expect(badgeEl.className).toBe('context-badge context-badge-safe');
    expect(badgeEl.textContent).toBe('0%');
  });

  it('rounds fractional percentages for display', () => {
    const container = createMockElement('div');
    const badge = new ContextBadge(container);
    const badgeEl = getCreatedBadge(container);

    badge.setPercentage(49.6);

    // 49.6 clamps unchanged → severity checks 49.6 > 49 → warm band
    expect(badgeEl.className).toBe('context-badge context-badge-warm');
    // Rounded display: 50
    expect(badgeEl.textContent).toBe('50%');
  });

  it('supports multiple transitions without losing prior state tracking', () => {
    const container = createMockElement('div');
    const badge = new ContextBadge(container);
    const badgeEl = getCreatedBadge(container);

    badge.setPercentage(10);
    expect(badgeEl.className).toBe('context-badge context-badge-safe');

    badge.setPercentage(60);
    expect(badgeEl.className).toBe('context-badge context-badge-warm');

    badge.setPercentage(85);
    expect(badgeEl.className).toBe('context-badge context-badge-hot');

    badge.setPercentage(95);
    expect(badgeEl.className).toBe('context-badge context-badge-danger');

    badge.setPercentage(5);
    expect(badgeEl.className).toBe('context-badge context-badge-safe');
  });

  it('cleanup() removes the badge from its parent when parentElement is set', () => {
    const container = createMockElement('div');
    const badge = new ContextBadge(container);
    const badgeEl = getCreatedBadge(container);

    // Wire a parent — createMockElement defaults parentElement to null,
    // so we attach a fresh mock parent to exercise the removeChild branch.
    const parent = createMockElement('div');
    (badgeEl as unknown as { parentElement: HTMLElement }).parentElement = parent;

    badge.cleanup();

    expect(parent.removeChild).toHaveBeenCalledTimes(1);
    expect((parent.removeChild as jest.Mock).mock.calls[0][0]).toBe(badgeEl);
  });

  it('cleanup() is a no-op when badge has no parent', () => {
    const container = createMockElement('div');
    const badge = new ContextBadge(container);
    const badgeEl = getCreatedBadge(container);

    // parentElement is null by default in createMockElement.
    expect((badgeEl as unknown as { parentElement: HTMLElement | null }).parentElement).toBeNull();

    // Should not throw.
    expect(() => badge.cleanup()).not.toThrow();
  });
});
