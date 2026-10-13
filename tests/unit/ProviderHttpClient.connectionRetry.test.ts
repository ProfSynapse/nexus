/** A connect failure can be replayed; a possibly delivered POST cannot. */
import { EventEmitter } from 'node:events';

const mockRequest = jest.fn();
jest.mock('../../src/utils/platform', () => ({
  isDesktop: () => true, hasNodeRuntime: () => true,
}));
jest.mock('../../src/utils/desktopRequire', () => ({
  desktopRequire: () => ({ request: mockRequest }),
}));
import { ProviderHttpClient } from '../../src/services/llm/adapters/shared/ProviderHttpClient';

class RequestFixture extends EventEmitter {
  reusedSocket = false;
  write = jest.fn();
  end = jest.fn();
  setTimeout = jest.fn();
  destroy = jest.fn((error?: Error) => {
    if (error) this.emit('error', error);
    this.emit('close');
  });
}

const config = { url: 'https://api.example.com/messages', provider: 'anthropic', operation: 'streaming generation', body: 'same-request' };
const connectError = (code = 'ETIMEDOUT') => Object.assign(new Error(''), { code, syscall: 'connect' });
const aggregate = () => Object.assign(new AggregateError([connectError(), connectError('ENETUNREACH')], ''), { code: 'ETIMEDOUT' });

describe('ProviderHttpClient safe connection retry', () => {
  let requests: RequestFixture[];
  let responses: Array<(response: EventEmitter & { statusCode: number }) => void>;

  beforeEach(() => {
    jest.useFakeTimers();
    requests = [];
    responses = [];
    mockRequest.mockReset().mockImplementation((_options, callback) => {
      const request = new RequestFixture();
      requests.push(request);
      responses.push(callback);
      return request;
    });
  });
  afterEach(() => jest.useRealTimers());

  function socket(index = 0, connecting = true): EventEmitter {
    const value = Object.assign(new EventEmitter(), { connecting });
    requests[index].emit('socket', value);
    return value;
  }

  it('retries one fresh preconnect aggregate failure with the exact request body', async () => {
    const pending = ProviderHttpClient.requestStream(config);
    socket();
    requests[0].emit('error', aggregate());
    await jest.advanceTimersByTimeAsync(250);
    expect(requests).toHaveLength(2);
    const response = Object.assign(new EventEmitter(), { statusCode: 200 });
    responses[1](response);
    expect(await pending).toBe(response);
    expect(requests.map(request => request.write.mock.calls)).toEqual([[['same-request']], [['same-request']]]);
  });

  it('stops after one retry and gives empty AggregateError a meaningful message and cause', async () => {
    const pending = ProviderHttpClient.requestStream(config).catch(error => error);
    socket();
    requests[0].emit('error', aggregate());
    await jest.advanceTimersByTimeAsync(250);
    const last = aggregate();
    socket(1);
    requests[1].emit('error', last);
    const error = await pending;
    expect(error.message).toContain('anthropic at api.example.com');
    expect(error.message).toContain('ETIMEDOUT');
    expect(error.message).toContain('ENETUNREACH');
    expect(error.cause).toBe(last);
    await jest.runAllTimersAsync();
    expect(requests).toHaveLength(2);
  });

  it.each(['connect', 'secureConnect', 'reused', 'reused-after-socket', 'already-connected', 'unknown-socket', 'reset', 'wrong-syscall', 'mixed-aggregate'])('never retries an unsafe or unproven failure: %s', async mode => {
    const pending = ProviderHttpClient.requestStream(config).catch(error => error);
    requests[0].reusedSocket = mode === 'reused';
    if (mode !== 'unknown-socket') {
      const connection = socket(0, mode !== 'already-connected');
      if (mode === 'connect' || mode === 'secureConnect') connection.emit(mode);
    }
    if (mode === 'reused-after-socket') requests[0].reusedSocket = true;
    const error = mode === 'mixed-aggregate' ? new AggregateError([connectError(), new Error('unknown')], '')
      : mode === 'wrong-syscall' ? Object.assign(connectError(), { syscall: 'read' })
        : connectError(mode === 'reset' ? 'ECONNRESET' : 'ETIMEDOUT');
    requests[0].emit('error', error);
    await jest.runAllTimersAsync();
    expect(await pending).toBeInstanceOf(Error);
    expect(requests).toHaveLength(1);
  });

  it('does not retry a rejected HTTP response', async () => {
    const pending = ProviderHttpClient.requestStream(config).catch(error => error);
    socket();
    const response = Object.assign(new EventEmitter(), { statusCode: 429 });
    responses[0](response);
    response.emit('data', Buffer.from('{"error":{"message":"rate limited"}}'));
    response.emit('end');
    expect((await pending).response.status).toBe(429);
    await jest.runAllTimersAsync();
    expect(requests).toHaveLength(1);
  });

  it('leaves errors after response delivery with the stream consumer', async () => {
    const pending = ProviderHttpClient.requestStream(config);
    socket();
    const response = Object.assign(new EventEmitter(), { statusCode: 200 });
    const listener = jest.fn();
    response.on('error', listener);
    responses[0](response);
    expect(await pending).toBe(response);
    response.emit('error', connectError('ECONNRESET'));
    await jest.runAllTimersAsync();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(requests).toHaveLength(1);
  });

  it('cancels the retry delay when stopped', async () => {
    const controller = new AbortController();
    const pending = ProviderHttpClient.requestStream({ ...config, signal: controller.signal }).catch(error => error);
    socket();
    requests[0].emit('error', aggregate());
    await jest.advanceTimersByTimeAsync(10);
    controller.abort();
    await jest.runAllTimersAsync();
    expect((await pending).name).toBe('AbortError');
    expect(requests).toHaveLength(1);
  });

  it('does not create a request for an already aborted signal', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(ProviderHttpClient.requestStream({ ...config, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(requests).toHaveLength(0);
  });

  it('aborts an active connecting request without retrying', async () => {
    const controller = new AbortController();
    const pending = ProviderHttpClient.requestStream({ ...config, signal: controller.signal }).catch(error => error);
    socket();
    controller.abort();
    expect((await pending).name).toBe('AbortError');
    await jest.runAllTimersAsync();
    expect(requests).toHaveLength(1);
  });
});
