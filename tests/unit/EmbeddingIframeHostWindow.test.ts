/**
 * EmbeddingIframe: which window hosts the model iframe, and how it is released.
 *
 * The live defect (Obsidian 1.14.4, fresh vault): semantic search indexed
 * "7 of 7" and stored nothing. Since 1.14 the Settings view is its own window,
 * so `window.activeDocument` is the Settings document whenever the user is in
 * Settings, which is exactly when semantic search is turned on. The iframe was
 * appended there while its message listener sat on the main window. The model
 * iframe posts to its own `parent`, the Settings window, so the ready message
 * never reached the listener and initialization timed out after 60s.
 *
 * What is faked: two windows (main and a separate "Settings" window whose
 * document is activeDocument) and an iframe whose replies are delivered the way
 * the browser delivers them, to the window it is attached to. What is real: the
 * whole EmbeddingIframe. Route the iframe to activeDocument again and the first
 * test times out; remove the listener before the dispose request again and the
 * dispose test never settles.
 */

import { EmbeddingIframe } from '../../src/services/embeddings/EmbeddingIframe';

type Handler = (event: { source: unknown; data: unknown }) => void;

interface FakeWindow {
  handlers: Set<Handler>;
  addEventListener: jest.Mock;
  removeEventListener: jest.Mock;
  document: { body: { appendChild: jest.Mock } };
  deliver(source: unknown, data: unknown): void;
}

function makeWindow(): FakeWindow {
  const handlers = new Set<Handler>();
  const win: FakeWindow = {
    handlers,
    addEventListener: jest.fn((type: string, h: Handler) => { if (type === 'message') handlers.add(h); }),
    removeEventListener: jest.fn((type: string, h: Handler) => { if (type === 'message') handlers.delete(h); }),
    document: { body: { appendChild: jest.fn() } },
    deliver(source, data) {
      for (const h of Array.from(handlers)) h({ source, data });
    }
  };
  return win;
}

interface FakeIframe {
  className: string;
  src: string;
  setAttribute: jest.Mock;
  remove: jest.Mock;
  contentWindow: { postMessage: jest.Mock };
  /** The window whose document the iframe was appended to: its `parent`. */
  host: FakeWindow | null;
}

describe('EmbeddingIframe host window', () => {
  const realWindow = (globalThis as { window?: unknown }).window;
  const realCreateEl = (globalThis as { createEl?: unknown }).createEl;
  const realCreateObjectURL = URL.createObjectURL;
  const realRevokeObjectURL = URL.revokeObjectURL;

  let main: FakeWindow;
  let settings: FakeWindow;
  let iframes: FakeIframe[];

  beforeEach(() => {
    jest.useFakeTimers();
    main = makeWindow();
    settings = makeWindow();
    iframes = [];

    const mainWindow = {
      ...main,
      setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
      clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
      // Focus is on the Settings window, as when the user turns search on.
      activeDocument: settings.document,
      activeWindow: settings
    };
    (globalThis as { window?: unknown }).window = mainWindow;

    // Record which body an iframe ends up in, and answer as a browser would:
    // a reply goes to the window the iframe is attached to.
    const attach = (win: FakeWindow) => (el: FakeIframe) => { el.host = win; return el; };
    main.document.body.appendChild.mockImplementation(attach(main));
    settings.document.body.appendChild.mockImplementation(attach(settings));

    (globalThis as { createEl?: unknown }).createEl = jest.fn(() => {
      const el: FakeIframe = {
        className: '',
        src: '',
        setAttribute: jest.fn(),
        remove: jest.fn(),
        host: null,
        contentWindow: {
          postMessage: jest.fn((msg: { id: number; method: string }) => {
            // The iframe answers every request successfully, to its parent.
            el.host?.deliver(el.contentWindow, { id: msg.id, success: true, embedding: [0.5] });
          })
        }
      };
      iframes.push(el);
      return el;
    });

    URL.createObjectURL = jest.fn(() => 'blob:fake');
    URL.revokeObjectURL = jest.fn();
  });

  afterEach(() => {
    jest.useRealTimers();
    (globalThis as { window?: unknown }).window = realWindow;
    (globalThis as { createEl?: unknown }).createEl = realCreateEl;
    URL.createObjectURL = realCreateObjectURL;
    URL.revokeObjectURL = realRevokeObjectURL;
  });

  /** The model finished loading inside the iframe: it posts ready to its parent. */
  function signalReady(frame: FakeIframe): void {
    frame.host?.deliver(frame.contentWindow, { id: -1, ready: true, success: true });
  }

  it('hosts the iframe in the main window even while another window has focus', async () => {
    const engine = new EmbeddingIframe();
    const init = engine.initialize();

    expect(iframes).toHaveLength(1);
    const frame = iframes[0];
    expect(main.document.body.appendChild).toHaveBeenCalledWith(frame);
    expect(settings.document.body.appendChild).not.toHaveBeenCalled();
    expect(main.handlers.size).toBe(1);

    signalReady(frame);
    await expect(init).resolves.toBeUndefined();
    expect(engine.ready()).toBe(true);

    await expect(engine.generateEmbedding('hello')).resolves.toEqual(new Float32Array([0.5]));
  });

  it('dispose() hears the iframe answer instead of waiting out the request timeout', async () => {
    const engine = new EmbeddingIframe();
    const init = engine.initialize();
    signalReady(iframes[0]);
    await init;

    let settled = false;
    const disposing = engine.dispose().then(() => { settled = true; });
    // Flush microtasks only. No timer is advanced, so a dispose that is
    // waiting for the 30s request timeout cannot settle here.
    for (let i = 0; i < 10; i++) await Promise.resolve();

    expect(settled).toBe(true);
    await disposing;
    expect(iframes[0].contentWindow.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'dispose' }), '*'
    );
    expect(iframes[0].remove).toHaveBeenCalled();
    expect(main.handlers.size).toBe(0);
  });

  it('a timed-out initialization removes its iframe and listener, so a retry starts clean', async () => {
    const engine = new EmbeddingIframe();
    const init = engine.initialize();
    const failure = expect(init).rejects.toThrow('Iframe initialization timeout (60s)');

    jest.advanceTimersByTime(60000);
    await failure;

    expect(iframes[0].remove).toHaveBeenCalled();
    expect(main.handlers.size).toBe(0);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:fake');

    // A retry builds one new iframe, and only one listener is attached.
    const retry = engine.initialize();
    expect(iframes).toHaveLength(2);
    expect(main.handlers.size).toBe(1);
    signalReady(iframes[1]);
    await expect(retry).resolves.toBeUndefined();
  });

  it('dispose() of an iframe that never became ready does not wait for an answer', async () => {
    const engine = new EmbeddingIframe();
    const init = engine.initialize();
    const failure = expect(init).rejects.toThrow('Embedding iframe was disposed');

    let settled = false;
    const disposing = engine.dispose().then(() => { settled = true; });
    for (let i = 0; i < 10; i++) await Promise.resolve();

    expect(settled).toBe(true);
    await disposing;
    await failure;
    expect(iframes[0].contentWindow.postMessage).not.toHaveBeenCalled();
    expect(iframes[0].remove).toHaveBeenCalled();
  });
});
