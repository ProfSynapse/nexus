const noticeMock = jest.fn();

jest.mock('obsidian', () => {
  class App {}

  return {
    App,
    Notice: jest.fn((message: string) => {
      noticeMock(message);
    }),
  };
});

jest.mock('../../src/components/llm-provider/providers/OAuthModals', () => ({
  OAuthConsentModal: jest.fn().mockImplementation(() => ({
    open: jest.fn(),
  })),
  OAuthPreAuthModal: jest.fn().mockImplementation(() => ({
    open: jest.fn(),
  })),
}));

jest.mock('../../src/services/oauth/OAuthService', () => ({
  OAuthService: {
    getInstance: jest.fn(() => ({
      cancelFlow: jest.fn(),
    })),
  },
}));

import { App } from 'obsidian';
import { OAuthFlowManager } from '../../src/services/oauth/OAuthFlowManager';

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

describe('OAuthFlowManager notice timing', () => {
  beforeEach(() => {
    noticeMock.mockReset();
  });

  it('waits for onConnect persistence before showing the success notice', async () => {
    const deferred = createDeferred<void>();
    const onConnect = jest.fn().mockReturnValue(deferred.promise);
    const manager = new OAuthFlowManager({
      oauthConfig: {
        providerLabel: 'ChatGPT',
        startFlow: jest.fn().mockResolvedValue({
          success: true,
          apiKey: 'oauth-token',
        }),
      },
      providerId: 'openai-codex',
      app: new App(),
      callbacks: {
        onConnect,
        onDisconnect: jest.fn(),
        onConnectingChange: jest.fn(),
      },
    });

    const connectPromise = manager.connect();
    await Promise.resolve();

    expect(onConnect).toHaveBeenCalledWith({
      apiKey: 'oauth-token',
      refreshToken: undefined,
      expiresAt: undefined,
      metadata: undefined,
    });
    expect(noticeMock).not.toHaveBeenCalledWith('Connected to ChatGPT successfully');

    deferred.resolve();
    await connectPromise;

    expect(noticeMock).toHaveBeenCalledWith('Connected to ChatGPT successfully');
  });

  it('shows a connection failure notice when persistence rejects', async () => {
    const manager = new OAuthFlowManager({
      oauthConfig: {
        providerLabel: 'ChatGPT',
        startFlow: jest.fn().mockResolvedValue({
          success: true,
          apiKey: 'oauth-token',
        }),
      },
      providerId: 'openai-codex',
      app: new App(),
      callbacks: {
        onConnect: jest.fn().mockRejectedValue(new Error('disk full')),
        onDisconnect: jest.fn(),
        onConnectingChange: jest.fn(),
      },
    });

    await manager.connect();

    expect(noticeMock).toHaveBeenCalledWith('ChatGPT connection failed: disk full');
    expect(noticeMock).not.toHaveBeenCalledWith('Connected to ChatGPT successfully');
  });

  it('shows a disconnect failure notice instead of a false success notice', async () => {
    const manager = new OAuthFlowManager({
      oauthConfig: {
        providerLabel: 'ChatGPT',
        startFlow: jest.fn(),
      },
      providerId: 'openai-codex',
      app: new App(),
      callbacks: {
        onConnect: jest.fn(),
        onDisconnect: jest.fn().mockRejectedValue(new Error('disk full')),
        onConnectingChange: jest.fn(),
      },
    });

    await manager.disconnect();

    expect(noticeMock).toHaveBeenCalledWith('Failed to disconnect from ChatGPT: disk full');
    expect(noticeMock).not.toHaveBeenCalledWith('Disconnected from ChatGPT');
  });
});
