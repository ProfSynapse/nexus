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

jest.mock('../../src/settings/getStartedStatus', () => ({
  getConfigStatus: jest.fn().mockReturnValue('nexus-configured'),
  hasConfiguredProviders: jest.fn().mockReturnValue(true)
}));

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

jest.mock('../../src/settings/tabs/PromptsTab', () => ({
  PromptsTab: mockPromptsTab
}));

jest.mock('../../src/settings/tabs/ProvidersTab', () => ({
  ProvidersTab: mockProvidersTab
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
    getContentEl: jest.fn().mockReturnValue({
      addClass: jest.fn()
    }),
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
