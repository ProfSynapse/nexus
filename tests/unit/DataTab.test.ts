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
      callback({
        setButtonText: jest.fn().mockReturnThis(),
        setDisabled: jest.fn().mockReturnThis(),
        setCta: jest.fn().mockReturnThis(),
        onClick: jest.fn(),
        setIcon: jest.fn().mockReturnThis()
      });
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
    Notice: jest.fn(),
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
    expect(container.createDiv).toHaveBeenCalledTimes(2);
    expect(container.createDiv).toHaveBeenNthCalledWith(1, 'csr-section');
    expect(container.createDiv).toHaveBeenNthCalledWith(2, 'csr-section');

    const exportSection = container.createDiv.mock.results[0].value as {
      createDiv: jest.Mock;
    };
    const storageSection = container.createDiv.mock.results[1].value as {
      createDiv: jest.Mock;
    };

    expect(exportSection.createDiv).toHaveBeenCalledWith('csr-section-header');
    expect(storageSection.createDiv).toHaveBeenCalledWith('csr-section-header');
    expect(exportSection.createDiv.mock.results[0].value.setText).toHaveBeenCalledWith('Export');
    expect(storageSection.createDiv.mock.results[0].value.setText).toHaveBeenCalledWith('Storage');
    expect(serviceManager.getService).toHaveBeenCalledWith('hybridStorageAdapter');
  });
});
