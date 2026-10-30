import { __setRequestUrlMock } from 'obsidian';
import { GithubCopilotOAuthProvider } from '../../src/services/oauth/providers/GithubCopilotOAuthProvider';

const mockRequestUrl = jest.fn();

function reply(json: Record<string, unknown>) {
  return { status: 200, headers: {}, text: JSON.stringify(json), json, arrayBuffer: new ArrayBuffer(0) };
}

describe('GithubCopilotOAuthProvider device flow', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    __setRequestUrlMock(mockRequestUrl);
    window.open = jest.fn();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('stops polling as soon as the flow is cancelled', async () => {
    mockRequestUrl
      .mockResolvedValueOnce(reply({ device_code: 'dev', user_code: 'WXYZ-0000', verification_uri: 'https://github.com/login/device' }))
      .mockResolvedValue(reply({ error: 'authorization_pending' }));

    const controller = new AbortController();
    const onCode = jest.fn();
    const flow = new GithubCopilotOAuthProvider().startDeviceFlow(onCode, controller.signal);
    const outcome = expect(flow).rejects.toThrow('cancelled');

    await jest.advanceTimersByTimeAsync(0);
    expect(onCode).toHaveBeenCalledWith('WXYZ-0000', 'https://github.com/login/device');
    expect(mockRequestUrl).toHaveBeenCalledTimes(2);

    controller.abort();
    await outcome;
    await jest.advanceTimersByTimeAsync(60_000);
    expect(mockRequestUrl).toHaveBeenCalledTimes(2);
  });
});
