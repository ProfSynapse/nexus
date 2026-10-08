export type RemoteAgentConnectorKind = 'hermes';
export type RemoteAgentState = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'needs_attention' | 'unknown';

export interface RemoteAgentConnection {
  id: string;
  connector: RemoteAgentConnectorKind;
  displayName: string;
  /** Exact API prefix, e.g. https://host.example/p/team/v1. */
  baseUrl: string;
  apiKey?: string;
  enabled: boolean;
  description?: string;
}

export interface RemoteAgentRequest {
  input: string;
  instructions?: string;
  sessionId?: string;
}

export interface RemoteAgentRun {
  runId: string;
  state: RemoteAgentState;
  remoteStatus: string;
  output?: string;
  error?: string;
  sessionId?: string;
  model?: string;
  /** ISO timestamp converted from the server's Unix seconds; polling does not refresh it. */
  updatedAt?: string;
  replayed?: boolean;
}

export interface RemoteAgentProbe {
  connected: boolean;
  runsAvailable: boolean;
  durableIdempotency: boolean;
  /** Advertised retention only. Undefined means safe replay retention is unverified. */
  idempotencyRetentionMs?: number;
  checkedAt: number;
  error?: string;
}

export interface RemoteAgentSummary {
  id: string;
  connector: RemoteAgentConnectorKind;
  displayName: string;
  description: string;
}

export interface RemoteAgentConnector {
  readonly kind: RemoteAgentConnectorKind;
  submit(connection: RemoteAgentConnection, request: RemoteAgentRequest, idempotencyKey: string, signal?: AbortSignal): Promise<RemoteAgentRun>;
  get(connection: RemoteAgentConnection, runId: string, signal?: AbortSignal): Promise<RemoteAgentRun>;
  cancel(connection: RemoteAgentConnection, runId: string, signal?: AbortSignal): Promise<RemoteAgentRun>;
  probe(connection: RemoteAgentConnection, signal?: AbortSignal): Promise<RemoteAgentProbe>;
}

export type RemoteAgentErrorCode = 'INVALID_CONFIG' | 'UNSUPPORTED' | 'NETWORK' | 'TIMEOUT' | 'ABORTED' | 'PROTOCOL' | 'HTTP_ERROR' | 'IDEMPOTENCY_CONFLICT' | 'RUN_NOT_FOUND';

/** Carries only safe diagnostics, never raw response bodies, request headers or credentials. */
export class RemoteAgentError extends Error {
  constructor(
    message: string,
    public readonly code: RemoteAgentErrorCode,
    public readonly status?: number,
    public readonly submissionOutcomeUnknown = false,
  ) {
    super(message);
    this.name = 'RemoteAgentError';
  }
}
