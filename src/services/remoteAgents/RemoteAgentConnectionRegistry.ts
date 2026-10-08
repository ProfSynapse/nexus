import { HermesConnector } from './HermesConnector';
import { OpenClawConnector } from './OpenClawConnector';
import { validateRemoteAgentConnection } from './RemoteAgentConfig';
import {
  RemoteAgentError, isRemoteAgentReady, type RemoteAgentConnection, type RemoteAgentConnector, type RemoteAgentConnectorKind,
  type RemoteAgentProbe, type RemoteAgentSummary,
} from './types';

export const REMOTE_AGENT_HEALTH_MAX_AGE_MS = 60_000;
export const REMOTE_AGENT_HEALTH_REFRESH_MS = 30_000;
export const DEFAULT_REMOTE_AGENT_DESCRIPTION = 'General-purpose remote agent with its own tools and environment.';

export interface RemoteAgentHealthResult { connectionId: string; probe: RemoteAgentProbe }
interface HealthEntry { identity: string; probe: RemoteAgentProbe }

/** Config and credentials are kept internal; prompt summaries contain only safe discovery fields. */
export class RemoteAgentConnectionRegistry {
  private readonly connectors = new Map<RemoteAgentConnectorKind, RemoteAgentConnector>();
  private readonly health = new Map<string, HealthEntry>();
  private readonly inFlight = new Map<string, AbortController>();
  private disposed = false;
  private refreshTimer?: number;

  constructor(
    private readonly getConnections: () => RemoteAgentConnection[],
    connectors: RemoteAgentConnector[] = [new HermesConnector(), new OpenClawConnector()],
  ) {
    for (const connector of connectors) this.connectors.set(connector.kind, connector);
  }

  /** Plugin-owned polling; a slow capability request never overlaps another background tick. */
  start(): void {
    if (this.disposed || this.refreshTimer !== undefined) return;
    const refresh = () => {
      if (this.disposed || this.inFlight.size) return;
      void this.refresh().catch(() => { /* Failed probes stay unavailable until a later tick. */ });
    };
    refresh();
    this.refreshTimer = window.setInterval(refresh, REMOTE_AGENT_HEALTH_REFRESH_MS);
  }

  list(): RemoteAgentConnection[] { return this.getConnections().map(connection => ({ ...connection })); }

  get(id: string): RemoteAgentConnection | undefined {
    const matches = this.list().filter(connection => connection.id === id);
    // A duplicate ID is ambiguous and may not select an arbitrary credential scope.
    return matches.length === 1 ? matches[0] : undefined;
  }

  getConnector(connection: RemoteAgentConnection): RemoteAgentConnector {
    const connector = this.connectors.get(connection.connector);
    if (!connector) throw new RemoteAgentError('This remote agent connector is unavailable.', 'UNSUPPORTED');
    return connector;
  }

  private identity(connection: RemoteAgentConnection): string {
    // Runtime only; never exported, logged or persisted. Credential changes revoke health.
    return JSON.stringify([connection.connector, validateRemoteAgentConnection(connection), connection.apiKey ?? '']);
  }

  getHealth(id: string): RemoteAgentProbe | undefined {
    if (this.disposed) return undefined;
    const connection = this.get(id);
    const entry = this.health.get(id);
    if (!connection || !entry || Date.now() - entry.probe.checkedAt > REMOTE_AGENT_HEALTH_MAX_AGE_MS) return undefined;
    try { return entry.identity === this.identity(connection) ? { ...entry.probe } : undefined; }
    catch { return undefined; }
  }

  /** A healthy Chat Completions server is insufficient: Runs and durable replay must be verified. */
  getAvailable(): RemoteAgentSummary[] {
    if (this.disposed) return [];
    return this.list().flatMap(connection => {
      const health = this.getHealth(connection.id);
      if (!connection.enabled || !isRemoteAgentReady(health)) return [];
      return [{
        id: connection.id, connector: connection.connector, displayName: connection.displayName,
        description: connection.description?.trim() || DEFAULT_REMOTE_AGENT_DESCRIPTION,
      }];
    });
  }

  /** Does not write settings or make an unsaved draft available for delegation. */
  async probeDraft(connection: RemoteAgentConnection, signal?: AbortSignal): Promise<RemoteAgentProbe> {
    if (this.disposed) return this.unavailable('Remote agent registry has been disposed.');
    try {
      validateRemoteAgentConnection(connection);
      return await this.getConnector(connection).probe({ ...connection }, signal);
    } catch (error) {
      return this.unavailable(error instanceof RemoteAgentError ? error.message : 'Remote agent connection check failed.');
    }
  }

  async refresh(id?: string): Promise<RemoteAgentHealthResult[]> {
    if (this.disposed) return [];
    const selected = id ? [this.get(id)].filter((connection): connection is RemoteAgentConnection => !!connection)
      : this.list().filter(connection => connection.enabled && !!this.get(connection.id));
    // Independent read-only probes may run concurrently; none create an agent run.
    return Promise.all(selected.map(async connection => {
      const previous = this.inFlight.get(connection.id);
      previous?.abort();
      const controller = new AbortController();
      this.inFlight.set(connection.id, controller);
      let identity: string | undefined;
      try { identity = this.identity(connection); } catch { /* probeDraft returns a safe invalid-config error */ }
      const probe = await this.probeDraft(connection, controller.signal);
      const current = this.get(connection.id);
      try {
        if (!this.disposed && !controller.signal.aborted && identity !== undefined && current
          && identity === this.identity(current) && this.inFlight.get(connection.id) === controller) {
          this.health.set(connection.id, { identity, probe: { ...probe } });
        }
      } catch { /* A concurrent config change invalidates the old health result. */ }
      finally {
        if (this.inFlight.get(connection.id) === controller) this.inFlight.delete(connection.id);
      }
      return { connectionId: connection.id, probe };
    }));
  }

  private unavailable(error: string): RemoteAgentProbe {
    return { connected: false, runsAvailable: false, durableIdempotency: false, checkedAt: Date.now(), error };
  }

  /** Clearing runtime health never cancels a durable remote job. */
  cleanup(): void {
    this.disposed = true;
    if (this.refreshTimer !== undefined) window.clearInterval(this.refreshTimer);
    this.refreshTimer = undefined;
    for (const controller of this.inFlight.values()) controller.abort();
    this.inFlight.clear();
    this.health.clear();
  }
}
