/**
 * SettingsView.openTo(route) lets code outside settings (the chat welcome's
 * "Open settings") land on a specific Nexus tab. Failure this buys: if the
 * route were dropped, or applied after the tab strip was built, settings would
 * open on the last-used tab (Defaults) and the user would not see Providers.
 *
 * Real pieces: SettingsView.display(), SettingsRouter and the tab dispatch.
 * Faked: Obsidian's PluginSettingTab base, UnifiedTabs (records the tab it is
 * built with) and the tab implementations (record that they were rendered).
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
  }

  return {
    Events: jest.requireActual('../mocks/obsidian/core').Events,
    App: jest.fn(),
    Plugin: jest.fn(),
    PluginSettingTab,
    Notice: jest.fn(),
    ButtonComponent: jest.fn(),
    FileSystemAdapter: jest.fn(),
    Platform: { isMobile: false, isDesktop: true },
  };
}, { virtual: true });

const mockTab = () => jest.fn().mockImplementation(() => ({ destroy: jest.fn(), render: jest.fn() }));
const mockDefaultsTab = mockTab();
const mockProvidersTab = mockTab();

jest.mock('../../src/utils/UpdateManager', () => ({
  UpdateManager: { isStoreAvailable: jest.fn().mockResolvedValue(true) }
}));
jest.mock('../../src/utils/platform', () => ({ supportsMCPBridge: jest.fn().mockReturnValue(false) }));
jest.mock('../../src/components/UnifiedTabs', () => ({
  UnifiedTabs: jest.fn().mockImplementation(() => ({
    getTabContent: jest.fn(() => ({ empty: jest.fn() })),
    destroy: jest.fn(),
    activateTab: jest.fn()
  }))
}));
jest.mock('../../src/settings/tabs/DefaultsTab', () => ({ DefaultsTab: mockDefaultsTab }));
jest.mock('../../src/settings/tabs/WorkspacesTab', () => ({ WorkspacesTab: mockTab() }));
jest.mock('../../src/settings/tabs/InstructionsTab', () => ({ InstructionsTab: mockTab() }));
jest.mock('../../src/settings/tabs/ProvidersTab', () => ({ ProvidersTab: mockProvidersTab }));
jest.mock('../../src/settings/tabs/RemoteAgentsTab', () => ({ RemoteAgentsTab: mockTab() }));
jest.mock('../../src/settings/tabs/AppsTab', () => ({ AppsTab: mockTab() }));
jest.mock('../../src/settings/tabs/DataTab', () => ({ DataTab: mockTab() }));
// Get started is desktop-bridge only and not under test (supportsMCPBridge is false).
jest.mock('../../src/components/Accordion', () => ({ Accordion: jest.fn() }));

import { createMockElement } from '../helpers/mockFactories';
import { SettingsView } from '../../src/settings/SettingsView';

function buildView(): SettingsView {
  const view = new SettingsView(
    { vault: { configDir: '.obsidian' }, workspace: {} } as never,
    { manifest: { id: 'nexus', version: 'test' } } as never,
    { settings: { llmProviders: {} }, saveSettings: jest.fn() } as never
  );
  view.containerEl = createMockElement('div') as unknown as HTMLElement;
  return view;
}

function unifiedTabs(): jest.Mock {
  return jest.requireMock('../../src/components/UnifiedTabs').UnifiedTabs as jest.Mock;
}

beforeEach(() => {
  jest.clearAllMocks();
});

it('opens on the requested tab when the route is set before settings display', () => {
  const view = buildView();
  view.openTo({ tab: 'providers' });
  view.display();

  expect(unifiedTabs().mock.calls[0][0].defaultTab).toBe('providers');
  expect(mockProvidersTab).toHaveBeenCalledTimes(1);
  expect(mockDefaultsTab).not.toHaveBeenCalled();
});

it('consumes the route once, so a later display keeps the user on their own tab', () => {
  const view = buildView();
  view.openTo({ tab: 'providers' });
  view.display();
  (view as unknown as { router: { setTab(tab: string): void } }).router.setTab('defaults');
  view.display();

  expect(unifiedTabs().mock.calls[1][0].defaultTab).toBe('defaults');
});

it('navigates at once when settings are already on screen', () => {
  const view = buildView();
  view.display();
  expect(mockDefaultsTab).toHaveBeenCalledTimes(1);
  (view.containerEl as unknown as { isConnected: boolean }).isConnected = true;

  view.openTo({ tab: 'providers' });

  const tabs = unifiedTabs().mock.results[0].value as { activateTab: jest.Mock };
  expect(tabs.activateTab).toHaveBeenCalledWith('providers', false);
  expect(mockProvidersTab).toHaveBeenCalledTimes(1);
});
