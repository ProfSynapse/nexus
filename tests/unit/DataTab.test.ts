const mockButtons: Array<{
  setButtonText: jest.Mock;
  setDisabled: jest.Mock;
  setCta: jest.Mock;
  onClick: jest.Mock;
  setIcon: jest.Mock;
  click?: () => void;
}> = [];

const mockNotices: Array<{ message: string; timeout?: number; hide: jest.Mock }> = [];

jest.mock('obsidian', () => {
  class MockSetting {
    constructor(_container: HTMLElement) {}

    setName = jest.fn().mockReturnThis();
    setDesc = jest.fn().mockReturnThis();
    addText = jest.fn().mockImplementation((callback: (component: {
      setDisabled: jest.Mock;
      setValue: jest.Mock;
      setPlaceholder: jest.Mock;
      inputEl: HTMLInputElement;
    }) => void) => {
      callback({
        setDisabled: jest.fn().mockReturnThis(),
        setValue: jest.fn().mockReturnThis(),
        setPlaceholder: jest.fn().mockReturnThis(),
        inputEl: {
          value: '',
          readOnly: false
        } as HTMLInputElement
      });
      return this;
    });
    addButton = jest.fn().mockImplementation((callback: (component: {
      setButtonText: jest.Mock;
      setDisabled: jest.Mock;
      setCta: jest.Mock;
      onClick: jest.Mock;
      setIcon: jest.Mock;
    }) => void) => {
      const button = {
        setButtonText: jest.fn().mockReturnThis(),
        setDisabled: jest.fn().mockReturnThis(),
        setCta: jest.fn().mockReturnThis(),
        onClick: jest.fn().mockImplementation((handler: () => void) => {
          button.click = handler;
          return button;
        }),
        setIcon: jest.fn().mockReturnThis()
      };
      mockButtons.push(button);
      callback(button);
      return this;
    });
  }

  return {
    App: jest.fn(),
    Plugin: jest.fn(),
    PluginSettingTab: class {
      app: unknown;
      plugin: unknown;
      containerEl: HTMLElement;

      constructor(app: unknown, plugin: unknown) {
        this.app = app;
        this.plugin = plugin;
        this.containerEl = document.createElement('div');
      }
    },
    Notice: jest.fn().mockImplementation((message: string, timeout?: number) => {
      const notice = { message, timeout, hide: jest.fn() };
      mockNotices.push(notice);
      return notice;
    }),
    ButtonComponent: jest.fn(),
    Setting: MockSetting,
    TextComponent: jest.fn(),
    Platform: { isMobile: false, isDesktop: true },
    normalizePath: (value: string) => value
      .replace(/\\/g, '/')
      .replace(/^\/+/, '')
      .replace(/\/+$/, '')
      .replace(/\/{2,}/g, '/')
  };
}, { virtual: true });

import { DataTab } from '../../src/settings/tabs/DataTab';
import { createMockElement } from '../helpers/mockFactories';

describe('DataTab', () => {
  beforeEach(() => {
    mockButtons.length = 0;
    mockNotices.length = 0;
    jest.clearAllMocks();
  });

  it('renders storage controls in the data tab alongside export controls', async () => {
    const container = createMockElement('div');
    const serviceManager = {
      getService: jest.fn().mockResolvedValue({
        exportConversationsForFineTuning: jest.fn().mockResolvedValue('[]')
      })
    };

    const tab = new DataTab(container as unknown as HTMLElement, {
      app: {
        vault: {
          configDir: '.obsidian'
        }
      } as never,
      settings: {
        settings: {
          storage: {
            schemaVersion: 2,
            rootPath: 'Assistant data',
            maxShardBytes: 4 * 1024 * 1024
          }
        }
      } as never,
      serviceManager: serviceManager as never
    });

    tab.render();
    await Promise.resolve();

    expect(container.createEl).toHaveBeenCalledWith('h3', { text: 'Data management' });
    expect(container.createDiv).toHaveBeenCalledTimes(3);
    expect(container.createDiv).toHaveBeenNthCalledWith(1, 'csr-section');
    expect(container.createDiv).toHaveBeenNthCalledWith(2, 'csr-section');
    expect(container.createDiv).toHaveBeenNthCalledWith(3, 'csr-section');

    const exportSection = container.createDiv.mock.results[0].value as {
      createDiv: jest.Mock;
    };
    const storageSection = container.createDiv.mock.results[1].value as {
      createDiv: jest.Mock;
    };
    const maintenanceSection = container.createDiv.mock.results[2].value as {
      createDiv: jest.Mock;
    };

    expect(exportSection.createDiv).toHaveBeenCalledWith('csr-section-header');
    expect(storageSection.createDiv).toHaveBeenCalledWith('csr-section-header');
    expect(maintenanceSection.createDiv).toHaveBeenCalledWith('csr-section-header');
    expect(exportSection.createDiv.mock.results[0].value.setText).toHaveBeenCalledWith('Export');
    expect(storageSection.createDiv.mock.results[0].value.setText).toHaveBeenCalledWith('Storage');
    expect(maintenanceSection.createDiv.mock.results[0].value.setText).toHaveBeenCalledWith('Maintenance');
    expect(serviceManager.getService).toHaveBeenCalledWith('hybridStorageAdapter');
  });

  it('rebuild cache button calls adapter.rebuildCache', async () => {
    const container = createMockElement('div');
    const rebuildCache = jest.fn().mockResolvedValue(undefined);
    const serviceManager = {
      getService: jest.fn().mockResolvedValue({
        exportConversationsForFineTuning: jest.fn().mockResolvedValue('[]'),
        rebuildCache
      })
    };

    const tab = new DataTab(container as unknown as HTMLElement, {
      app: {
        vault: {
          configDir: '.obsidian'
        }
      } as never,
      settings: {
        settings: {
          storage: {
            schemaVersion: 2,
            rootPath: 'Nexus',
            maxShardBytes: 4 * 1024 * 1024
          }
        }
      } as never,
      serviceManager: serviceManager as never
    });

    tab.render();
    await Promise.resolve();

    const rebuildButton = mockButtons.find(button =>
      button.setButtonText.mock.calls.some(call => call[0] === 'Rebuild cache')
    );
    expect(rebuildButton).toBeDefined();

    rebuildButton?.click?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(rebuildCache).toHaveBeenCalledTimes(1);
    expect(rebuildButton?.setDisabled).toHaveBeenCalledWith(true);
    expect(rebuildButton?.setDisabled).toHaveBeenCalledWith(false);
    expect(mockNotices.some(notice => notice.message === 'Nexus cache rebuilt successfully.')).toBe(true);
  });
});
