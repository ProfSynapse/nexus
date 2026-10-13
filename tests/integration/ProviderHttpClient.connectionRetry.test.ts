/** Real Node socket ordering: a refused connect is retried, but only one POST arrives. */
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

const mockNativeRequest = jest.fn();
jest.mock('../../src/utils/platform', () => ({
  isDesktop: () => true, hasNodeRuntime: () => true,
}));
jest.mock('../../src/utils/desktopRequire', () => ({
  desktopRequire: (name: string) => ({ ...jest.requireActual(name), request: mockNativeRequest }),
}));
import { ProviderHttpClient } from '../../src/services/llm/adapters/shared/ProviderHttpClient';

it('recovers from a real refused connection without delivering the POST twice', async () => {
  const deliveredBodies: string[] = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += String(chunk); });
    request.on('end', () => {
      deliveredBodies.push(body);
      response.end('connected');
    });
  });
  const listen = (port: number): Promise<void> => new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  let restarting: Promise<void> | undefined;
  try {
    await listen(0);
    const port = (server.address() as AddressInfo).port;
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    mockNativeRequest.mockImplementation((options: http.RequestOptions, callback: (response: http.IncomingMessage) => void) => {
      const request = http.request(options, callback);
      if (mockNativeRequest.mock.calls.length === 1) {
        request.once('error', () => {
          // Begin listening only after Node reports a real closed-port error.
          restarting = listen(port);
          // Keep cleanup responsible for any startup failure, without an unhandled rejection.
          void restarting.catch(() => undefined);
        });
      }
      return request;
    });
    const stream = await ProviderHttpClient.requestStream({
      url: `http://127.0.0.1:${port}/stream`,
      provider: 'local-smoke',
      operation: 'connection recovery',
      body: 'one delivered body',
      timeoutMs: 2000,
    });
    await restarting;
    let output = '';
    for await (const chunk of stream) output += String(chunk);
    expect(output).toBe('connected');
    expect(mockNativeRequest).toHaveBeenCalledTimes(2);
    expect(deliveredBodies).toEqual(['one delivered body']);
  } finally {
    await restarting?.catch(() => undefined);
    server.closeAllConnections();
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
  }
}, 10_000);
