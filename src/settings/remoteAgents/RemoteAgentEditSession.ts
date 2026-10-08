import type { RemoteAgentConnection, RemoteAgentProbe } from '../../services/remoteAgents/types';

export type RemoteAgentConnectionCheck = RemoteAgentProbe;

/** Keeps an editable connection independent of saved settings and obsolete probes. */
export class RemoteAgentEditSession {
  readonly draft: RemoteAgentConnection;
  private revision = 0;
  private closed = false;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    connection: RemoteAgentConnection,
    private readonly persist: (connection: RemoteAgentConnection) => Promise<void>,
    private readonly normalizeUrl: (value: string) => string,
    private readonly check: (connection: RemoteAgentConnection) => Promise<RemoteAgentConnectionCheck>,
  ) {
    this.draft = { ...connection, apiKey: connection.apiKey ?? '' };
  }

  update(patch: Partial<Omit<RemoteAgentConnection, 'id'>>): void {
    if (('baseUrl' in patch && patch.baseUrl !== this.draft.baseUrl)
      || ('apiKey' in patch && patch.apiKey !== this.draft.apiKey)
      || ('connector' in patch && patch.connector !== this.draft.connector)) this.revision++;
    Object.assign(this.draft, patch);
  }

  validationError(): string | null {
    if (!this.draft.displayName.trim()) return 'Enter a name for this agent.';
    try {
      this.normalizeUrl(this.draft.baseUrl);
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : 'Enter a valid server URL.';
    }
  }

  private snapshot(): RemoteAgentConnection {
    const error = this.validationError();
    if (error) throw new Error(error);
    return {
      ...this.draft,
      displayName: this.draft.displayName.trim(),
      baseUrl: this.normalizeUrl(this.draft.baseUrl),
      description: this.draft.description?.trim() || undefined,
      apiKey: this.draft.apiKey ?? '',
    };
  }

  async save(): Promise<void> {
    const snapshot = this.snapshot();
    const pending = this.queue.catch(() => undefined).then(() => this.persist(snapshot));
    this.queue = pending;
    return pending;
  }

  async testConnection(): Promise<RemoteAgentConnectionCheck | null> {
    const snapshot = this.snapshot();
    const revision = ++this.revision;
    try {
      const result = await this.check(snapshot);
      return this.closed || revision !== this.revision ? null : result;
    } catch (error) {
      if (this.closed || revision !== this.revision) return null;
      throw error;
    }
  }

  close(): void {
    this.closed = true;
    this.revision++;
  }
}
