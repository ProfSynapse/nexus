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

function uniqueSocketPath(): string {
  // Unix socket paths are capped near 104 bytes on macOS, so keep it short.
  pathCounter += 1;
  const socketPath = path.join(os.tmpdir(), `nx-ipc-${process.pid}-${pathCounter}.sock`);
  createdPaths.push(socketPath);
  return socketPath;
}

function createConfiguration(ipcPath: string): ServerConfiguration {
  return {
    isWindows: () => false,
    getIPCPath: () => ipcPath,
    getServerInfo: () => ({ name: 'test', version: '1.0' }),
    getServerOptions: () => ({}),
  } as unknown as ServerConfiguration;
}

function createTransportManager(ipcPath: string): IPCTransportManager {
  const manager = new IPCTransportManager(
    createConfiguration(ipcPath),
    {} as unknown as StdioTransportManager
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

  it('does not unlink a socket file that was replaced underneath it', async () => {
    const ipcPath = uniqueSocketPath();

    const manager = createTransportManager(ipcPath);
    await manager.startTransport();
    const ownInode = inodeOf(ipcPath);
    manager.closeListener();

    // Someone else takes the path over — same name, different file.
    fs.rmSync(ipcPath, { force: true });
    const foreign = await listenDirectly(ipcPath);
    const foreignInode = inodeOf(ipcPath);
    expect(foreignInode).not.toBe(ownInode);

    // The identity check has to notice, because the path alone cannot.
    await manager.stopTransport();

    expect(inodeOf(ipcPath)).toBe(foreignInode);
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
