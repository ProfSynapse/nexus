import { validateRemoteAgentConnection } from './RemoteAgentConfig';
import { OpenClawDeviceIdentityProvider } from './OpenClawDeviceIdentity';
import { RemoteAgentError, type RemoteAgentConnection } from './types';

export type OpenClawSocket = Pick<WebSocket, 'send' | 'close' | 'readyState' | 'onmessage' | 'onerror' | 'onclose' | 'onopen'>;
export interface OpenClawSession {
  hello: Record<string, unknown>;
  request(method: string, params?: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
  close(): void;
}
export interface OpenClawTransport {
  connect(connection: RemoteAgentConnection, signal?: AbortSignal): Promise<OpenClawSession>;
}
export interface OpenClawWebSocketOptions {
  createSocket?: (url: string) => OpenClawSocket;
  identity?: OpenClawDeviceIdentityProvider;
  timeoutMs?: number;
}
function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function rpcError(value: unknown): RemoteAgentError {
  const error = record(value);
  const details = record(error?.details);
  const code = typeof details?.code === 'string' ? details.code : typeof error?.code === 'string' ? error.code : '';
  if (code.includes('ORIGIN')) return new RemoteAgentError('OpenClaw rejected this app origin. Add app://obsidian.md to the gateway’s explicit allowed origins, keeping gateway authentication enabled.', 'UNSUPPORTED');
  if (code.includes('PAIRING') || code.includes('DEVICE_AUTH')) return new RemoteAgentError('OpenClaw requires approval of this device. Review the pending device and approve only Nexus read/write access on the gateway host.', 'UNSUPPORTED');
  if (code.includes('AUTH') || code === 'FORBIDDEN') return new RemoteAgentError('OpenClaw authentication or read/write permission was rejected. Check the gateway token and approved device scopes.', 'HTTP_ERROR', 403);
  if (code === 'INVALID_REQUEST') return new RemoteAgentError('OpenClaw rejected the RPC parameters or session identity.', 'PROTOCOL', 400);
  return new RemoteAgentError('OpenClaw rejected the request. Check the gateway’s supported protocol and availability.', 'PROTOCOL');
}
// Protocol errors describe explicit validation/authorization rejection. Operational
// failures can occur after work started, so they do not settle a sent agent request.
const KNOWN_REJECTIONS = new Set(['INVALID_REQUEST', 'FORBIDDEN', 'NOT_PAIRED', 'NOT_LINKED', 'APPROVAL_NOT_FOUND']);

/** Native browser transport. Each operation owns one bounded socket and never reconnects/replays. */
export class OpenClawWebSocketTransport implements OpenClawTransport {
  private readonly identity: OpenClawDeviceIdentityProvider;
  constructor(private readonly options: OpenClawWebSocketOptions = {}) {
    this.identity = options.identity ?? new OpenClawDeviceIdentityProvider();
  }
  async connect(connection: RemoteAgentConnection, signal?: AbortSignal): Promise<OpenClawSession> {
    const url = validateRemoteAgentConnection(connection);
    if (connection.connector !== 'openclaw') throw new RemoteAgentError('This connection is not an OpenClaw gateway.', 'INVALID_CONFIG');
    if (signal?.aborted) throw new RemoteAgentError('OpenClaw request was stopped locally.', 'ABORTED');
    const timeoutMs = this.options.timeoutMs ?? 30_000;
    let socket: OpenClawSocket;
    try {
      socket = this.options.createSocket ? this.options.createSocket(url) : new WebSocket(url);
    } catch { throw new RemoteAgentError('Cannot open the OpenClaw WebSocket connection on this device.', 'NETWORK'); }
    return new Promise((resolve, reject) => {
      let closed = false;
      let connected = false;
      let challenged = false;
      let counter = 0;
      const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; submitting: boolean; cleanup(): void }>();
      const stop = (error: RemoteAgentError) => {
        if (closed) return;
        closed = true;
        window.clearTimeout(deadline);
        signal?.removeEventListener('abort', abort);
        socket.onmessage = socket.onerror = socket.onclose = socket.onopen = null;
        try { socket.close(1000, 'Nexus operation finished'); } catch { /* Socket may already be closed. */ }
        for (const item of pending.values()) {
          item.cleanup();
          item.reject(new RemoteAgentError(error.message, error.code, error.status, item.submitting));
        }
        pending.clear();
        if (!connected) reject(error);
      };
      const abort = () => stop(new RemoteAgentError('OpenClaw request stopped locally; server work may continue.', 'ABORTED'));
      const deadline = window.setTimeout(() => stop(new RemoteAgentError('OpenClaw connection deadline expired; remote work is not confirmed.', 'TIMEOUT')), timeoutMs);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      const session: OpenClawSession = {
        hello: {},
        request: (method, params = {}, requestSignal) => new Promise((rpcResolve, rpcReject) => {
          if (closed || socket.readyState !== 1) { rpcReject(new RemoteAgentError('OpenClaw connection is closed.', 'NETWORK')); return; }
          if (requestSignal?.aborted) { rpcReject(new RemoteAgentError('OpenClaw request was stopped locally.', 'ABORTED')); return; }
          const id = `nexus-${++counter}`;
          const rpcAbort = () => stop(new RemoteAgentError('OpenClaw request stopped locally; remote work may continue.', 'ABORTED'));
          requestSignal?.addEventListener('abort', rpcAbort, { once: true });
          pending.set(id, { resolve: rpcResolve, reject: rpcReject, submitting: method === 'agent', cleanup: () => requestSignal?.removeEventListener('abort', rpcAbort) });
          try { socket.send(JSON.stringify({ type: 'req', id, method, params })); }
          catch { stop(new RemoteAgentError('Cannot send the OpenClaw request; its remote outcome is unconfirmed.', 'NETWORK')); }
        }),
        close: () => stop(new RemoteAgentError('OpenClaw operation finished locally.', 'ABORTED')),
      };
      socket.onerror = () => stop(new RemoteAgentError('Cannot reach the OpenClaw gateway. Check its address, TLS certificate and availability.', 'NETWORK'));
      socket.onclose = () => stop(new RemoteAgentError('OpenClaw closed the connection; remote work may continue.', 'NETWORK'));
      socket.onmessage = event => {
        let frame: Record<string, unknown> | undefined;
        try {
          if (typeof event.data !== 'string' || event.data.length > 4 * 1024 * 1024) throw new Error();
          frame = record(JSON.parse(event.data));
          if (!frame) throw new Error();
        } catch { stop(new RemoteAgentError('OpenClaw returned a malformed or oversized protocol frame.', 'PROTOCOL')); return; }
        if (frame.type === 'event' && frame.event === 'connect.challenge') {
          if (challenged) { stop(new RemoteAgentError('OpenClaw repeated its authentication challenge.', 'PROTOCOL')); return; }
          challenged = true;
          const challenge = record(frame.payload);
          const nonce = challenge?.nonce;
          const signedAt = challenge?.ts;
          if (typeof nonce !== 'string' || !nonce || nonce.length > 1024 || typeof signedAt !== 'number' || !Number.isSafeInteger(signedAt) || signedAt < 0) {
            stop(new RemoteAgentError('OpenClaw returned an invalid authentication challenge.', 'PROTOCOL')); return;
          }
          void this.identity.sign(`${connection.id}:${url}`, connection.apiKey?.trim() ?? '', nonce, signedAt).then(device => {
            if (closed) return;
            return session.request('connect', {
              minProtocol: 4, maxProtocol: 4,
              client: { id: 'gateway-client', displayName: 'Nexus', version: '1.0', platform: 'obsidian', deviceFamily: 'nexus', mode: 'backend' },
              role: 'operator', scopes: ['operator.read', 'operator.write'], caps: [],
              auth: { token: connection.apiKey?.trim() ?? '' }, device,
            }, signal).then(value => {
              if (closed) return;
              const hello = record(value);
              if (hello?.type !== 'hello-ok' || hello.protocol !== 4 || !record(hello.auth) || !record(hello.features)) {
                stop(new RemoteAgentError('OpenClaw did not negotiate the supported Gateway protocol.', 'PROTOCOL')); return;
              }
              session.hello = hello;
              connected = true;
              resolve(session);
            });
          }).catch(error => stop(error instanceof RemoteAgentError ? error : new RemoteAgentError('OpenClaw authentication failed.', 'PROTOCOL')));
        } else if (frame.type === 'res' && typeof frame.id === 'string') {
          const item = pending.get(frame.id);
          if (!item) return;
          const error = record(frame.error);
          if (typeof frame.ok !== 'boolean' || (frame.ok === false
            && (typeof error?.code !== 'string' || !error.code.trim()
              || typeof error.message !== 'string' || !error.message.trim()))) {
            stop(new RemoteAgentError('OpenClaw returned a malformed acknowledgement; the remote outcome is unconfirmed.', 'PROTOCOL'));
            return;
          }
          pending.delete(frame.id);
          item.cleanup();
          if (frame.ok === true) item.resolve(frame.payload);
          else {
            const failure = rpcError(error);
            const unknown = item.submitting && !KNOWN_REJECTIONS.has(error?.code as string);
            item.reject(new RemoteAgentError(failure.message, failure.code, failure.status, unknown));
          }
        }
      };
    });
  }
}
