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

const mockDefaultsTab = jest.fn().mockImplementation(() => ({
  destroy: jest.fn()
}));
const mockWorkspacesTab = jest.fn().mockImplementation(() => ({
  destroy: jest.fn()
}));
const mockPromptsTab = jest.fn().mockImplementation(() => ({
  destroy: jest.fn()
}));
const mockProvidersTab = jest.fn().mockImplementation(() => ({
  destroy: jest.fn()
}));
const mockRemoteAgentsTab = jest.fn().mockImplementation(() => ({
  destroy: jest.fn()
}));
const mockAppsTab = jest.fn().mockImplementation(() => ({
  destroy: jest.fn()
}));
const mockDataTab = jest.fn().mockImplementation(() => ({
  destroy: jest.fn(),
  render: jest.fn()
}));

jest.mock('../../src/utils/UpdateManager', () => ({
  UpdateManager: {
    isStoreAvailable: jest.fn().mockResolvedValue(true)
  }
}));

jest.mock('../../src/utils/platform', () => ({
  supportsMCPBridge: jest.fn().mockReturnValue(false)
}));

jest.mock('../../src/settings/getStartedStatus', () => jest.requireActual('../../src/settings/getStartedStatus'));

jest.mock('../../src/components/UnifiedTabs', () => ({
  UnifiedTabs: jest.fn().mockImplementation((options) => {
    const pane = { empty: jest.fn() };
    return {
      getTabContent: jest.fn().mockImplementation((tabKey: string) => {
        if (tabKey === 'data') {
          return pane;
        }
        return pane;
      }),
      destroy: jest.fn(),
      activateTab: jest.fn(),
      getActiveTab: jest.fn().mockReturnValue(options.defaultTab || 'defaults')
    };
  })
}));

jest.mock('../../src/settings/tabs/DefaultsTab', () => ({
  DefaultsTab: mockDefaultsTab
}));

jest.mock('../../src/settings/tabs/WorkspacesTab', () => ({
  WorkspacesTab: mockWorkspacesTab
}));

jest.mock('../../src/settings/tabs/InstructionsTab', () => ({
  InstructionsTab: mockPromptsTab
}));

jest.mock('../../src/settings/tabs/ProvidersTab', () => ({
  ProvidersTab: mockProvidersTab
}));

jest.mock('../../src/settings/tabs/RemoteAgentsTab', () => ({
  RemoteAgentsTab: mockRemoteAgentsTab
}));

jest.mock('../../src/settings/tabs/AppsTab', () => ({
  AppsTab: mockAppsTab
}));

jest.mock('../../src/settings/tabs/DataTab', () => ({
  DataTab: mockDataTab
}));

jest.mock('../../src/components/Accordion', () => ({
  Accordion: jest.fn().mockImplementation(() => ({
    rootEl: {
      addClass: jest.fn()
    },
    itemsEl: {
      addClass: jest.fn()
    },
    unload: jest.fn()
  }))
}));

import { createMockElement } from '../helpers/mockFactories';
import { SettingsView } from '../../src/settings/SettingsView';

describe('SettingsView data tab wiring', () => {
  it('includes the data tab and renders it when selected', () => {
    const plugin = {
      manifest: { id: 'nexus', version: '5.7.2' },
    };
    const settingsManager = {
      settings: {
        llmProviders: {},
        availableUpdateVersion: undefined,
        storage: {
          schemaVersion: 2,
          rootPath: 'Assistant data',
          maxShardBytes: 4 * 1024 * 1024
        }
      },
      saveSettings: jest.fn()
    };
    const view = new SettingsView(
      { vault: { configDir: '.obsidian' }, workspace: {} } as never,
      plugin as never,
      settingsManager as never
    );
    (view as unknown as { containerEl: HTMLElement }).containerEl = createMockElement('div') as unknown as HTMLElement;

    view.display();

    const tabsCall = (jest.requireMock('../../src/components/UnifiedTabs').UnifiedTabs as jest.Mock).mock.calls[0][0];
    expect(tabsCall.tabs).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'data', label: 'Data' })
    ]));

    (view as unknown as { router: { setTab(tab: string): void } }).router.setTab('data');

    expect(mockDataTab).toHaveBeenCalled();
  });
});


it('saves accordion toggles and restores them in a new settings/view instance', async () => {
  const { Settings } = await import('../../src/settings');
  const bridge = jest.requireMock('../../src/utils/platform').supportsMCPBridge as jest.Mock;
  bridge.mockReturnValue(true);
  const accordion = jest.requireMock('../../src/components/Accordion').Accordion as jest.Mock;
  let saved: Record<string, unknown> = { getStartedOpen: true };
  const app = { vault: { configDir: '.obsidian' }, workspace: {} };
  const plugin = {
    app,
    manifest: { id: 'nexus', version: 'test' },
    loadData: jest.fn(async () => saved),
    saveData: jest.fn(async (data: Record<string, unknown>) => { saved = JSON.parse(JSON.stringify(data)); })
  };
  const render = (manager: InstanceType<typeof Settings>) => {
    const view = new SettingsView(app as never, plugin as never, manager);
    view.containerEl = createMockElement('div') as unknown as HTMLElement;
    // Content is unrelated; exercise the actual accordion policy and save callback.
    jest.spyOn(view as unknown as { renderGetStartedContent(): Promise<void> }, 'renderGetStartedContent').mockResolvedValue();
    view.display();
    return view;
  };
  try {
    const first = new Settings(plugin as never);
    await first.loadSettings();
    const view = render(first);
    expect(accordion.mock.calls[accordion.mock.calls.length - 1][1].open).toBe(true);
    expect(accordion.mock.calls[accordion.mock.calls.length - 1][1]).toEqual(expect.objectContaining({ id: 'get-started', title: 'Get started', icon: 'rocket' }));
    accordion.mock.calls[accordion.mock.calls.length - 1][1].onToggle(false);
    // Drain the real settings save lock and promise chain.
    await new Promise(resolve => setImmediate(resolve));
    expect(plugin.saveData).toHaveBeenCalledWith(expect.objectContaining({ getStartedOpen: false }));
    view.cleanup();

    const reloaded = new Settings(plugin as never);
    await reloaded.loadSettings();
    const secondView = render(reloaded);
    expect(accordion.mock.calls[accordion.mock.calls.length - 1][1].open).toBe(false);
    accordion.mock.calls[accordion.mock.calls.length - 1][1].onToggle(true);
    await new Promise(resolve => setImmediate(resolve));
    const reopened = new Settings(plugin as never);
    await reopened.loadSettings();
    expect(reopened.settings.getStartedOpen).toBe(true);
    secondView.cleanup();
  } finally {
    bridge.mockReturnValue(false);
  }
});
