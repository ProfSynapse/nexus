/**
 * StreamingController — getCurrentMessageId staleness regression.
 *
 * ToolStatusBarController drops every present-tense tool status whose
 * messageId differs from StreamingController.getCurrentMessageId(). That id
 * is derived from the streamingStates map, so a finalized turn whose entry
 * is not removed poisons the filter: every later turn's "Running…" labels
 * are silently discarded.
 *
 * The old cleanup ran only after an async markdown render AND only when the
 * message element was still in the DOM — a mid-stream conversation switch or
 * reconcile leaked the entry forever. finalizeStreaming must drop the entry
 * synchronously and unconditionally.
 */

jest.mock('../../src/ui/chat/utils/MarkdownRenderer', () => ({
  MarkdownRenderer: {
    initializeStreamingParser: jest.fn(() => ({ mock: 'streaming-state' })),
    writeStreamingChunk: jest.fn(),
    finalizeStreamingContent: jest.fn(() => Promise.resolve()),
  },
}));

import { StreamingController } from '../../src/ui/chat/controllers/StreamingController';
import { MarkdownRenderer } from '../../src/ui/chat/utils/MarkdownRenderer';
import type { App, Component } from 'obsidian';

interface FakeContentEl {
  getAttribute: () => string | null;
  parentElement: null;
}

function makeHarness() {
  const contentEl: FakeContentEl = {
    getAttribute: () => null,
    parentElement: null,
  };
  const messageEl = {
    querySelector: jest.fn(() => contentEl),
  };
  // Toggle to simulate the message element disappearing from the DOM
  // (conversation switch, reconcile) before finalize runs.
  const dom = { present: true };
  const containerEl = {
    querySelector: jest.fn(() => (dom.present ? messageEl : null)),
  };

  const controller = new StreamingController(
    containerEl as unknown as HTMLElement,
    {} as App,
    {} as Component
  );

  return { controller, dom, containerEl };
}

describe('StreamingController — getCurrentMessageId lifecycle', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('reports the streaming message while active and null after finalize', () => {
    const { controller } = makeHarness();

    controller.startStreaming('msg-1');
    expect(controller.getCurrentMessageId()).toBe('msg-1');

    controller.finalizeStreaming('msg-1', 'done');
    // Synchronous: no await on the markdown finalize promise needed.
    expect(controller.getCurrentMessageId()).toBeNull();
  });

  it('drops the entry even when the message element left the DOM (leak regression)', () => {
    const { controller, dom } = makeHarness();

    controller.startStreaming('msg-1');
    expect(controller.getCurrentMessageId()).toBe('msg-1');

    // Message element is gone by the time the turn finalizes
    dom.present = false;
    controller.finalizeStreaming('msg-1', 'done');

    // Before the fix this entry leaked forever and msg-1 stayed "current",
    // making the status bar filter drop every later turn's present-tense
    // tool labels.
    expect(controller.getCurrentMessageId()).toBeNull();
    expect(MarkdownRenderer.finalizeStreamingContent).not.toHaveBeenCalled();
  });

  it('finalize on an unknown message is a safe no-op', () => {
    const { controller } = makeHarness();

    expect(() => controller.finalizeStreaming('never-streamed', 'x')).not.toThrow();
    expect(controller.getCurrentMessageId()).toBeNull();
  });
});

describe('StreamingController — detached run recovery', () => {
  it('reopens a run when a conversation switch detached the one it was writing to', () => {
    // The parser state is keyed by messageId and outlives the transcript
    // rebuild that a conversation switch performs. Writing on into the old
    // detached run swallowed the rest of the turn with no error anywhere.
    const run = { isConnected: true, className: '', classList: { contains: () => false } };
    const contentEl = {
      getAttribute: () => null,
      parentElement: null,
      createDiv: jest.fn(),
      children: [],
      querySelector: jest.fn(() => null),
      appendChild: jest.fn(),
      insertBefore: jest.fn(),
    };
    const messageEl = { querySelector: jest.fn(() => contentEl) };
    const containerEl = { querySelector: jest.fn(() => messageEl) };

    const controller = new StreamingController(
      containerEl as unknown as HTMLElement,
      {} as App,
      {} as Component
    );

    // Pretend startStreaming bound the parser to `run`
    (controller as unknown as { activeRuns: Map<string, unknown> }).activeRuns.set('msg-1', run);
    (controller as unknown as { streamingStates: Map<string, unknown> })
      .streamingStates.set('msg-1', { mock: 'streaming-state' });

    (MarkdownRenderer.writeStreamingChunk as jest.Mock).mockClear();
    (MarkdownRenderer.initializeStreamingParser as jest.Mock).mockClear();

    // Still attached: write straight through, no re-init
    controller.updateStreamingChunk('msg-1', 'a');
    expect(MarkdownRenderer.initializeStreamingParser).not.toHaveBeenCalled();
    expect(MarkdownRenderer.writeStreamingChunk).toHaveBeenCalledTimes(1);

    // The transcript is rebuilt underneath it
    run.isConnected = false;

    controller.updateStreamingChunk('msg-1', 'b');
    // A fresh parser is opened rather than writing into the detached node
    expect(MarkdownRenderer.initializeStreamingParser).toHaveBeenCalledTimes(1);
    expect(MarkdownRenderer.writeStreamingChunk).toHaveBeenCalledTimes(2);
  });
});
