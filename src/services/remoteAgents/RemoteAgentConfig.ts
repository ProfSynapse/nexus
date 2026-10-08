import { normalizeOpenAICompatibleBaseUrl } from '../llm/adapters/openai-compatible/OpenAICompatibleConfig';
import { RemoteAgentError, type RemoteAgentConnection, type RemoteAgentConnectorKind } from './types';

export function normalizeRemoteAgentBaseUrl(value: string): string {
  let result: string;
  try { result = normalizeOpenAICompatibleBaseUrl(value); }
  catch { throw new RemoteAgentError('Enter a clean HTTPS API base URL, or HTTP on localhost, without credentials, queries or fragments.', 'INVALID_CONFIG'); }
  if (/\/(?:runs(?:\/.*)?|capabilities|health)$/i.test(new URL(result).pathname)) {
    throw new RemoteAgentError('Enter the API base prefix (usually ending /v1), not a Runs or health URL.', 'INVALID_CONFIG');
  }
  return result;
}

function validateHermesConnection(connection: RemoteAgentConnection): string {
  if (!connection || connection.connector !== 'hermes' || typeof connection.id !== 'string'
    || !connection.id.trim() || typeof connection.displayName !== 'string' || !connection.displayName.trim()
    || typeof connection.enabled !== 'boolean' || typeof connection.baseUrl !== 'string'
    || (connection.apiKey !== undefined && typeof connection.apiKey !== 'string')
    || (connection.description !== undefined && typeof connection.description !== 'string')) {
    throw new RemoteAgentError('Remote agent connection settings are incomplete.', 'INVALID_CONFIG');
  }
  return normalizeRemoteAgentBaseUrl(connection.baseUrl);
}

/** Accept web URLs as a convenience, but persist the explicit Gateway websocket URL. */
export function normalizeOpenClawGatewayUrl(value: string): string {
  try {
    const url = new URL(value.trim());
    if (url.protocol === 'https:') url.protocol = 'wss:';
    if (url.protocol === 'http:') url.protocol = 'ws:';
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if ((url.protocol !== 'wss:' && !(url.protocol === 'ws:' && loopback))
      || url.username || url.password || url.search || url.hash) throw new Error();
    if (/\/(?:v1(?:\/.*)?|runs(?:\/.*)?|health)$/i.test(url.pathname)) throw new Error();
    return url.href.replace(/\/+$/, '');
  } catch {
    throw new RemoteAgentError('Enter a WSS gateway URL, or WS on localhost, without credentials, queries or fragments. Use the gateway address rather than an HTTP API route.', 'INVALID_CONFIG');
  }
}

export function normalizeRemoteAgentConnectionUrl(value: string, connector: RemoteAgentConnectorKind): string {
  if (connector === 'hermes') return normalizeRemoteAgentBaseUrl(value);
  if (connector === 'openclaw') return normalizeOpenClawGatewayUrl(value);
  throw new RemoteAgentError('This remote agent connector is unavailable.', 'INVALID_CONFIG');
}

export function validateRemoteAgentConnection(connection: RemoteAgentConnection): string {
  if (connection?.connector === 'hermes') return validateHermesConnection(connection);
  if (!connection || connection.connector !== 'openclaw' || typeof connection.id !== 'string'
    || !connection.id.trim() || typeof connection.displayName !== 'string' || !connection.displayName.trim()
    || typeof connection.enabled !== 'boolean' || typeof connection.baseUrl !== 'string'
    || (connection.apiKey !== undefined && typeof connection.apiKey !== 'string')
    || (connection.description !== undefined && typeof connection.description !== 'string')) {
    throw new RemoteAgentError('Remote agent connection settings are incomplete.', 'INVALID_CONFIG');
  }
  return normalizeOpenClawGatewayUrl(connection.baseUrl);
}
