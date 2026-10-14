/**
 * Defaults → Ingestion layout and survival across renderer redraws.
 *
 * Failures this buys (all three were live bugs):
 *  1. The PDF mode and OCR rows rendered above the "enable" toggle that gates
 *     them, because their container was created before the toggle.
 *  2. "Auto-convert" sat outside the gated container, so it stayed visible
 *     while ingestion was off.
 *  3. Ingestion and Embeddings were appended after ChatSettingsRenderer.render(),
 *     which empties its container on every redraw (provider/model change, LLM
 *     settings change), so both sections vanished after the first redraw.
 *
 * The shared obsidian Setting mock neither attaches its element nor records a
 * name, so order cannot be observed through it. This file swaps in a Setting
 * that appends a named element to the container it is given, over a small
 * element tree that keeps children in insertion order and honours empty().
 *
 * Real pieces: DefaultsTab.render / renderIngestionSection /
 * renderEmbeddingsSection and ChatSettingsRenderer.render (container emptying
 * and the renderAfterImageSection hook). Stubbed: the renderer's own sections,
 * Video and Voice, and the ingestion capability lookup.
 */

interface FakeNode {
  tag: string;
  classes: Set<string>;
  text: string;
  settingName?: string;
  children: FakeNode[];
  parent: FakeNode | null;
  [key: string]: unknown;
}

function fakeNode(tag = 'div', info?: string | { cls?: string; text?: string }): FakeNode {
  const opts = typeof info === 'string' ? { cls: info } : info ?? {};
  const node: FakeNode = {
    tag,
    classes: new Set((opts.cls ?? '').split(/\s+/).filter(Boolean)),
    text: opts.text ?? '',
    children: [],
    parent: null
  };
  const append = (child: FakeNode): FakeNode => {
    child.parent = node;
    node.children.push(child);
    return child;
  };
  Object.assign(node, {
    createDiv: (o?: string | { cls?: string; text?: string }) => append(fakeNode('div', o)),
    createEl: (t: string, o?: { cls?: string; text?: string }) => append(fakeNode(t, o)),
    createSpan: (o?: string | { cls?: string; text?: string }) => append(fakeNode('span', o)),
    appendChild: (child: FakeNode) => append(child),
    empty: () => { node.children = []; },
    addClass: (cls: string) => { node.classes.add(cls); },
    removeClass: (cls: string) => { node.classes.delete(cls); },
    hasClass: (cls: string) => node.classes.has(cls),
    setText: (text: string) => { node.text = text; }
  });
  return node;
}

const toggles = new Map<string, (value: boolean) => Promise<void> | void>();

jest.mock('obsidian', () => {
  const actual = jest.requireActual('../mocks/obsidian');
  class RecordingSetting {
    settingEl: FakeNode;
    controlEl: FakeNode;
    private name = '';
    constructor(containerEl: { createDiv(o?: unknown): FakeNode }) {
      this.settingEl = containerEl.createDiv({ cls: 'setting-item' });
      this.controlEl = this.settingEl.createDiv({ cls: 'setting-item-control' });
    }
    setName(name: string): this { this.name = name; this.settingEl.settingName = name; return this; }
    setDesc(): this { return this; }
    setClass(): this { return this; }
    setTooltip(): this { return this; }
    addToggle(cb: (toggle: unknown) => void): this {
      const name = this.name;
      const toggle = {
        setValue() { return toggle; },
        onChange(handler: (value: boolean) => Promise<void> | void) { toggles.set(name, handler); return toggle; }
      };
      cb(toggle);
      return this;
    }
    addDropdown(cb: (dropdown: unknown) => void): this {
      const dropdown = { addOption() { return dropdown; }, setValue() { return dropdown; }, onChange() { return dropdown; } };
      cb(dropdown);
      return this;
    }
  }
  return { ...actual, Setting: RecordingSetting };
});

jest.mock('../../src/agents/ingestManager/tools/services/IngestCapabilityService', () => ({
  getIngestCapabilityOptions: jest.fn(async () => ({ ocrProviders: [], transcriptionProviders: [] })),
  normalizeIngestSelection: jest.fn(() => ({}))
}));
jest.mock('../../src/components/shared/IngestModelDropdownRenderer', () => ({
  renderIngestModelDropdowns: jest.fn()
}));

import { ChatSettingsRenderer } from '../../src/components/shared/ChatSettingsRenderer';
import { DefaultsTab } from '../../src/settings/tabs/DefaultsTab';

const INGEST_ROWS = ['File import', 'Convert new files automatically', 'Default PDF mode'];

function settingNames(root: FakeNode): string[] {
  const names: string[] = [];
  const walk = (node: FakeNode): void => {
    if (node.settingName) names.push(node.settingName);
    node.children.forEach(walk);
  };
  walk(root);
  return names;
}

function findSetting(root: FakeNode, name: string): FakeNode | undefined {
  if (root.settingName === name) return root;
  for (const child of root.children) {
    const hit = findSetting(child, name);
    if (hit) return hit;
  }
  return undefined;
}

function isHidden(node: FakeNode | undefined): boolean {
  for (let current = node ?? null; current; current = current.parent) {
    if (current.classes.has('nexus-ingest-confirm-hidden')) return true;
  }
  return false;
}

const flush = () => new Promise<void>(resolve => setImmediate(resolve));

let restore: Array<() => void> = [];

beforeEach(() => {
  toggles.clear();
  const globals = globalThis as unknown as { createDiv: unknown };
  const originalCreateDiv = globals.createDiv;
  globals.createDiv = (info?: string | { cls?: string; text?: string }) => fakeNode('div', info);
  const sectionStubs = [
    'renderModelSection', 'renderAgentModelSection', 'renderImageSection',
    'renderVoiceSection', 'renderTranscriptionSection', 'renderTemperatureSection', 'renderContextSection'
  ].map(method => jest.spyOn(ChatSettingsRenderer.prototype as never, method as never).mockImplementation((() => undefined) as never));
  const tabStubs = ['renderVideoSection', 'renderVoiceSection']
    .map(method => jest.spyOn(DefaultsTab.prototype as never, method as never).mockImplementation((() => undefined) as never));
  restore = [
    () => { globals.createDiv = originalCreateDiv; },
    ...[...sectionStubs, ...tabStubs].map(spy => () => spy.mockRestore())
  ];
});

afterEach(() => {
  restore.forEach(fn => fn());
});

async function renderDefaults(enableIngestion: boolean) {
  const container = fakeNode();
  const saveSettings = jest.fn(async () => undefined);
  const pluginSettings: Record<string, unknown> = { enableIngestion, autoIngestion: false };
  const tab = Object.create(DefaultsTab.prototype) as {
    container: unknown; services: unknown; settingsSaveQueue: Promise<void>;
    renderer: ChatSettingsRenderer | null;
    render(workspaces: unknown[], prompts: unknown[]): void;
    destroy(): void;
  };
  tab.container = container;
  tab.settingsSaveQueue = Promise.resolve();
  tab.services = {
    app: { vault: {}, workspace: {} },
    settings: { settings: pluginSettings, saveSettings },
    llmProviderSettings: { providers: {}, defaultModel: { provider: '', model: '' }, defaultPdfMode: 'text' }
  };
  tab.render([], []);
  await flush();
  return { tab, container, pluginSettings };
}

it('renders the ingestion toggle before the rows it gates', async () => {
  const { tab, container } = await renderDefaults(true);
  try {
    expect(settingNames(container).filter(name => INGEST_ROWS.includes(name))).toEqual(INGEST_ROWS);
  } finally {
    tab.destroy();
  }
});

it('hides auto-convert with the other dependent rows while ingestion is off', async () => {
  const { tab, container, pluginSettings } = await renderDefaults(false);
  try {
    expect(isHidden(findSetting(container, 'File import'))).toBe(false);
    expect(isHidden(findSetting(container, 'Convert new files automatically'))).toBe(true);
    expect(isHidden(findSetting(container, 'Default PDF mode'))).toBe(true);

    await toggles.get('File import')?.(true);
    expect(pluginSettings.enableIngestion).toBe(true);
    expect(isHidden(findSetting(container, 'Convert new files automatically'))).toBe(false);
  } finally {
    tab.destroy();
  }
});

it('keeps ingestion and embeddings after the renderer redraws twice', async () => {
  const { tab, container } = await renderDefaults(true);
  try {
    tab.renderer?.render();
    tab.renderer?.render();
    await flush();
    const names = settingNames(container);
    for (const row of INGEST_ROWS) {
      expect(names.filter(name => name === row)).toHaveLength(1);
    }
    expect(names.filter(name => name === 'Enable')).toHaveLength(1);
  } finally {
    tab.destroy();
  }
});
