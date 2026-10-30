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

describe('OpenAICodexDeviceAuth', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    __setRequestUrlMock(mockRequestUrl);
  });

  it('requests a device code, polls approval, and exchanges for OAuth tokens', async () => {
    mockRequestUrl
      .mockResolvedValueOnce(reply(200, { device_auth_id: 'device-id', user_code: 'ABCD-1234', interval: '0' }))
      .mockResolvedValueOnce(reply(403))
      .mockResolvedValueOnce(reply(200, { authorization_code: 'auth-code', code_verifier: 'verifier', code_challenge: 'challenge' }))
      .mockResolvedValueOnce(reply(200, { access_token: 'access', refresh_token: 'refresh', id_token: token(), expires_in: 3600 }));

    const onDeviceCode = jest.fn();
    const result = await new OpenAICodexDeviceAuth().start(onDeviceCode);

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
  }, 10000);

  it('rejects malformed device authorization responses', async () => {
    mockRequestUrl.mockResolvedValueOnce(reply(200, { user_code: 'MISSING-ID' }));
    await expect(new OpenAICodexDeviceAuth().start(jest.fn()))
      .rejects.toThrow('invalid response');
  });

  it('rejects unavailable device-code authorization', async () => {
    mockRequestUrl.mockResolvedValueOnce(reply(404));
    await expect(new OpenAICodexDeviceAuth().start(jest.fn()))
      .rejects.toThrow();
  });
  it('treats HTTP 404 during polling as pending and continues until approval', async () => {
    mockRequestUrl
      .mockResolvedValueOnce(reply(200, { device_auth_id: 'device-id', user_code: 'ABCD-1234', interval: 0 }))
      .mockResolvedValueOnce(reply(404))
      .mockResolvedValueOnce(reply(200, { authorization_code: 'auth-code', code_verifier: 'verifier', code_challenge: 'challenge' }))
      .mockResolvedValueOnce(reply(200, { access_token: 'access', refresh_token: 'refresh', id_token: token(), expires_in: 3600 }));

    const result = await new OpenAICodexDeviceAuth().start(jest.fn());
    expect(result.apiKey).toBe('access');
    expect(mockRequestUrl).toHaveBeenCalledTimes(4);
  }, 10000);

  it('rejects invalid approval data without attempting token exchange', async () => {
    mockRequestUrl
      .mockResolvedValueOnce(reply(200, { device_auth_id: 'device-id', user_code: 'ABCD-1234', interval: 0 }))
      .mockResolvedValueOnce(reply(200, { authorization_code: 'auth-code' }));

    await expect(new OpenAICodexDeviceAuth().start(jest.fn()))
      .rejects.toThrow('invalid approval');
    expect(mockRequestUrl).toHaveBeenCalledTimes(2);
  }, 10000);

  it('stops polling on unexpected server errors', async () => {
    mockRequestUrl
      .mockResolvedValueOnce(reply(200, { device_auth_id: 'device-id', user_code: 'ABCD-1234', interval: 0 }))
      .mockResolvedValueOnce(reply(500, { error: 'server error' }));

    await expect(new OpenAICodexDeviceAuth().start(jest.fn()))
      .rejects.toThrow();
    expect(mockRequestUrl).toHaveBeenCalledTimes(2);
  }, 10000);

});
