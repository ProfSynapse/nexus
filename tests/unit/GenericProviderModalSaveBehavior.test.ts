const noticeMock = jest.fn();

jest.mock('obsidian', () => {
  class App {
    vault = {};
  }

  class Setting {
    constructor(_container: unknown) {}
    setDesc(): this { return this; }
    addText(_cb: (text: { inputEl: { type: string; addClass: jest.Mock }; setPlaceholder: () => unknown; setValue: () => unknown; onChange: () => unknown }) => void): this { return this; }
    addButton(): this { return this; }
    addToggle(): this { return this; }
  }

  return {
    App,
    Notice: jest.fn((message: string) => {
      noticeMock(message);
    }),
    Setting,
  };
});

jest.mock('../../src/services/llm/validation/ValidationService', () => ({
  LLMValidationService: jest.fn().mockImplementation(() => ({
    validateProvider: jest.fn().mockResolvedValue({ valid: true }),
  })),
}));

jest.mock('../../src/services/oauth/OAuthFlowManager', () => ({
  OAuthFlowManager: jest.fn().mockImplementation(() => ({
      connect: jest.fn(),
      disconnect: jest.fn(),
      cancelIfActive: jest.fn(),
    })),
}));

jest.mock('../../src/utils/pluginLocator', () => ({
  getNexusPlugin: jest.fn(() => null),
}));

import { App } from 'obsidian';
import { GenericProviderModal } from '../../src/components/llm-provider/providers/GenericProviderModal';
import type { ProviderModalConfig, ProviderModalDependencies } from '../../src/components/llm-provider/types';

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createConfig(onConfigChange: ProviderModalConfig['secondaryOAuthProvider'] extends infer T
  ? T extends { onConfigChange: infer Fn } ? Fn : never
  : never, statusOnly = true): ProviderModalConfig {
  return {
    providerId: 'google',
    providerName: 'Google AI',
    keyFormat: 'AIza...',
    signupUrl: 'https://aistudio.google.com/app/apikey',
    config: {
      enabled: true,
      apiKey: '',
    },
    onConfigChange: jest.fn(),
    secondaryOAuthProvider: {
      providerId: 'google-gemini-cli',
      providerLabel: 'Gemini CLI',
      description: 'CLI auth',
      config: {
        enabled: false,
        apiKey: '',
      },
      oauthConfig: {
        providerLabel: 'Gemini CLI',
        startFlow: jest.fn().mockResolvedValue({
          success: true,
          apiKey: 'cli-token',
          metadata: { account: 'test@example.com' },
        }),
      },
      onConfigChange,
      statusOnly,
      statusHint: 'run `gemini auth` in your terminal',
    },
  };
}

function createDeps(): ProviderModalDependencies {
  const app = new App();
  return {
    app,
    vault: app.vault,
    providerManager: {} as never,
    staticModelsService: { getConfigurableModelsForProvider: jest.fn(() => []) } as never,
  };
}

describe('GenericProviderModal secondary save behavior', () => {
  beforeEach(() => {
    noticeMock.mockReset();
  });

  it('waits for secondary CLI persistence before showing the authenticated notice', async () => {
    const deferred = createDeferred<void>();
    const config = createConfig(jest.fn().mockReturnValue(deferred.promise));
    const modal = new GenericProviderModal(config, createDeps());

    const checkPromise = (modal as unknown as { checkSecondaryCliStatus: () => Promise<void> }).checkSecondaryCliStatus();
    await Promise.resolve();

    expect(config.secondaryOAuthProvider?.onConfigChange).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'cli-token',
        enabled: true,
        oauth: expect.objectContaining({
          connected: true,
          providerId: 'google-gemini-cli',
        }),
      }),
    );
    expect(noticeMock).not.toHaveBeenCalledWith('Gemini CLI authenticated');

    deferred.resolve();
    await checkPromise;

    expect(noticeMock).toHaveBeenCalledWith('Gemini CLI authenticated');
  });

  it('reverts secondary CLI state when persistence fails', async () => {
    const config = createConfig(jest.fn().mockRejectedValue(new Error('disk full')));
    const modal = new GenericProviderModal(config, createDeps());

    await (modal as unknown as { checkSecondaryCliStatus: () => Promise<void> }).checkSecondaryCliStatus();

    expect(config.secondaryOAuthProvider?.config).toEqual({
      enabled: false,
      apiKey: '',
    });
    expect(noticeMock).not.toHaveBeenCalledWith('Gemini CLI authenticated');
  });
});
