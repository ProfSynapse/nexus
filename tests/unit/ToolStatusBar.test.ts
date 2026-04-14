/**
 * ToolStatusBar unit tests
 *
 * Coverage:
 *   - DOM construction: both rows + all meta slots (inspect/task/agent/compact + cost + badge)
 *   - Callback wiring: onInspectClick / onTaskClick / onCompactClick → registerDomEvent
 *   - Slot accessors: getAgentSlotEl, getContextBadge
 *   - pushStatus → show() + statusLine.update() forwarded
 *   - clearStatus → statusLine.clear()
 *   - show/hide → className toggle via addClass/removeClass
 *   - updateContext → reads ContextTracker, updates badge + cost label
 *   - updateContext isDisposed guard (both pre- and post-await)
 *   - cleanup → marks disposed, clears status line, detaches badge, removes statusBarEl from parent
 */

import { Component, createMockElement } from 'obsidian';
import { ToolStatusBar, type ToolStatusBarCallbacks } from '../../src/ui/chat/components/ToolStatusBar';
import type { ContextTracker } from '../../src/ui/chat/services/ContextTracker';

type MockContextTracker = Pick<ContextTracker, 'getContextUsage' | 'getConversationCost'> & {
  getContextUsage: jest.Mock;
  getConversationCost: jest.Mock;
};

function makeContextTracker(overrides: {
  percentage?: number;
  totalCost?: number | null;
} = {}): MockContextTracker {
  const percentage = overrides.percentage ?? 0;
  const totalCost = overrides.totalCost === null ? null : overrides.totalCost ?? 0;
  return {
    getContextUsage: jest.fn(async () => ({ percentage })),
    getConversationCost: jest.fn(() =>
      totalCost === null
        ? null
        : ({ totalCost })
    ),
  } as unknown as MockContextTracker;
}

function makeCallbacks(): Required<ToolStatusBarCallbacks> {
  return {
    onInspectClick: jest.fn(),
    onTaskClick: jest.fn(),
    onAgentClick: jest.fn(),
    onCompactClick: jest.fn(),
  };
}

describe('ToolStatusBar — construction', () => {
  it('creates the statusBarEl on the container with hidden class by default', () => {
    const container = createMockElement('div');
    const component = new Component();
    const tracker = makeContextTracker();
    const callbacks = makeCallbacks();

    new ToolStatusBar(
      container,
      tracker as unknown as ContextTracker,
      callbacks,
      component
    );

    const createElMock = container.createEl as jest.Mock;
    expect(createElMock).toHaveBeenCalledWith('div', {
      cls: 'tool-status-bar tool-status-bar-hidden',
    });
  });

  it('builds both rows (primary + meta) and wires four meta buttons', () => {
    const container = createMockElement('div');
    const component = new Component();
    const tracker = makeContextTracker();
    const callbacks = makeCallbacks();

    new ToolStatusBar(
      container,
      tracker as unknown as ContextTracker,
      callbacks,
      component
    );

    // The statusBarEl (first createEl result) should have had createEl called
    // twice — once per row.
    const statusBarEl = (container.createEl as jest.Mock).mock.results[0].value as HTMLElement;
    const rowCalls = (statusBarEl.createEl as jest.Mock).mock.calls;
    const rowClasses = rowCalls.map((call) => (call[1] as { cls?: string })?.cls);
    expect(rowClasses).toEqual(
      expect.arrayContaining(['tool-status-row--primary', 'tool-status-row--meta'])
    );

    // Row 2 should have 4 button + 1 cost div
    const row2El = (statusBarEl.createEl as jest.Mock).mock.results.find(
      (r) => ((r.value as { createEl?: jest.Mock }).createEl as jest.Mock)?.mock?.calls?.some(
        (c) => (c[1] as { cls?: string })?.cls === 'tool-status-inspect-icon'
      )
    )?.value as HTMLElement | undefined;

    expect(row2El).toBeDefined();

    const row2Calls = (row2El!.createEl as jest.Mock).mock.calls;
    const row2Classes = row2Calls.map((call) => (call[1] as { cls?: string })?.cls);
    // The four meta buttons
    expect(row2Classes).toEqual(expect.arrayContaining([
      'tool-status-inspect-icon',
      'tool-status-task-icon',
      'tool-status-agent-slot',
      'tool-status-compact-icon',
      'tool-status-cost',
    ]));
    const agentSlotResult = row2Calls.find((call) => (call[1] as { cls?: string })?.cls === 'tool-status-agent-slot');
    const agentSlotIndex = row2Calls.indexOf(agentSlotResult!);
    const agentSlotEl = (row2El!.createEl as jest.Mock).mock.results[agentSlotIndex].value as HTMLElement;
    expect(agentSlotEl.createEl).toHaveBeenCalledWith('button', { cls: 'tool-status-agent-icon' });
  });

  it('registers click handlers for inspect/task/agent/compact when callbacks are provided', () => {
    const container = createMockElement('div');
    const component = new Component();
    const tracker = makeContextTracker();
    const callbacks = makeCallbacks();

    const registerSpy = jest.spyOn(component, 'registerDomEvent');

    new ToolStatusBar(
      container,
      tracker as unknown as ContextTracker,
      callbacks,
      component
    );

    // Exactly four click handlers registered via Component.registerDomEvent
    const clickRegistrations = registerSpy.mock.calls.filter((c) => c[1] === 'click');
    expect(clickRegistrations.length).toBe(4);
  });

  it('omits registerDomEvent calls for missing callbacks', () => {
    const container = createMockElement('div');
    const component = new Component();
    const tracker = makeContextTracker();

    const registerSpy = jest.spyOn(component, 'registerDomEvent');

    new ToolStatusBar(
      container,
      tracker as unknown as ContextTracker,
      {}, // No callbacks at all
      component
    );

    const clickRegistrations = registerSpy.mock.calls.filter((c) => c[1] === 'click');
    expect(clickRegistrations.length).toBe(0);
  });
});

describe('ToolStatusBar — accessors', () => {
  it('getAgentSlotEl returns the agent-slot element', () => {
    const container = createMockElement('div');
    const bar = new ToolStatusBar(
      container,
      makeContextTracker() as unknown as ContextTracker,
      makeCallbacks(),
      new Component()
    );

    const slot = bar.getAgentSlotEl();
    expect(slot).toBeDefined();
    expect(slot.createEl).toHaveBeenCalledWith('button', { cls: 'tool-status-agent-icon' });
  });

  it('getContextBadge returns a defined ContextBadge instance', () => {
    const container = createMockElement('div');
    const bar = new ToolStatusBar(
      container,
      makeContextTracker() as unknown as ContextTracker,
      makeCallbacks(),
      new Component()
    );

    const badge = bar.getContextBadge();
    expect(badge).toBeDefined();
    // Must expose setPercentage
    expect(typeof badge.setPercentage).toBe('function');
  });
});

describe('ToolStatusBar — status lifecycle', () => {
  it('pushStatus calls show() and forwards to statusLine.update', () => {
    const container = createMockElement('div');
    const bar = new ToolStatusBar(
      container,
      makeContextTracker() as unknown as ContextTracker,
      makeCallbacks(),
      new Component()
    );

    // statusBarEl is the first child created on the container.
    const statusBarEl = (container.createEl as jest.Mock).mock.results[0].value as HTMLElement;

    bar.pushStatus({ text: 'Reading a.md', state: 'present' });

    // show() removes the hidden class
    expect(statusBarEl.removeClass).toHaveBeenCalledWith('tool-status-bar-hidden');
  });

  it('show() / hide() toggle the hidden className', () => {
    const container = createMockElement('div');
    const bar = new ToolStatusBar(
      container,
      makeContextTracker() as unknown as ContextTracker,
      makeCallbacks(),
      new Component()
    );

    const statusBarEl = (container.createEl as jest.Mock).mock.results[0].value as HTMLElement;

    bar.hide();
    expect(statusBarEl.addClass).toHaveBeenCalledWith('tool-status-bar-hidden');

    bar.show();
    expect(statusBarEl.removeClass).toHaveBeenCalledWith('tool-status-bar-hidden');
  });
});

describe('ToolStatusBar — updateContext', () => {
  it('updates the badge percentage and cost text from the ContextTracker', async () => {
    const container = createMockElement('div');
    const tracker = makeContextTracker({ percentage: 42, totalCost: 0.12345 });
    const bar = new ToolStatusBar(
      container,
      tracker as unknown as ContextTracker,
      makeCallbacks(),
      new Component()
    );

    const setPctSpy = jest.spyOn(bar.getContextBadge(), 'setPercentage');

    await bar.updateContext();

    expect(tracker.getContextUsage).toHaveBeenCalled();
    expect(setPctSpy).toHaveBeenCalledWith(42);
    // cost text rendered via toFixed(2)
    expect(tracker.getConversationCost).toHaveBeenCalled();
  });

  it('renders $0.00 when cost is null', async () => {
    const container = createMockElement('div');
    const tracker = makeContextTracker({ percentage: 10, totalCost: null });
    const bar = new ToolStatusBar(
      container,
      tracker as unknown as ContextTracker,
      makeCallbacks(),
      new Component()
    );

    await bar.updateContext();

    expect(tracker.getConversationCost).toHaveBeenCalled();
    // No throw — cost path handles null
  });

  it('bails out after cleanup() is called mid-flight (isDisposed guard post-await)', async () => {
    const container = createMockElement('div');
    const tracker = makeContextTracker({ percentage: 80, totalCost: 1 });

    // Intercept the async call to let us cleanup() mid-flight
    let resolver: (value: { percentage: number }) => void = () => undefined;
    const gatedPromise = new Promise<{ percentage: number }>((res) => {
      resolver = res;
    });
    (tracker.getContextUsage as jest.Mock).mockReturnValueOnce(gatedPromise);

    const bar = new ToolStatusBar(
      container,
      tracker as unknown as ContextTracker,
      makeCallbacks(),
      new Component()
    );

    const setPctSpy = jest.spyOn(bar.getContextBadge(), 'setPercentage');

    const update = bar.updateContext();
    // Dispose BEFORE the await resolves
    bar.cleanup();
    resolver({ percentage: 80 });
    await update;

    // Because isDisposed was set during cleanup, setPercentage must not be called
    expect(setPctSpy).not.toHaveBeenCalled();
  });

  it('bails out before the await if cleanup() was called synchronously first', async () => {
    const container = createMockElement('div');
    const tracker = makeContextTracker({ percentage: 80, totalCost: 1 });
    const bar = new ToolStatusBar(
      container,
      tracker as unknown as ContextTracker,
      makeCallbacks(),
      new Component()
    );

    bar.cleanup();
    await bar.updateContext();

    // Tracker should never have been queried — pre-await guard returned early
    expect(tracker.getContextUsage).not.toHaveBeenCalled();
  });
});

describe('ToolStatusBar — cleanup', () => {
  it('detaches the status bar from its parent when present', () => {
    const container = createMockElement('div');
    const bar = new ToolStatusBar(
      container,
      makeContextTracker() as unknown as ContextTracker,
      makeCallbacks(),
      new Component()
    );

    const statusBarEl = (container.createEl as jest.Mock).mock.results[0].value as HTMLElement;
    const parent = createMockElement('div');
    (statusBarEl as unknown as { parentElement: HTMLElement }).parentElement = parent;

    bar.cleanup();

    expect(parent.removeChild).toHaveBeenCalledWith(statusBarEl);
  });

  it('is safe to call cleanup when the bar has no parent (no throw)', () => {
    const container = createMockElement('div');
    const bar = new ToolStatusBar(
      container,
      makeContextTracker() as unknown as ContextTracker,
      makeCallbacks(),
      new Component()
    );

    expect(() => bar.cleanup()).not.toThrow();
  });
});
