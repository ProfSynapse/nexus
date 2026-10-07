import type { App, EventRef, TAbstractFile, Vault } from 'obsidian';
import type { CoreSkillsSettings, ServiceResult } from '../instructions/types';

interface WatcherService {
  getRoot(): string;
  getPreferences(): CoreSkillsSettings;
  refreshIndex(options?: { importProviders?: boolean }): Promise<ServiceResult<void>>;
}
type VaultWithRaw = Vault & { on(name: 'raw', callback: (path: string) => void): EventRef };

/** Native indexing always runs; provider import is a separate user preference. */
export class SkillSyncWatcher {
  private refs: EventRef[] = [];
  private timer?: number;
  private started = false;
  private stopped = false;
  private running = false;
  private pending = false;
  private retries = 5;

  constructor(private readonly app: App, private readonly service: WatcherService, private readonly debounceMs = 2000) {}
  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    const vault = this.app.vault;
    this.refs.push(vault.on('create', (f: TAbstractFile) => this.onPath(f.path)),
      vault.on('modify', (f: TAbstractFile) => this.onPath(f.path)),
      vault.on('delete', (f: TAbstractFile) => this.onPath(f.path)),
      vault.on('rename', (f: TAbstractFile, old: string) => { this.onPath(old); this.onPath(f.path); }));
    try { this.refs.push((vault as VaultWithRaw).on('raw', p => this.onPath(p))); } catch { /* Mobile may not support raw. */ }
    this.schedule();
  }
  stop(): void {
    this.stopped = true;
    this.pending = false;
    if (this.timer !== undefined) window.clearTimeout(this.timer);
    this.timer = undefined;
    for (const ref of this.refs) this.app.vault.offref(ref);
    this.refs = [];
  }
  private onPath(path: string): void {
    if (this.stopped || !path) return;
    const normalized = path.replace(/\\/g, '/');
    if (normalized.split('/').some(part => part === '_archive')) return;
    let root: string;
    try { root = this.service.getRoot(); } catch { return; }
    if (normalized === root || normalized.startsWith(`${root}/`) ||
        (this.service.getPreferences().automaticImport && /^\.[^/]+\/skills(?:\/|$)/.test(normalized))) this.schedule();
  }
  private schedule(): void {
    if (this.stopped) return;
    if (this.timer !== undefined) window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => { this.timer = undefined; void this.run(); }, this.debounceMs);
  }
  private async run(): Promise<void> {
    if (this.stopped) return;
    if (this.running) { this.pending = true; return; }
    this.running = true;
    try {
      const result = await this.service.refreshIndex({ importProviders: this.service.getPreferences().automaticImport });
      if (!result.ok && result.error.code === 'initializing' && this.retries > 0) {
        this.retries--; this.pending = true;
      } else if (result.ok) this.retries = 0;
    } finally {
      this.running = false;
      if (this.pending && !this.stopped) { this.pending = false; this.schedule(); }
    }
  }
}
