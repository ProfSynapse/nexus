/**
 * generateSessionId (#214, docs/plans/session-sticky-context-plan.md PR 4).
 *
 * The id format `s-YYYYMMDDhhmmss` has one-second resolution. Live, two
 * sessions created in the same second (`nexus-cli` on an unbound call, then
 * `--session live-check`) both got `s-20260912194746`; the second
 * `createSession` was a no-op and two handles pointed at one record. Ids must
 * be strictly increasing within a process while keeping the exact format that
 * `isStandardSessionId` (and everything keyed off it) depends on.
 *
 * Each test loads a fresh copy of the module so the "last issued id" state
 * starts empty; the clock is pinned with modern fake timers, which drive
 * `Date.now()`.
 */

type SessionUtils = typeof import('../../src/utils/sessionUtils');

function loadFresh(): SessionUtils {
  let mod: SessionUtils | undefined;
  jest.isolateModules(() => {
    mod = jest.requireActual<SessionUtils>('../../src/utils/sessionUtils');
  });
  if (!mod) throw new Error('module did not load');
  return mod;
}

const STANDARD = /^s-\d{14}$/;

describe('generateSessionId', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('two calls in the same second yield different ids, both standard, the second greater', () => {
    jest.useFakeTimers({ now: Date.UTC(2026, 8, 12, 19, 47, 46, 120) });
    const { generateSessionId, isStandardSessionId } = loadFresh();

    const first = generateSessionId();
    jest.setSystemTime(Date.UTC(2026, 8, 12, 19, 47, 46, 880)); // same second
    const second = generateSessionId();

    expect(first).toBe('s-20260912194746');
    expect(second).toBe('s-20260912194747');
    expect(first).toMatch(STANDARD);
    expect(second).toMatch(STANDARD);
    expect(isStandardSessionId(first)).toBe(true);
    expect(isStandardSessionId(second)).toBe(true);
    expect(second > first).toBe(true);
  });

  it('a call in a later second uses the clock, not the counter', () => {
    jest.useFakeTimers({ now: Date.UTC(2026, 8, 12, 19, 47, 46) });
    const { generateSessionId } = loadFresh();

    expect(generateSessionId()).toBe('s-20260912194746');
    jest.setSystemTime(Date.UTC(2026, 8, 12, 19, 47, 49));
    expect(generateSessionId()).toBe('s-20260912194749');
  });

  it('a burst of N calls in one second yields N distinct, strictly increasing ids', () => {
    jest.useFakeTimers({ now: Date.UTC(2026, 8, 12, 19, 47, 46) });
    const { generateSessionId } = loadFresh();

    const ids = Array.from({ length: 5 }, () => generateSessionId());

    expect(new Set(ids).size).toBe(5);
    for (let i = 1; i < ids.length; i += 1) {
      expect(ids[i] > ids[i - 1]).toBe(true);
      expect(ids[i]).toMatch(STANDARD);
    }
  });

  it('carries the bump across the minute, hour, day, month and year boundaries', () => {
    jest.useFakeTimers({ now: Date.UTC(2026, 11, 31, 23, 59, 59) });
    const { generateSessionId } = loadFresh();

    expect(generateSessionId()).toBe('s-20261231235959');
    expect(generateSessionId()).toBe('s-20270101000000');
  });

  it('a clock that moves backwards (after the bump ran ahead) still never repeats an id', () => {
    jest.useFakeTimers({ now: Date.UTC(2026, 8, 12, 19, 47, 46) });
    const { generateSessionId } = loadFresh();

    const a = generateSessionId(); // :46
    const b = generateSessionId(); // :47 (ahead of the clock)
    jest.setSystemTime(Date.UTC(2026, 8, 12, 19, 47, 47, 500)); // clock catches up to :47
    const c = generateSessionId();

    expect([a, b, c]).toEqual(['s-20260912194746', 's-20260912194747', 's-20260912194748']);
  });
});

describe('isStandardSessionId', () => {
  it('accepts exactly s- plus 14 digits and nothing else', () => {
    const { isStandardSessionId } = loadFresh();
    expect(isStandardSessionId('s-20260912194746')).toBe(true);
    expect(isStandardSessionId('s-2026091219474')).toBe(false);
    expect(isStandardSessionId('s-202609121947461')).toBe(false);
    expect(isStandardSessionId('nexus-cli')).toBe(false);
    expect(isStandardSessionId('S-20260912194746')).toBe(false);
  });
});
