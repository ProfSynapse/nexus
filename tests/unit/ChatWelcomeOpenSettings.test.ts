/**
 * The no-provider chat welcome shows "Open settings". With no provider there
 * is nothing to configure in the per-chat Chat settings modal, so the button
 * must open Settings → Nexus → Providers instead. It used to call
 * ChatView.openChatSettingsModal().
 *
 * Real pieces: the ChatView controller wiring (initializeControllers), the
 * UIStateController welcome markup and its click registration, and the
 * SettingsTabManager route hand-off. Faked: DOM elements (the node test
 * environment has none) and Obsidian's private app.setting modal. The
 * SettingsView side of the hand-off is covered in SettingsViewOpenTo.test.ts.
 */

// SettingsTabManager constructs SettingsView only in initializeSettingsTab(),
// which these tests do not call; the obsidian mock has no PluginSettingTab.
jest.mock('../../src/settings/SettingsView', () => ({ SettingsView: jest.fn() }));

jest.mock(
  'streaming-markdown',
  () => ({
    default_renderer: () => ({}),
    parser: () => ({}),
    parser_write: () => undefined,
    parser_end: () => undefined,
  }),
  { virtual: true }
);

import type { WorkspaceLeaf } from 'obsidian';
import { SettingsTabManager } from '../../src/core/settings/SettingsTabManager';

/* eslint-disable @typescript-eslint/no-explicit-any */

interface FakeEl {
  cls: string;
  text: string;
  children: FakeEl[];
  [key: string]: any;
}

function fakeEl(cls = '', text = ''): FakeEl {
  const el: FakeEl = {
    cls,
    text,
    children: [],
    empty: () => { el.children = []; },
    addClass: () => undefined,
    createDiv: (opts?: string | { cls?: string; text?: string }) => add(opts),
    createEl: (_tag: string, opts?: { cls?: string; text?: string }) => add(opts),
    createSpan: (opts?: string | { cls?: string; text?: string }) => add(opts),
    insertBefore: () => undefined,
    firstChild: null
  };
  function add(opts?: string | { cls?: string; text?: string }): FakeEl {
    const child = typeof opts === 'string' ? fakeEl(opts) : fakeEl(opts?.cls ?? '', opts?.text ?? '');
    el.children.push(child);
    return child;
  }
  return el;
}

function find(root: FakeEl, text: string): FakeEl | undefined {
  if (root.text === text) return root;
  for (const child of root.children) {
    const hit = find(child, text);
    if (hit) return hit;
  }
  return undefined;
}

async function buildView(openNexusSettings: jest.Mock) {
  const { ChatView } = await import('../../src/ui/chat/ChatView');
  const plugin = { openNexusSettings, getServiceIfReady: jest.fn(() => null), getService: jest.fn(async () => null) };
  const app = { plugins: { getPlugin: (id: string) => (id === 'nexus' ? plugin : null) } };
  const view = new ChatView({ app } as unknown as WorkspaceLeaf, null as never) as any;
  view.app = app;
  const messageDisplay = fakeEl('message-display-container');
  view.containerEl = { querySelector: (selector: string) => selector === '.message-display-container' ? messageDisplay : null };
  const clicks = new Map<unknown, () => void>();
  view.registerDomEvent = (element: unknown, type: string, handler: () => void) => {
    if (type === 'click') clicks.set(element, handler);
  };
  view.openChatSettingsModal = jest.fn(async () => undefined);
  view.initializeControllers();
  return { view, messageDisplay, clicks };
}

describe('chat welcome "Open settings" with no provider', () => {
  it('opens Nexus settings on the Providers tab, not the chat settings modal', async () => {
    const openNexusSettings = jest.fn(() => true);
    const { view, messageDisplay, clicks } = await buildView(openNexusSettings);

    view.uiStateController.showWelcomeState(false);
    const button = find(messageDisplay, 'Open settings');
    expect(button).toBeDefined();
    expect(find(messageDisplay, 'Configure a provider to start chatting.')).toBeDefined();
    const click = clicks.get(button);
    if (!click) throw new Error('Open settings button has no click handler');
    click();

    expect(openNexusSettings).toHaveBeenCalledWith({ tab: 'providers' });
    expect(view.openChatSettingsModal).not.toHaveBeenCalled();
  });
});

describe('SettingsTabManager.openNexusSettings', () => {
  function manager(settingsTab: { openTo: jest.Mock } | undefined, setting?: { open: jest.Mock; openTabById: jest.Mock }) {
    const tabManager = new SettingsTabManager({
      plugin: { manifest: { id: 'nexus' } },
      app: setting ? { setting } : {},
    } as never);
    (tabManager as any).settingsTab = settingsTab;
    return tabManager;
  }

  it('hands the route to the settings view before opening the Nexus tab', () => {
    const order: string[] = [];
    const settingsTab = { openTo: jest.fn(() => { order.push('route'); }) };
    const setting = {
      open: jest.fn(() => { order.push('open'); }),
      openTabById: jest.fn(() => { order.push('tab'); })
    };
    expect(manager(settingsTab, setting).openNexusSettings({ tab: 'providers' })).toBe(true);
    expect(settingsTab.openTo).toHaveBeenCalledWith({ tab: 'providers' });
    expect(setting.openTabById).toHaveBeenCalledWith('nexus');
    expect(order).toEqual(['route', 'open', 'tab']);
  });

  it('reports failure when the settings modal is unavailable', () => {
    expect(manager({ openTo: jest.fn() }).openNexusSettings({ tab: 'providers' })).toBe(false);
  });
});
