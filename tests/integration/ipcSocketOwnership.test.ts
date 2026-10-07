/**
 * IPC socket ownership across a plugin reload (#337).
 *
 * These use the real `net` and `fs` modules on real unix domain sockets,
 * because the bug lives entirely in behaviour a mock would have to be told
 * about: `server.close()` unlinks the socket file synchronously at call time,
 * and it unlinks the *path it was given* rather than the file it created. A
 * stubbed net server has no reason to do either, so a mocked version of these
 * tests would pass against the broken code.
 *
 * The IPC path is derived from the vault name, so every instance of the plugin
 * shares it. On a hot reload two instances overlap, and a predecessor tearing
 * down late used to delete the successor's socket file — silently, because the
 * successor keeps its listening fd and never learns the file is gone.
 */

import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { IPCTransportManager } from '../../src/server/transport/IPCTransportManager';
import { StdioTransportManager } from '../../src/server/transport/StdioTransportManager';
import { ServerConfiguration } from '../../src/server/services/ServerConfiguration';

const describeOnPosix = process.platform === 'win32' ? describe.skip : describe;

let pathCounter = 0;
const createdPaths: string[] = [];
/**
 * Everything that binds a socket is registered here, because a failed
 * assertion skips the in-test teardown and a leaked listening server keeps
 * Jest's event loop alive — turning a failure into a hang.
 */
const openManagers: IPCTransportManager[] = [];
const openServers: net.Server[] = [];
const openSockets: net.Socket[] = [];

function uniqueSocketPath(): string {
  // Unix socket paths are capped near 104 bytes on macOS, so keep it short.
  pathCounter += 1;
  const socketPath = path.join(os.tmpdir(), `nx-ipc-${process.pid}-${pathCounter}.sock`);
  createdPaths.push(socketPath);
  return socketPath;
}

/** The sidecar note lives beside the socket: `<path minus .sock>.json`. */
function noteFor(ipcPath: string): string {
  return ipcPath.replace(/\.sock$/, '.json');
}

function createConfiguration(ipcPath: string, basePath: string | null = null): ServerConfiguration {
  return {
    isWindows: () => false,
    getIPCPath: () => ipcPath,
    getVaultNotePath: () => noteFor(ipcPath),
    getVaultBasePath: () => basePath,
    getSanitizedVaultName: () => 'test-vault',
    getServerInfo: () => ({ name: 'test', version: '1.0' }),
    getServerOptions: () => ({}),
  } as unknown as ServerConfiguration;
}

function createTransportManager(ipcPath: string, basePath: string | null = null, retainClient = false): IPCTransportManager {
  createdPaths.push(noteFor(ipcPath));
  const manager = new IPCTransportManager(
    createConfiguration(ipcPath, basePath),
    (retainClient ? {
      createSocketTransport: (socket: net.Socket) => {
        openSockets.push(socket);
        return { close: async () => { socket.destroy(); } };
      },
      connectSocketTransport: async () => undefined
    } : {}) as unknown as StdioTransportManager
  );
  openManagers.push(manager);
  return manager;
}

function inodeOf(target: string): number | null {
  try {
    return fs.statSync(target).ino;
  } catch {
    return null;
  }
}

/**
 * The full identity of the file at `target`, or null if there is nothing there.
 *
 * Tests may not assert that two successive files at the same path have
 * different inode NUMBERS. An inode number is unique only among live inodes;
 * ext4 returns a freed one to the very next create in that directory, so on
 * Linux the predecessor and successor sockets here routinely come back with
 * the identical number. Identity is the number plus the creation instant.
 */
function identityOf(target: string): { ino: number; birthtimeMs: number } | null {
  try {
    const stats = fs.statSync(target);
    return { ino: stats.ino, birthtimeMs: stats.birthtimeMs };
  } catch {
    return null;
  }
}

/** Bind a bare net server, standing in for an unrelated process's socket. */
function listenDirectly(socketPath: string): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    openServers.push(server);
    server.once('error', reject);
    server.listen(socketPath, () => resolve(server));
  });
}

function closeDirectly(server: net.Server): Promise<void> {
  return new Promise(resolve => server.close(() => resolve()));
}

function canConnect(socketPath: string): Promise<boolean> {
  return new Promise(resolve => {
    const socket = net.connect(socketPath);
    const settle = (ok: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.once('connect', () => settle(true));
    socket.once('error', () => settle(false));
  });
}

describeOnPosix('IPC socket ownership across a reload', () => {
  afterEach(async () => {
    for (const socket of openSockets.splice(0)) socket.destroy();
    for (const manager of openManagers.splice(0)) {
      manager.closeListener();
      await manager.stopTransport().catch(() => undefined);
    }
    for (const server of openServers.splice(0)) {
      await closeDirectly(server);
    }
    for (const socketPath of createdPaths.splice(0)) {
      try {
        fs.unlinkSync(socketPath);
      } catch {
        // Already gone, which is the usual case.
      }
    }
  });

  it('leaves the successor’s socket alone when the predecessor tears down late', async () => {
    const ipcPath = uniqueSocketPath();

    // The reload sequence, in the order Obsidian actually runs it.
    const predecessor = createTransportManager(ipcPath);
    await predecessor.startTransport();

    // onunload: release the listener synchronously, before the slow shutdown.
    predecessor.closeListener();

    const successor = createTransportManager(ipcPath);
    await successor.startTransport();
    const successorInode = inodeOf(ipcPath);
    expect(successorInode).not.toBeNull();

    // The predecessor's shutdown finally reaches the transport, ~20s later in
    // the field. Nothing it does may touch the file it no longer owns.
    await predecessor.stopTransport();

    expect(fs.existsSync(ipcPath)).toBe(true);
    expect(inodeOf(ipcPath)).toBe(successorInode);
    await expect(canConnect(ipcPath)).resolves.toBe(true);

    await successor.stopTransport();
  });

  it('keeps the replacement reachable with an accepted predecessor client retained across reload', async () => {
    const ipcPath = uniqueSocketPath();
    const predecessor = createTransportManager(ipcPath, '/vaults/Test', true);
    await predecessor.startTransport();
    const client = net.connect(ipcPath);
    openSockets.push(client);
    await new Promise<void>((resolve, reject) => { client.once('connect', resolve); client.once('error', reject); });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(client.destroyed).toBe(false);
    predecessor.closeListener();
    const successor = createTransportManager(ipcPath, '/vaults/Test', true);
    await successor.startTransport();
    const successorIdentity = identityOf(ipcPath);
    expect(client.destroyed).toBe(false);
    await predecessor.stopTransport();
    expect(identityOf(ipcPath)).toEqual(successorIdentity);
    await expect(canConnect(ipcPath)).resolves.toBe(true);
  });

  it('cancels a pending predecessor cleanup before it can unlink or bind over its successor', async () => {
    const ipcPath = uniqueSocketPath();
    const predecessor = createTransportManager(ipcPath, '/old', true);
    let release!: (live: boolean) => void;
    const probe = new Promise<boolean>(resolve => { release = resolve; });
    const access = predecessor as unknown as { isSocketLive(path: string): Promise<boolean> };
    const stalled = jest.spyOn(access, 'isSocketLive').mockReturnValueOnce(probe);
    const pending = predecessor.startTransport().then(() => 'started', error => (error as Error).message);
    predecessor.closeListener();
    const successor = createTransportManager(ipcPath, '/new', true);
    await successor.startTransport();
    const identity = identityOf(ipcPath);
    release(false);
    expect(await pending).toContain('cancelled');
    expect(predecessor.isTransportRunning()).toBe(false);
    expect(identityOf(ipcPath)).toEqual(identity);
    expect(JSON.parse(fs.readFileSync(noteFor(ipcPath), 'utf8')).basePath).toBe('/new');
    await expect(canConnect(ipcPath)).resolves.toBe(true);
    stalled.mockRestore();
  });

  it('does not publish a cancelled listener when its listening callback arrives after replacement', async () => {
    const ipcPath = uniqueSocketPath();
    const predecessor = createTransportManager(ipcPath, '/old', true);
    const access = predecessor as unknown as { listenSecure(server: net.Server, path: string, ready?: () => void): void };
    const original = access.listenSecure.bind(predecessor);
    let ready: (() => void) | undefined;
    const delayed = jest.spyOn(access, 'listenSecure').mockImplementation((server, target, callback) => {
      ready = callback;
      original(server, target);
    });
    const pending = predecessor.startTransport().then(() => 'started', error => (error as Error).message);
    while (!ready) await new Promise<void>(resolve => setImmediate(resolve));
    expect(predecessor.getServer()).not.toBeNull();
    predecessor.closeListener();
    const successor = createTransportManager(ipcPath, '/new', true);
    await successor.startTransport();
    ready();
    expect(await pending).toContain('cancelled');
    expect(predecessor.isTransportRunning()).toBe(false);
    expect(JSON.parse(fs.readFileSync(noteFor(ipcPath), 'utf8')).basePath).toBe('/new');
    await expect(canConnect(ipcPath)).resolves.toBe(true);
    delayed.mockRestore();
  });

  it('coalesces overlapping starts until the listener is ready', async () => {
    const ipcPath = uniqueSocketPath();
    const manager = createTransportManager(ipcPath);
    const first = manager.startTransport();
    const second = manager.startTransport();
    expect(second).toBe(first);
    expect(await second).toBe(await first);
    await expect(canConnect(ipcPath)).resolves.toBe(true);
  });

  it('does not unlink a socket file that was replaced underneath it', async () => {
    const ipcPath = uniqueSocketPath();

    const manager = createTransportManager(ipcPath);
    await manager.startTransport();
    const ownIdentity = identityOf(ipcPath);
    manager.closeListener();

    // Someone else takes the path over — same name, different file.
    fs.rmSync(ipcPath, { force: true });
    const foreign = await listenDirectly(ipcPath);
    const foreignIdentity = identityOf(ipcPath);
    // Different FILE, which on ext4 can still mean the same inode number —
    // see identityOf(). Comparing numbers alone made this precondition fail
    // on Linux before the scenario below ever ran.
    expect(foreignIdentity).not.toEqual(ownIdentity);

    // The identity check has to notice, because the path alone cannot.
    await manager.stopTransport();

    expect(identityOf(ipcPath)).toEqual(foreignIdentity);
    await expect(canConnect(ipcPath)).resolves.toBe(true);

    await closeDirectly(foreign);
  });

  /**
   * The guarantee that does not depend on the inode allocator.
   *
   * The test above needs the successor's file to look different from the
   * predecessor's. On ext4 it often does not: the freed inode number comes
   * straight back, and birthtimeMs is then the only thing separating them —
   * two files created inside the same timestamp tick would be indistinguishable.
   * So identity cannot be the last line of defence.
   *
   * Here the predecessor's recorded identity is forced to match the successor's
   * exactly, which is what perfect inode reuse looks like from inside
   * releaseOwnedSocket(). Nothing may be unlinked, because something is
   * listening on it.
   */
  it('never unlinks a socket that is being listened on, even when identity matches', async () => {
    const ipcPath = uniqueSocketPath();

    const manager = createTransportManager(ipcPath);
    await manager.startTransport();
    manager.closeListener();

    fs.rmSync(ipcPath, { force: true });
    const foreign = await listenDirectly(ipcPath);
    const foreignIdentity = identityOf(ipcPath);
    expect(foreignIdentity).not.toBeNull();

    // Simulate the allocator handing the successor a byte-identical identity.
    const withOwned = manager as unknown as {
      ownedSocket: { path: string; dev: number; ino: number; birthtimeMs: number } | null;
    };
    const stats = fs.statSync(ipcPath);
    withOwned.ownedSocket = {
      path: ipcPath,
      dev: stats.dev,
      ino: stats.ino,
      birthtimeMs: stats.birthtimeMs
    };

    await manager.stopTransport();

    expect(identityOf(ipcPath)).toEqual(foreignIdentity);
    await expect(canConnect(ipcPath)).resolves.toBe(true);

    await closeDirectly(foreign);
  });

  it('removes its own socket file when nothing has replaced it', async () => {
    const ipcPath = uniqueSocketPath();

    const manager = createTransportManager(ipcPath);
    await manager.startTransport();
    expect(fs.existsSync(ipcPath)).toBe(true);

    await manager.stopTransport();

    expect(fs.existsSync(ipcPath)).toBe(false);
  });

  it('clears a stale socket file left behind by a crashed process', async () => {
    const ipcPath = uniqueSocketPath();

    // A crash leaves the file with no listener behind it: connect is refused.
    const abandoned = await listenDirectly(ipcPath);
    await new Promise<void>(resolve => {
      abandoned.close(() => resolve());
      // close() unlinks, so put an inert file back to stand in for the corpse.
      fs.writeFileSync(ipcPath, '');
    });
    expect(fs.existsSync(ipcPath)).toBe(true);

    const manager = createTransportManager(ipcPath);
    await manager.startTransport();

    await expect(canConnect(ipcPath)).resolves.toBe(true);

    await manager.stopTransport();
  });

  it('closeListener is idempotent and still lets stopTransport finish', async () => {
    const ipcPath = uniqueSocketPath();

    const manager = createTransportManager(ipcPath);
    await manager.startTransport();

    manager.closeListener();
    manager.closeListener();

    expect(manager.isTransportRunning()).toBe(false);
    await expect(manager.stopTransport()).resolves.toBeUndefined();
    expect(fs.existsSync(ipcPath)).toBe(false);
  });

  it('a released path can be rebound by the same manager', async () => {
    const ipcPath = uniqueSocketPath();

    const manager = createTransportManager(ipcPath);
    await manager.startTransport();
    await manager.stopTransport();

    await manager.startTransport();
    await expect(canConnect(ipcPath)).resolves.toBe(true);

    await manager.stopTransport();
  });
});

/**
 * The vault note is how a `nexus` run from inside a vault folder finds its
 * vault. It shares the socket's path (minus the suffix) and therefore the
 * socket's ownership hazard, so it is written and released alongside it.
 */
describeOnPosix('IPC vault note beside the socket', () => {
  afterEach(async () => {
    for (const socket of openSockets.splice(0)) socket.destroy();
    for (const manager of openManagers.splice(0)) {
      manager.closeListener();
      await manager.stopTransport().catch(() => undefined);
    }
    for (const server of openServers.splice(0)) {
      await closeDirectly(server);
    }
    for (const createdPath of createdPaths.splice(0)) {
      try {
        fs.unlinkSync(createdPath);
      } catch {
        // Already gone, which is the usual case.
      }
    }
  });

  it('publishes { vaultName, basePath } owner-only once listening, and removes it on stop', async () => {
    const ipcPath = uniqueSocketPath();
    const notePath = noteFor(ipcPath);

    const manager = createTransportManager(ipcPath, '/vaults/Test Vault');
    expect(fs.existsSync(notePath)).toBe(false);

    await manager.startTransport();

    expect(fs.existsSync(notePath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(notePath, 'utf8'))).toEqual({
      vaultName: 'test-vault',
      basePath: '/vaults/Test Vault',
    });
    expect(fs.statSync(notePath).mode & 0o777).toBe(0o600);

    await manager.stopTransport();

    expect(fs.existsSync(notePath)).toBe(false);
  });

  it('writes no note when the adapter cannot name a folder, and clears a stale one', async () => {
    const ipcPath = uniqueSocketPath();
    const notePath = noteFor(ipcPath);
    fs.writeFileSync(notePath, JSON.stringify({ vaultName: 'test-vault', basePath: '/gone' }));

    const manager = createTransportManager(ipcPath, null);
    await manager.startTransport();

    expect(fs.existsSync(notePath)).toBe(false);

    await manager.stopTransport();
  });

  it('overwrites a stale note from an earlier run rather than trusting it', async () => {
    const ipcPath = uniqueSocketPath();
    const notePath = noteFor(ipcPath);
    fs.writeFileSync(notePath, JSON.stringify({ vaultName: 'test-vault', basePath: '/old/place' }), { mode: 0o644 });

    const manager = createTransportManager(ipcPath, '/new/place');
    await manager.startTransport();

    expect(JSON.parse(fs.readFileSync(notePath, 'utf8')).basePath).toBe('/new/place');
    expect(fs.statSync(notePath).mode & 0o777).toBe(0o600);

    await manager.stopTransport();
  });

  it('rechecks note ownership after a probe while the replacement publishes its note', async () => {
    const ipcPath = uniqueSocketPath();
    const predecessor = createTransportManager(ipcPath, '/old', true);
    await predecessor.startTransport();
    predecessor.closeListener();
    let release!: (live: boolean) => void;
    let probed!: () => void;
    const entered = new Promise<void>(resolve => { probed = resolve; });
    const probe = new Promise<boolean>(resolve => { release = resolve; });
    const access = predecessor as unknown as { isSocketLive(path: string): Promise<boolean> };
    const delayed = jest.spyOn(access, 'isSocketLive').mockImplementationOnce(() => { probed(); return probe; });
    const stopping = predecessor.stopTransport();
    await entered;
    const successor = createTransportManager(ipcPath, '/new', true);
    await successor.startTransport();
    const identity = identityOf(noteFor(ipcPath));
    release(false);
    await stopping;
    expect(identityOf(noteFor(ipcPath))).toEqual(identity);
    expect(JSON.parse(fs.readFileSync(noteFor(ipcPath), 'utf8')).basePath).toBe('/new');
    await expect(canConnect(ipcPath)).resolves.toBe(true);
    delayed.mockRestore();
  });

  it('leaves the successor’s note alone when the predecessor tears down late', async () => {
    const ipcPath = uniqueSocketPath();
    const notePath = noteFor(ipcPath);

    const predecessor = createTransportManager(ipcPath, '/vaults/Test Vault');
    await predecessor.startTransport();
    predecessor.closeListener();

    const successor = createTransportManager(ipcPath, '/vaults/Test Vault');
    await successor.startTransport();
    const successorNote = identityOf(notePath);
    expect(successorNote).not.toBeNull();

    await predecessor.stopTransport();

    expect(fs.existsSync(notePath)).toBe(true);
    expect(identityOf(notePath)).toEqual(successorNote);

    await successor.stopTransport();
    expect(fs.existsSync(notePath)).toBe(false);
  });
});
