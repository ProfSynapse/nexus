import { __setRequestUrlMock } from 'obsidian';
import { OpenAICodexDeviceAuth } from '../../src/services/oauth/providers/OpenAICodexDeviceAuth';

const mockRequestUrl = jest.fn();

function reply(status: number, json: Record<string, unknown> = {}) {
  return {
    status,
    headers: {},
    text: JSON.stringify(json),
    json,
    arrayBuffer: new ArrayBuffer(0),
  };
}

function token(): string {
  const claims = btoa(JSON.stringify({ chatgpt_account_id: 'account-test' }))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  return `header.${claims}.signature`;
}

const deviceStart = { device_auth_id: 'device-id', user_code: 'ABCD-1234', interval: 5 };
const approval = { authorization_code: 'auth-code', code_verifier: 'verifier', code_challenge: 'challenge' };
const tokens = () => ({ access_token: 'access', refresh_token: 'refresh', id_token: token(), expires_in: 3600 });

/** Run a flow to completion, advancing fake timers past every poll interval. */
async function settle<T>(promise: Promise<T>): Promise<T> {
  let done = false;
  const tracked = promise.finally(() => { done = true; });
  tracked.catch(() => undefined);
  while (!done) {
    await jest.advanceTimersByTimeAsync(5000);
  }
  return tracked;
}

describe('OpenAICodexDeviceAuth', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    __setRequestUrlMock(mockRequestUrl);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('requests a device code, polls approval, and exchanges for OAuth tokens', async () => {
    mockRequestUrl
      .mockResolvedValueOnce(reply(200, { ...deviceStart, interval: '5' }))
      .mockResolvedValueOnce(reply(403))
      .mockResolvedValueOnce(reply(200, approval))
      .mockResolvedValueOnce(reply(200, tokens()));

    const onDeviceCode = jest.fn();
    const result = await settle(new OpenAICodexDeviceAuth().start(onDeviceCode));

    expect(onDeviceCode).toHaveBeenCalledWith('ABCD-1234', 'https://auth.openai.com/codex/device');
    expect(result.apiKey).toBe('access');
    expect(result.refreshToken).toBe('refresh');
    expect(result.metadata?.accountId).toBe('account-test');
    expect(mockRequestUrl).toHaveBeenCalledTimes(4);

    const first = mockRequestUrl.mock.calls[0][0];
    expect(first.url).toBe('https://auth.openai.com/api/accounts/deviceauth/usercode');
    expect(JSON.parse(first.body)).toEqual({ client_id: 'app_EMoamEEZ73f0CkXaXp7hrann' });

    const poll = mockRequestUrl.mock.calls[1][0];
    expect(JSON.parse(poll.body)).toEqual({ device_auth_id: 'device-id', user_code: 'ABCD-1234' });

    const exchange = mockRequestUrl.mock.calls[3][0];
    expect(exchange.url).toBe('https://auth.openai.com/oauth/token');
    expect(new URLSearchParams(exchange.body).get('redirect_uri')).toBe('https://auth.openai.com/deviceauth/callback');
  });

  it('waits the server-provided interval between polls', async () => {
    mockRequestUrl
      .mockResolvedValueOnce(reply(200, deviceStart))
      .mockResolvedValueOnce(reply(200, approval))
      .mockResolvedValueOnce(reply(200, tokens()));

    const flow = new OpenAICodexDeviceAuth().start(jest.fn());
    await jest.advanceTimersByTimeAsync(4999);
    expect(mockRequestUrl).toHaveBeenCalledTimes(1);

    await settle(flow);
    expect(mockRequestUrl).toHaveBeenCalledTimes(3);
  });

  it('rejects malformed device authorization responses', async () => {
    mockRequestUrl.mockResolvedValueOnce(reply(200, { user_code: 'MISSING-ID' }));
    await expect(new OpenAICodexDeviceAuth().start(jest.fn()))
      .rejects.toThrow('invalid response');
  });

  it('explains how to recover when device-code login cannot start', async () => {
    mockRequestUrl.mockResolvedValueOnce(reply(404));
    await expect(new OpenAICodexDeviceAuth().start(jest.fn()))
      .rejects.toThrow(/HTTP 404.*ChatGPT security settings/);
  });

  it('treats HTTP 404 during polling as pending and continues until approval', async () => {
    mockRequestUrl
      .mockResolvedValueOnce(reply(200, deviceStart))
      .mockResolvedValueOnce(reply(404))
      .mockResolvedValueOnce(reply(200, approval))
      .mockResolvedValueOnce(reply(200, tokens()));

    const result = await settle(new OpenAICodexDeviceAuth().start(jest.fn()));
    expect(result.apiKey).toBe('access');
    expect(mockRequestUrl).toHaveBeenCalledTimes(4);
  });

  it('rejects invalid approval data without attempting token exchange', async () => {
    mockRequestUrl
      .mockResolvedValueOnce(reply(200, deviceStart))
      .mockResolvedValueOnce(reply(200, { authorization_code: 'auth-code' }));

    await expect(settle(new OpenAICodexDeviceAuth().start(jest.fn())))
      .rejects.toThrow('invalid approval');
    expect(mockRequestUrl).toHaveBeenCalledTimes(2);
  });

  it('stops polling on unexpected server errors', async () => {
    mockRequestUrl
      .mockResolvedValueOnce(reply(200, deviceStart))
      .mockResolvedValueOnce(reply(500, { error: 'server error' }));

    await expect(settle(new OpenAICodexDeviceAuth().start(jest.fn())))
      .rejects.toThrow();
    expect(mockRequestUrl).toHaveBeenCalledTimes(2);
  });

  it('stops polling as soon as the flow is cancelled', async () => {
    mockRequestUrl
      .mockResolvedValueOnce(reply(200, deviceStart))
      .mockResolvedValue(reply(403));

    const controller = new AbortController();
    const flow = new OpenAICodexDeviceAuth().start(jest.fn(), controller.signal);
    const outcome = expect(flow).rejects.toThrow('cancelled');

    await jest.advanceTimersByTimeAsync(5000);
    expect(mockRequestUrl).toHaveBeenCalledTimes(2);

    controller.abort();
    await outcome;
    await jest.advanceTimersByTimeAsync(60_000);
    expect(mockRequestUrl).toHaveBeenCalledTimes(2);
  });
});
