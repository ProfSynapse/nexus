/** Uses real WebCrypto and IndexedDB transaction semantics to catch key replacement across owners.
 * This does not replace signing/pairing verification in the actual Obsidian browser. */
import { webcrypto } from 'node:crypto';
import { IDBFactory } from 'fake-indexeddb';
import { OpenClawDeviceIdentityProvider, OpenClawIndexedDBIdentityStore } from '../../../src/services/remoteAgents/OpenClawDeviceIdentity';

const crypto = webcrypto as unknown as Crypto;
const key = 'endpoint:wss://example.test';
const decode = (value: string) => new Uint8Array(Buffer.from(value, 'base64url'));

describe('OpenClawDeviceIdentity', () => {
  const previous = globalThis.indexedDB;
  beforeEach(() => { globalThis.indexedDB = new IDBFactory(); });
  afterAll(() => { globalThis.indexedDB = previous; });
  test('signs exact v3 payload with nonextractable stored Ed25519 key and raw-public fingerprint', async () => {
    const store = new OpenClawIndexedDBIdentityStore();const identity = new OpenClawDeviceIdentityProvider(store, crypto);
    const signed = await identity.sign(key, 'token', 'nonce', 1700000000000);
    const saved = await store.load(key);
    expect(saved?.privateKey.extractable).toBe(false);
    await expect(crypto.subtle.exportKey('pkcs8', saved!.privateKey)).rejects.toThrow();
    const raw = decode(signed.publicKey);
    expect(Buffer.from(await crypto.subtle.digest('SHA-256', raw)).toString('hex')).toBe(signed.id);
    const publicKey = await crypto.subtle.importKey('raw', raw, 'Ed25519', false, ['verify']);
    const payload = ['v3', signed.id, 'gateway-client', 'backend', 'operator', 'operator.read,operator.write', '1700000000000', 'token', 'nonce', 'obsidian', 'nexus'].join('|');
    expect(await crypto.subtle.verify('Ed25519', publicKey, decode(signed.signature), new TextEncoder().encode(payload))).toBe(true);
    expect(await crypto.subtle.verify('Ed25519', publicKey, decode(signed.signature), new TextEncoder().encode(payload.replace('nonce', 'other-nonce')))).toBe(false);
  });
  test('two independent providers racing initial load converge on one persisted identity', async () => {
    const a = new OpenClawDeviceIdentityProvider(new OpenClawIndexedDBIdentityStore(), crypto);
    const b = new OpenClawDeviceIdentityProvider(new OpenClawIndexedDBIdentityStore(), crypto);
    const signed = await Promise.all([a.sign(key, 'token', 'nonce-a', 1), b.sign(key, 'token', 'nonce-b', 2)]);
    expect(signed[0].id).toBe(signed[1].id);expect(signed[0].publicKey).toBe(signed[1].publicKey);
    const reload = new OpenClawDeviceIdentityProvider(new OpenClawIndexedDBIdentityStore(), crypto);
    expect((await reload.sign(key, 'token', 'nonce-c', 3)).id).toBe(signed[0].id);
  });
  test('a revoked/unusable local storage path fails instead of generating an ephemeral replacement', async () => {
    const provider = new OpenClawDeviceIdentityProvider({ load: async () => { throw new Error('blocked'); }, save: jest.fn() }, crypto);
    await expect(provider.sign(key, 'token', 'nonce', 1)).rejects.toMatchObject({ code: 'UNSUPPORTED' });
  });
});
