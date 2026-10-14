/**
 * Get started is one row above the tab strip, and on the first opening of a
 * plugin session with nothing set up it opens by itself. Failure this buys:
 * a first-run user landing on Defaults with no guidance, a set-up user being
 * pushed into onboarding, the old synced `getStartedOpen` key still deciding
 * anything, or the page refusing to go away on the next opening.
 *
 * Real pieces: SettingsView, SettingsRouter, the Get started row and page,
 * BackButton, getStartedStatus, and the Setting/SettingGroup mocks rendering a
 * FakeElement tree. Faked: PluginSettingTab, UnifiedTabs and the tab bodies.
 */
jest.mock('obsidian', () => {
  class PluginSettingTab {
    app: unknown;
    plugin: unknown;
    containerEl: HTMLElement;

    constructor(app: unknown, plugin: unknown) {
      this.app = app;
      this.plugin = plugin;
      this.containerEl = {} as HTMLElement;
    }

    hide(): void {}
  }

  return {
    ...jest.requireActual('../mocks/obsidian'),
    PluginSettingTab,
    FileSystemAdapter: jest.fn(),
  };
});

const mockTab = () => jest.fn().mockImplementation(() => ({ destroy: jest.fn(), render: jest.fn() }));
const mockDefaultsTab = mockTab();
const mockProvidersTab = mockTab();
const mockAppsTab = mockTab();

jest.mock('../../src/utils/UpdateManager', () => ({
  UpdateManager: { isStoreAvailable: jest.fn().mockResolvedValue(true) }
}));
const mockBridge = jest.fn().mockReturnValue(false);
jest.mock('../../src/utils/platform', () => ({ supportsMCPBridge: () => mockBridge() }));
const mockExternalSetup = jest.fn().mockReturnValue(false);
jest.mock('../../src/settings/getStartedStatus', () => ({
  ...jest.requireActual('../../src/settings/getStartedStatus'),
  hasExternalAgentSetup: () => mockExternalSetup(),
  countExternalConnections: () => 0
}));
jest.mock('../../src/components/UnifiedTabs', () => {
  const { FakeElement } = jest.requireActual('../mocks/obsidian/dom');
  return {
    UnifiedTabs: jest.fn().mockImplementation((options: { containerEl: InstanceType<typeof FakeElement> }) => {
      const strip = options.containerEl.createDiv({ cls: 'nexus-settings-tabs' });
      return {
        strip,
        getTabContent: jest.fn(() => new FakeElement('div')),
        destroy: jest.fn(() => strip.remove()),
        activateTab: jest.fn()
      };
    })
  };
});
jest.mock('../../src/settings/tabs/DefaultsTab', () => ({ DefaultsTab: mockDefaultsTab }));
jest.mock('../../src/settings/tabs/WorkspacesTab', () => ({ WorkspacesTab: mockTab() }));
jest.mock('../../src/settings/tabs/InstructionsTab', () => ({ InstructionsTab: mockTab() }));
jest.mock('../../src/settings/tabs/ProvidersTab', () => ({ ProvidersTab: mockProvidersTab }));
jest.mock('../../src/settings/tabs/RemoteAgentsTab', () => ({ RemoteAgentsTab: mockTab() }));
jest.mock('../../src/settings/tabs/AppsTab', () => ({ AppsTab: mockAppsTab }));
jest.mock('../../src/settings/tabs/DataTab', () => ({ DataTab: mockTab() }));

import { createFakeRoot, FakeElement } from '../mocks/obsidian/dom';
import { SettingsView } from '../../src/settings/SettingsView';
import { GET_STARTED_PAGE, GET_STARTED_ROW } from '../../src/settings/getStarted/copy';

const configured = { providers: { openai: { enabled: true, apiKey: 'test-key' } } };

function buildView(settings: Record<string, unknown> = {}, root: FakeElement = createFakeRoot()): SettingsView {
  const view = new SettingsView(
    { vault: { configDir: '.obsidian', getName: () => 'Vault' }, workspace: {} } as never,
    { manifest: { id: 'nexus', version: 'test' } } as never,
    { settings: { llmProviders: {}, ...settings }, saveSettings: jest.fn() } as never
  );
  view.containerEl = root as unknown as HTMLElement;
  return view;
}

function root(view: SettingsView): FakeElement {
  return view.containerEl as unknown as FakeElement;
}

function pageTitle(view: SettingsView): string | undefined {
  return root(view).querySelector('.nexus-page-title')?.textContent;
}

function getStartedRow(view: SettingsView): FakeElement | null {
  return root(view).querySelector('.nexus-get-started .setting-item');
}

function hasTabStrip(view: SettingsView): boolean {
  return root(view).querySelector('.nexus-settings-tabs') !== null;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockBridge.mockReturnValue(false);
  mockExternalSetup.mockReturnValue(false);
});

it('opens the Get started page on the first display when nothing is set up, and not on the next opening', () => {
  const view = buildView();
  view.display();

  expect(pageTitle(view)).toBe(GET_STARTED_PAGE.title);
  expect(hasTabStrip(view)).toBe(false);
  expect(getStartedRow(view)).toBeNull();
  expect(mockDefaultsTab).not.toHaveBeenCalled();

  // Settings closed and opened again in the same session.
  view.hide();
  view.display();

  expect(pageTitle(view)).toBeUndefined();
  expect(hasTabStrip(view)).toBe(true);
  expect(getStartedRow(view)).not.toBeNull();
  expect(mockDefaultsTab).toHaveBeenCalledTimes(1);
});

it('keeps the page through a re-render while settings stay open', () => {
  const view = buildView();
  view.display();
  view.display();
  expect(pageTitle(view)).toBe(GET_STARTED_PAGE.title);
});

it('shows the tab list first when a provider is configured', () => {
  const view = buildView({ llmProviders: configured });
  view.display();

  expect(pageTitle(view)).toBeUndefined();
  expect(hasTabStrip(view)).toBe(true);
  expect(mockDefaultsTab).toHaveBeenCalledTimes(1);
});

it('shows the tab list first when only an external agent is set up', () => {
  mockExternalSetup.mockReturnValue(true);
  const view = buildView();
  view.display();
  expect(pageTitle(view)).toBeUndefined();
});

it('no longer reads the retired getStartedOpen key', () => {
  const closed = buildView({ getStartedOpen: false });
  closed.display();
  expect(pageTitle(closed)).toBe(GET_STARTED_PAGE.title);

  const open = buildView({ getStartedOpen: true, llmProviders: configured });
  open.display();
  expect(pageTitle(open)).toBeUndefined();
});

it('lets a route asked for by other code win over the first-run page', () => {
  const view = buildView();
  view.openTo({ tab: 'providers' });
  view.display();

  expect(pageTitle(view)).toBeUndefined();
  expect(mockProvidersTab).toHaveBeenCalledTimes(1);
});

it('does not spend the first-run check on a render nobody sees', () => {
  const view = buildView({}, new FakeElement('div'));
  view.updateServices({});
  expect(mockDefaultsTab).not.toHaveBeenCalled();

  view.containerEl = createFakeRoot() as unknown as HTMLElement;
  view.display();
  expect(pageTitle(view)).toBe(GET_STARTED_PAGE.title);
});

it('the row above the tabs opens the page, and Back returns to the same tab', () => {
  const view = buildView({ llmProviders: configured });
  view.display();
  (view as unknown as { router: { setTab(tab: string): void } }).router.setTab('apps');

  const row = getStartedRow(view)!;
  expect(row.querySelector('.setting-item-name')?.textContent).toBe(GET_STARTED_ROW.name);
  expect(row.querySelector('.setting-item-description')?.textContent).toBe(GET_STARTED_ROW.desc);
  expect(row.hasClass('mod-navigable')).toBe(true);
  expect(row.getAttribute('role')).toBe('button');
  expect(row.getAttribute('tabindex')).toBe('0');
  // Only one way in: no separate Get started button.
  expect(root(view).querySelectorAll('.nexus-get-started button')).toHaveLength(0);

  row.dispatch('keydown', { key: 'Enter' });
  expect(pageTitle(view)).toBe(GET_STARTED_PAGE.title);
  expect(hasTabStrip(view)).toBe(false);

  const back = root(view).querySelector('.nexus-back-button')!;
  expect(back.textContent).toBe('Settings');
  back.dispatch('click');

  expect(pageTitle(view)).toBeUndefined();
  expect(hasTabStrip(view)).toBe(true);
  const unifiedTabs = jest.requireMock('../../src/components/UnifiedTabs').UnifiedTabs as jest.Mock;
  expect(unifiedTabs.mock.calls[unifiedTabs.mock.calls.length - 1][0].defaultTab).toBe('apps');
  expect(mockAppsTab).toHaveBeenCalledTimes(2);
});

it('offers only the chat path where the external agent bridge is unavailable (mobile)', () => {
  const view = buildView();
  view.display();
  const names = root(view).querySelectorAll('.nexus-gs-page .mod-navigable .setting-item-name').map(el => el.textContent);
  expect(names).toEqual([GET_STARTED_PAGE.chatName]);
  expect(root(view).querySelector('.nexus-gs-page .mod-navigable .setting-item-value')?.textContent).toBe(GET_STARTED_PAGE.chatNotSetUp);
});

it('offers both paths on desktop, with the chat path marked ready once a provider is configured', () => {
  mockBridge.mockReturnValue(true);
  const view = buildView({ llmProviders: configured });
  view.display();
  getStartedRow(view)!.dispatch('click');

  const rows = root(view).querySelectorAll('.nexus-gs-page .mod-navigable');
  expect(rows.map(row => row.querySelector('.setting-item-name')?.textContent)).toEqual([GET_STARTED_PAGE.chatName, GET_STARTED_PAGE.agentsName]);
  expect(rows.map(row => row.querySelector('.setting-item-value')?.textContent)).toEqual([GET_STARTED_PAGE.chatReady, GET_STARTED_PAGE.connectedCount(0)]);
  expect(root(view).querySelectorAll('.nexus-can li')).toHaveLength(6);
});
