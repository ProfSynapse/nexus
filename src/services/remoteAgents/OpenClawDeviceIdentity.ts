import { RemoteAgentError } from './types';

export interface OpenClawDeviceIdentity {
  id: string;
  publicKey: string;
  privateKey: CryptoKey;
}
export interface OpenClawIdentityStore {
  load(key: string): Promise<OpenClawDeviceIdentity | undefined>;
  /** Atomically retain and return an existing identity if another owner inserted first. */
  save(key: string, value: OpenClawDeviceIdentity): Promise<OpenClawDeviceIdentity>;
}
export interface OpenClawSignedDevice {
  id: string;
  publicKey: string;
  signature: string;
  signedAt: number;
  nonce: string;
}

function base64Url(bytes: ArrayBuffer): string {
  return btoa(Array.from(new Uint8Array(bytes), byte => String.fromCharCode(byte)).join(''))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** CryptoKey structured-clone storage is local to this Obsidian installation, never synced. */
export class OpenClawIndexedDBIdentityStore implements OpenClawIdentityStore {
  private async transact<T>(key: string, value?: OpenClawDeviceIdentity): Promise<T | undefined> {
    if (typeof indexedDB === 'undefined') throw new RemoteAgentError('Local device-key storage is unavailable. OpenClaw pairing cannot be established on this device.', 'UNSUPPORTED');
    return new Promise((resolve, reject) => {
      let settled = false;
      const opening = indexedDB.open('nexus-openclaw-devices', 1);
      const failure = () => {
        if (settled) return;
        settled = true;
        window.clearTimeout(deadline);
        reject(new RemoteAgentError('Cannot access the local OpenClaw device key. Check local storage permissions.', 'UNSUPPORTED'));
      };
      const deadline = window.setTimeout(failure, 5_000);
      opening.onupgradeneeded = () => opening.result.createObjectStore('identities');
      opening.onerror = failure;
      opening.onblocked = failure;
      opening.onsuccess = () => {
        const db = opening.result;
        if (settled) { db.close(); return; }
        let result: T | undefined;
        try {
          const tx = db.transaction('identities', value ? 'readwrite' : 'readonly');
          const store = tx.objectStore('identities');
          const request = store.get(key);
          request.onsuccess = () => {
            result = request.result as T | undefined;
            if (value && result === undefined) { store.add(value, key); result = value as T; }
          };
          tx.oncomplete = () => {
            db.close();
            if (settled) return;
            settled = true;
            window.clearTimeout(deadline);
            resolve(result);
          };
          tx.onerror = tx.onabort = () => { db.close(); failure(); };
        } catch { db.close(); failure(); }
      };
    });
  }
  load(key: string): Promise<OpenClawDeviceIdentity | undefined> { return this.transact<OpenClawDeviceIdentity>(key); }
  async save(key: string, value: OpenClawDeviceIdentity): Promise<OpenClawDeviceIdentity> {
    const saved = await this.transact<OpenClawDeviceIdentity>(key, value);
    if (!saved) throw new RemoteAgentError('Cannot persist the local OpenClaw device identity.', 'UNSUPPORTED');
    return saved;
  }
}

/** Implements OpenClaw's v3 Ed25519 challenge signature with read/write scopes only. */
export class OpenClawDeviceIdentityProvider {
  private readonly pending = new Map<string, Promise<OpenClawDeviceIdentity>>();
  constructor(private readonly store: OpenClawIdentityStore = new OpenClawIndexedDBIdentityStore(), private readonly cryptoApi?: Crypto) {}
  private crypto(): Crypto {
    const api = this.cryptoApi ?? window.crypto;
    if (!api?.subtle) throw new RemoteAgentError('This device lacks the WebCrypto support required for OpenClaw pairing.', 'UNSUPPORTED');
    return api;
  }
  private identity(key: string): Promise<OpenClawDeviceIdentity> {
    const existing = this.pending.get(key);
    if (existing) return existing;
    const task = (async () => {
      let saved: OpenClawDeviceIdentity | undefined;
      try { saved = await this.store.load(key); }
      catch { throw new RemoteAgentError('Cannot access the local OpenClaw device key. Check local storage permissions.', 'UNSUPPORTED'); }
      if (saved) {
        if (!saved.id || !saved.publicKey || saved.privateKey?.type !== 'private'
          || saved.privateKey.extractable || saved.privateKey.algorithm.name !== 'Ed25519') {
          throw new RemoteAgentError('The stored OpenClaw device identity is invalid. Restore local device storage before pairing again.', 'UNSUPPORTED');
        }
        return saved;
      }
      try {
        const crypto = this.crypto();
        const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify']);
        const raw = await crypto.subtle.exportKey('raw', pair.publicKey);
        const hash = await crypto.subtle.digest('SHA-256', raw);
        const id = Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
        const identity = { id, publicKey: base64Url(raw), privateKey: pair.privateKey };
        return await this.store.save(key, identity);
      } catch (error) {
        if (error instanceof RemoteAgentError) throw error;
        throw new RemoteAgentError('This device cannot create or persist the Ed25519 key required for OpenClaw pairing.', 'UNSUPPORTED');
      }
    })();
    this.pending.set(key, task);
    task.catch(() => { this.pending.delete(key); });
    return task;
  }
  async sign(key: string, token: string, nonce: string, signedAt: number): Promise<OpenClawSignedDevice> {
    const identity = await this.identity(key);
    const payload = ['v3', identity.id, 'gateway-client', 'backend', 'operator',
      'operator.read,operator.write', String(signedAt), token, nonce, 'obsidian', 'nexus'].join('|');
    try {
      const signature = await this.crypto().subtle.sign('Ed25519', identity.privateKey, new TextEncoder().encode(payload));
      return { id: identity.id, publicKey: identity.publicKey, signature: base64Url(signature), signedAt, nonce };
    } catch { throw new RemoteAgentError('Cannot sign the OpenClaw pairing challenge on this device.', 'UNSUPPORTED'); }
  }
}
