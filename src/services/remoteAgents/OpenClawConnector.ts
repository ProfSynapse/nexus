import { validateRemoteAgentConnection } from './RemoteAgentConfig';
import { OpenClawWebSocketTransport, type OpenClawSession, type OpenClawTransport } from './OpenClawWebSocketTransport';
import { RemoteAgentError, type RemoteAgentConnection, type RemoteAgentConnector, type RemoteAgentProbe, type RemoteAgentRequest, type RemoteAgentRun } from './types';

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function redactRemoteAgentText(value: string, connection: RemoteAgentConnection): string {
  const key = connection.apiKey?.trim();
  return (key ? value.split(key).join('[redacted]') : value).replace(/\bBearer\s+[^\s"'<>]+/gi, 'Bearer [redacted]');
}
function timestamp(value: unknown): string | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 8_640_000_000_000_000 ? new Date(value).toISOString() : undefined;
}
function identifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value || value.length > 1024 || Array.from(value).some(c => c.charCodeAt(0) < 33 || c.charCodeAt(0) === 127)) {
    throw new RemoteAgentError(`${label} is missing or invalid.`, 'INVALID_CONFIG');
  }
  return value;
}
function taskKey(value: string): string {
  const key = identifier(value, 'Submission key');
  if (key.length > 255 || Array.from(key).some(c => c.charCodeAt(0) > 126)) throw new RemoteAgentError('Use a submission key of 1–255 visible ASCII characters.', 'INVALID_CONFIG');
  return key;
}
function text(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return undefined;
  const parts = value.map(record).filter(part => part?.type === 'text' && typeof part.text === 'string').map(part => part?.text as string);
  return parts.length ? parts.join('\n') : undefined;
}
function normalizeRun(value: unknown, id: string, sessionId: string, connection: RemoteAgentConnection): RemoteAgentRun {
  const body = record(value);
  if (!body || (body.runId !== undefined && body.runId !== id) || (body.sessionKey !== undefined && body.sessionKey !== sessionId)) throw new RemoteAgentError('OpenClaw returned a different or invalid run identity.', 'PROTOCOL');
  const status = typeof body.status === 'string' ? body.status : 'unknown';
  const result: RemoteAgentRun = { runId: id, sessionId, state: 'unknown', remoteStatus: redactRemoteAgentText(status, connection) };
  const ended = timestamp(body.endedAt);
  const reason = body.stopReason;
  if (ended && reason === 'rpc' && (status === 'error' || status === 'timeout')) result.state = 'cancelled';
  else if (ended && status === 'ok') {
    const reply = record(body.terminalReply);
    const output = typeof reply?.text === 'string' ? reply.text : text(record(body.result)?.payloads);
    if (reason === 'length' || !output?.trim()) {
      result.state = 'needs_attention';
      result.error = reason === 'length' ? 'The OpenClaw result was truncated.' : 'OpenClaw finished without a recoverable final reply.';
    } else { result.state = 'completed'; result.output = redactRemoteAgentText(output, connection); }
  } else if (ended && (status === 'error' || status === 'timeout')) {
    result.state = 'failed';
    result.error = typeof body.error === 'string' ? redactRemoteAgentText(body.error, connection) : 'OpenClaw ended this run with an error.';
  } else if (status === 'accepted' || status === 'in_flight') result.state = body.admissionPending === true ? 'queued' : 'running';
  if (ended) result.updatedAt = ended;
  return result;
}

/** OpenClaw owns tools. History recovery never authorizes replay of an uncertain submission. */
export class OpenClawConnector implements RemoteAgentConnector {
  readonly kind = 'openclaw' as const;
  constructor(private readonly transport: OpenClawTransport = new OpenClawWebSocketTransport()) {}
  private async withSession<T>(connection: RemoteAgentConnection, signal: AbortSignal | undefined, fn: (session: OpenClawSession) => Promise<T>): Promise<T> {
    validateRemoteAgentConnection(connection);
    if (connection.connector !== 'openclaw') throw new RemoteAgentError('This connection is not an OpenClaw gateway.', 'INVALID_CONFIG');
    const session = await this.transport.connect(connection, signal);
    try { return await fn(session); } finally { session.close(); }
  }
  private sessionId(request?: RemoteAgentRequest, key?: string): string {
    const id = identifier(request?.sessionId, 'Persisted OpenClaw session key');
    if (!/^agent:[a-z0-9_-]+:explicit:nexus-[^:]+$/i.test(id) || (key && !id.endsWith(`:explicit:nexus-${encodeURIComponent(key)}`))) throw new RemoteAgentError('Recover OpenClaw only with its original prepared session key.', 'INVALID_CONFIG');
    return id;
  }
  async prepareRequest(connection: RemoteAgentConnection, request: RemoteAgentRequest, idempotencyKey: string): Promise<RemoteAgentRequest> {
    const key = taskKey(idempotencyKey);
    if (!request || typeof request.input !== 'string' || !request.input.trim() || (request.instructions !== undefined && typeof request.instructions !== 'string')) {
      throw new RemoteAgentError('An OpenClaw task requires non-empty text input.', 'INVALID_CONFIG');
    }
    if (request.sessionId) { this.sessionId(request, key); return { ...request }; }
    return this.withSession(connection, undefined, async session => {
      const health = record(await session.request('health'));
      const defaultAgent = health?.defaultAgentId;
      if (typeof defaultAgent !== 'string' || !/^[a-z0-9_-]+$/i.test(defaultAgent)) throw new RemoteAgentError('OpenClaw did not identify its default agent.', 'PROTOCOL');
      return { ...request, sessionId: `agent:${defaultAgent}:explicit:nexus-${encodeURIComponent(key)}` };
    });
  }
  async submit(connection: RemoteAgentConnection, request: RemoteAgentRequest, idempotencyKey: string, signal?: AbortSignal): Promise<RemoteAgentRun> {
    const key = taskKey(idempotencyKey);
    const sessionId = this.sessionId(request, key);
    if (typeof request.input !== 'string' || !request.input.trim() || (request.instructions !== undefined && typeof request.instructions !== 'string')) throw new RemoteAgentError('An OpenClaw task requires non-empty text input.', 'INVALID_CONFIG');
    return this.withSession(connection, signal, async session => {
      const params: Record<string, unknown> = { sessionKey: sessionId, idempotencyKey: key, message: request.input, deliver: false };
      if (request.instructions?.trim()) params.extraSystemPrompt = request.instructions;
      const value = await session.request('agent', params, signal);
      try { return normalizeRun(value, key, sessionId, connection); }
      catch { throw new RemoteAgentError('OpenClaw acknowledged submission without a valid run identity. Recover through the saved session; do not resubmit automatically.', 'PROTOCOL', undefined, true); }
    });
  }
  async get(connection: RemoteAgentConnection, runId: string, signal?: AbortSignal, request?: RemoteAgentRequest): Promise<RemoteAgentRun> {
    const id = taskKey(runId);
    const sessionId = this.sessionId(request, id);
    return this.withSession(connection, signal, session => this.readRun(session, connection, id, sessionId, signal));
  }
  private async readRun(session: OpenClawSession, connection: RemoteAgentConnection, id: string, sessionId: string, signal?: AbortSignal): Promise<RemoteAgentRun> {
      const waited = normalizeRun(await session.request('agent.wait', { runId: id, timeoutMs: 250 }, signal), id, sessionId, connection);
      if (waited.state === 'completed' || waited.state === 'failed' || waited.state === 'cancelled') return waited;
      const history = record(await session.request('sessions.get', { key: sessionId, limit: 1000 }, signal));
      if (!Array.isArray(history?.messages)) throw new RemoteAgentError('OpenClaw returned an invalid session-history response.', 'PROTOCOL');
      const messages = history.messages as unknown[];
      for (const row of [...messages].reverse()) {
        const message = record(row);
        if (message?.role !== 'assistant' || record(message.__openclaw)?.runId !== id) continue;
        const reason = message.stopReason;
        if (reason === 'toolUse') continue;
        if (reason === 'aborted' || reason === 'error') return { runId: id, sessionId, remoteStatus: String(reason), state: reason === 'aborted' ? 'cancelled' : 'failed', error: 'OpenClaw recorded a terminal run interruption.' };
        if (reason !== 'stop' && reason !== 'end_turn' && reason !== 'length') continue;
        const output = text(message.content);
        if (!output?.trim()) continue;
        return { runId: id, sessionId, remoteStatus: 'history-recovered', state: reason === 'length' ? 'needs_attention' : 'completed', output: redactRemoteAgentText(output, connection),
          ...(reason === 'length' ? { error: 'The recovered OpenClaw reply was truncated.' } : {}),
          ...(typeof message.model === 'string' ? { model: redactRemoteAgentText(message.model, connection) } : {}),
          ...(timestamp(message.timestamp) ? { updatedAt: timestamp(message.timestamp) } : {}),
        };
      }
      return waited.state === 'needs_attention' ? waited : { runId: id, sessionId, remoteStatus: 'unconfirmed', state: 'unknown', error: 'No final reply is available for this run. It may still be running, interrupted or outside retained history. Do not resubmit automatically.' };
  }
  async cancel(connection: RemoteAgentConnection, runId: string, signal?: AbortSignal, request?: RemoteAgentRequest): Promise<RemoteAgentRun> {
    const id = taskKey(runId);
    const sessionId = this.sessionId(request, id);
    return this.withSession(connection, signal, async session => {
      const reply = record(await session.request('chat.abort', { runId: id, sessionKey: sessionId }, signal));
      const acknowledged = reply?.aborted === true && Array.isArray(reply.runIds) && reply.runIds.includes(id);
      const result = await this.readRun(session, connection, id, sessionId, signal);
      return result.state === 'unknown' && acknowledged ? { runId: id, sessionId, state: 'running', remoteStatus: 'stopping' } : result;
    });
  }
  async probe(connection: RemoteAgentConnection, signal?: AbortSignal): Promise<RemoteAgentProbe> {
    const checkedAt = Date.now();
    try {
      return await this.withSession(connection, signal, async session => {
        const methods = record(session.hello.features)?.methods;
        const scopes = record(session.hello.auth)?.scopes;
        const allowed = Array.isArray(scopes) && (scopes.includes('operator.admin') || (scopes.includes('operator.write') && scopes.includes('operator.read')));
        const available = Array.isArray(methods) && ['agent', 'agent.wait', 'chat.abort'].every(method => methods.includes(method));
        const health = record(await session.request('health', {}, signal));
        const defaultAgent = health?.defaultAgentId;
        let historyAvailable = false;
        if (allowed && available && typeof defaultAgent === 'string' && /^[a-z0-9_-]+$/i.test(defaultAgent)) {
          // Current gateways implement sessions.get but omit it from hello.methods.
          // Reading a nonexistent explicit key does not create a session or run a model.
          const history = record(await session.request('sessions.get', { key: `agent:${defaultAgent}:explicit:nexus-capability-probe`, limit: 1 }, signal));
          historyAvailable = Array.isArray(history?.messages);
        }
        const runsAvailable = allowed && available && historyAvailable;
        return { connected: true, checkedAt, runsAvailable, durableIdempotency: false, recoveryMode: 'session-history',
          ...(!runsAvailable ? { error: 'The gateway must grant read/write scopes and support submission, status, cancellation and session history.' } : {}) };
      });
    } catch (error) {
      return { connected: false, checkedAt, runsAvailable: false, durableIdempotency: false, recoveryMode: 'session-history', error: error instanceof RemoteAgentError ? error.message : 'OpenClaw connection check failed.' };
    }
  }
}
