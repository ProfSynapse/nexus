import { ProviderHttpClient, type ProviderHttpResponse } from '../llm/adapters/shared/ProviderHttpClient';
import { normalizeOpenAICompatibleBaseUrl, openAICompatibleHeaders } from '../llm/adapters/openai-compatible/OpenAICompatibleConfig';
import {
  RemoteAgentError, type RemoteAgentConnection, type RemoteAgentConnector, type RemoteAgentProbe,
  type RemoteAgentRequest, type RemoteAgentRun, type RemoteAgentState,
} from './types';

export const HERMES_RUN_IDEMPOTENCY_RETENTION_MS = 24 * 60 * 60 * 1000;
export const REMOTE_AGENT_REQUEST_TIMEOUT_MS = 30_000;

type JsonRecord = Record<string, unknown>;
function record(value: unknown): JsonRecord | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : undefined;
}

export function normalizeRemoteAgentBaseUrl(value: string): string {
  let result: string;
  try { result = normalizeOpenAICompatibleBaseUrl(value); }
  catch { throw new RemoteAgentError('Enter a clean HTTPS API base URL, or HTTP on localhost, without credentials, queries or fragments.', 'INVALID_CONFIG'); }
  if (/\/(?:runs(?:\/.*)?|capabilities|health)$/i.test(new URL(result).pathname)) {
    throw new RemoteAgentError('Enter the API base prefix (usually ending /v1), not a Runs or health URL.', 'INVALID_CONFIG');
  }
  return result;
}

export function validateRemoteAgentConnection(connection: RemoteAgentConnection): string {
  if (!connection || connection.connector !== 'hermes' || typeof connection.id !== 'string'
    || !connection.id.trim() || typeof connection.displayName !== 'string' || !connection.displayName.trim()
    || typeof connection.enabled !== 'boolean' || typeof connection.baseUrl !== 'string'
    || (connection.apiKey !== undefined && typeof connection.apiKey !== 'string')
    || (connection.description !== undefined && typeof connection.description !== 'string')) {
    throw new RemoteAgentError('Remote agent connection settings are incomplete.', 'INVALID_CONFIG');
  }
  return normalizeRemoteAgentBaseUrl(connection.baseUrl);
}

/** Also applied to successful server output: an echoed bearer key cannot reach saved jobs. */
export function redactRemoteAgentText(value: string, connection: RemoteAgentConnection): string {
  let result = value;
  const key = connection.apiKey?.trim();
  if (key) result = result.split(key).join('[redacted]');
  return result.replace(/\bBearer\s+[^\s"'<>]+/gi, 'Bearer [redacted]');
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value || value.length > 512
    || Array.from(value).some(character => character.charCodeAt(0) < 33 || character.charCodeAt(0) === 127)) {
    throw new RemoteAgentError(`${label} is missing or invalid.`, 'PROTOCOL');
  }
  return value;
}

export function mapHermesRunState(status: string): RemoteAgentState {
  switch (status) {
    case 'queued': return 'queued';
    case 'started': case 'running': case 'stopping': return 'running';
    case 'completed': return 'completed';
    case 'failed': case 'interrupted': return 'failed';
    case 'cancelled': case 'canceled': return 'cancelled';
    case 'waiting_for_approval': case 'needs_attention': return 'needs_attention';
    default: return 'unknown';
  }
}

function normalizeRun(value: unknown, connection: RemoteAgentConnection, expectedId?: string): RemoteAgentRun {
  const body = record(value);
  if (!body) throw new RemoteAgentError('Hermes returned an invalid run response.', 'PROTOCOL');
  const runId = identifier(body.run_id ?? expectedId, 'Run ID');
  if (expectedId && expectedId !== runId) throw new RemoteAgentError('Hermes returned a different run ID.', 'PROTOCOL');
  const remoteStatus = typeof body.status === 'string' ? redactRemoteAgentText(body.status, connection) : 'unknown';
  const result: RemoteAgentRun = { runId, remoteStatus, state: mapHermesRunState(remoteStatus) };
  for (const [wire, field] of [['output', 'output'], ['error', 'error'], ['session_id', 'sessionId'], ['model', 'model']] as const) {
    if (typeof body[wire] === 'string') result[field] = redactRemoteAgentText(body[wire], connection);
  }
  if (typeof body.updated_at === 'number' && Number.isFinite(body.updated_at) && body.updated_at > 0
    && body.updated_at < 8_640_000_000_000) result.updatedAt = new Date(body.updated_at * 1000).toISOString();
  if (typeof body.replayed === 'boolean') result.replayed = body.replayed;
  return result;
}

/** Hermes owns execution. The connector never interprets or executes remote tool calls. */
export class HermesConnector implements RemoteAgentConnector {
  readonly kind = 'hermes' as const;

  private async request(
    connection: RemoteAgentConnection, route: string, method: 'GET' | 'POST',
    body: JsonRecord | undefined, signal?: AbortSignal, idempotencyKey?: string,
  ): Promise<ProviderHttpResponse<unknown>> {
    const baseUrl = validateRemoteAgentConnection(connection);
    const headers = openAICompatibleHeaders(connection.apiKey ?? '');
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    const submitting = method === 'POST' && route === '/runs';
    try {
      const response = await ProviderHttpClient.request<unknown>({
        url: `${baseUrl}${route}`, provider: connection.id, operation: 'Hermes remote agent request',
        method, headers, body: body ? JSON.stringify(body) : undefined,
        timeoutMs: REMOTE_AGENT_REQUEST_TIMEOUT_MS, retries: 0, signal,
      });
      if (!response.ok) {
        const code = record(record(response.json)?.error)?.code;
        if (response.status === 409 && code === 'idempotency_key_conflict') {
          throw new RemoteAgentError('The submission key already belongs to a different request. Do not submit a replacement automatically.', 'IDEMPOTENCY_CONFLICT', 409);
        }
        if (response.status === 404 && route.startsWith('/runs/')) {
          throw new RemoteAgentError('Hermes cannot find this run in the authenticated profile. It may have expired or belong to another credential scope.', 'RUN_NOT_FOUND', 404);
        }
        throw new RemoteAgentError(`Hermes request failed with HTTP ${response.status}.`, 'HTTP_ERROR', response.status, submitting && response.status >= 500);
      }
      return response;
    } catch (error) {
      if (error instanceof RemoteAgentError) throw error;
      const aborted = signal?.aborted;
      const timedOut = error instanceof Error && /timeout/i.test(error.message);
      throw new RemoteAgentError(
        aborted ? 'Hermes request was stopped locally; server work may continue.'
          : timedOut ? 'Hermes request timed out; its outcome is not confirmed.' : 'Cannot reach Hermes; the request outcome is not confirmed.',
        aborted ? 'ABORTED' : timedOut ? 'TIMEOUT' : 'NETWORK', undefined, submitting,
      );
    }
  }

  async submit(connection: RemoteAgentConnection, request: RemoteAgentRequest, idempotencyKey: string, signal?: AbortSignal): Promise<RemoteAgentRun> {
    if (typeof idempotencyKey !== 'string' || !idempotencyKey || idempotencyKey.length > 255
      || Array.from(idempotencyKey).some(character => character.charCodeAt(0) < 33 || character.charCodeAt(0) > 126)) {
      throw new RemoteAgentError('Use a unique Idempotency-Key of 1–255 visible ASCII characters.', 'INVALID_CONFIG');
    }
    if (!request || typeof request.input !== 'string' || !request.input.trim()
      || (request.instructions !== undefined && typeof request.instructions !== 'string')
      || (request.sessionId !== undefined && typeof request.sessionId !== 'string')) {
      throw new RemoteAgentError('A remote task requires non-empty text input.', 'INVALID_CONFIG');
    }
    const body: JsonRecord = { input: request.input };
    if (request.instructions !== undefined) body.instructions = request.instructions;
    if (request.sessionId !== undefined) body.session_id = request.sessionId;
    const response = await this.request(connection, '/runs', 'POST', body, signal, idempotencyKey);
    try {
      const result = normalizeRun(response.json, connection);
      if (Object.entries(response.headers).some(([name, value]) => name.toLowerCase() === 'idempotency-replayed' && value === 'true')) result.replayed = true;
      return result;
    } catch {
      throw new RemoteAgentError('Hermes accepted the request but did not return a valid run ID. Recover only with the same submission key within verified retention.', 'PROTOCOL', response.status, true);
    }
  }

  async get(connection: RemoteAgentConnection, runId: string, signal?: AbortSignal): Promise<RemoteAgentRun> {
    const id = identifier(runId, 'Run ID');
    const response = await this.request(connection, `/runs/${encodeURIComponent(id)}`, 'GET', undefined, signal);
    return normalizeRun(response.json, connection, id);
  }

  async cancel(connection: RemoteAgentConnection, runId: string, signal?: AbortSignal): Promise<RemoteAgentRun> {
    const id = identifier(runId, 'Run ID');
    const response = await this.request(connection, `/runs/${encodeURIComponent(id)}/stop`, 'POST', {}, signal);
    return normalizeRun(response.json, connection, id);
  }

  async probe(connection: RemoteAgentConnection, signal?: AbortSignal): Promise<RemoteAgentProbe> {
    const checkedAt = Date.now();
    try {
      const response = await this.request(connection, '/capabilities', 'GET', undefined, signal);
      const body = record(response.json);
      if (body?.object !== 'hermes.api_server.capabilities') throw new RemoteAgentError('This endpoint did not return Hermes API capabilities.', 'PROTOCOL');
      const features = record(body.features);
      const runsAvailable = features?.run_submission === true && features.run_status === true && features.run_stop === true;
      const idempotency = record(features?.runs_idempotency);
      const retentionSeconds = idempotency?.retention_seconds;
      const idempotencyRetentionMs = typeof retentionSeconds === 'number' && Number.isSafeInteger(retentionSeconds)
        && retentionSeconds > 0 && retentionSeconds <= Number.MAX_SAFE_INTEGER / 1000
        ? retentionSeconds * 1000 : undefined;
      const durableIdempotency = idempotency?.supported === true && idempotency.durable === true && idempotencyRetentionMs !== undefined;
      return {
        connected: true, checkedAt, runsAvailable, durableIdempotency, idempotencyRetentionMs,
        ...(!runsAvailable ? { error: 'Hermes does not advertise Runs submission, status and stop support.' }
          : !durableIdempotency ? { error: 'Durable Runs idempotency is unverified or unavailable (the server may be using memory-only storage). Restart-safe delegation is unavailable.' } : {}),
      };
    } catch (error) {
      return { connected: false, runsAvailable: false, durableIdempotency: false, checkedAt,
        error: error instanceof RemoteAgentError ? error.message : 'Hermes capability check failed.' };
    }
  }
}
