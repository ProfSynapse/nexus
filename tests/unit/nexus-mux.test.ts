/**
 * nexus-mux.js — Multiplexer tests
 *
 * Spins up a real daemon process against a fake "Obsidian" server,
 * then exercises client connections, message routing, idle timeout,
 * and session-lifecycle interception.
 *
 * The fake Obsidian server speaks just enough MCP to handshake and
 * echo requests back, so we can verify the mux routes correctly.
 */

import * as net from 'net';
import * as readline from 'readline';
import * as path from 'path';
import { ChildProcess, fork } from 'child_process';
import * as fs from 'fs';

// ── Helpers ─────────────────────────────────────────────────────────────────

const MUX_PATH = path.resolve(__dirname, '../../nexus-mux.js');

// Use unique socket paths per test run to avoid collisions
const TEST_ID = `test_${process.pid}_${Date.now()}`;
const OBSIDIAN_SOCKET = `/tmp/nexus_mux_${TEST_ID}_obsidian.sock`;
const PROXY_SOCKET = `/tmp/nexus_mux_${TEST_ID}_proxy.sock`;

// Short idle timeout for testing (1 second)
const TEST_IDLE_TIMEOUT_MS = 1000;

/** JSON-RPC helper */
function rpc(method: string, id?: string | number, params?: Record<string, unknown>) {
  const msg: Record<string, unknown> = { jsonrpc: '2.0', method };
  if (id !== undefined) msg.id = id;
  if (params) msg.params = params;
  return msg;
}

function rpcResponse(id: string | number, result: unknown) {
  return { jsonrpc: '2.0', id, result };
}

/**
 * Fake Obsidian MCP server.
 * Handles initialize handshake, then echoes any request back as a response
 * with { echo: true, method, params } so tests can verify routing.
 */
function createFakeObsidian(): Promise<{
  server: net.Server;
  connections: net.Socket[];
  receivedMessages: Array<Record<string, unknown>>;
  close: () => Promise<void>;
}> {
  return new Promise((resolve) => {
    const connections: net.Socket[] = [];
    const receivedMessages: Array<Record<string, unknown>> = [];

    const server = net.createServer((socket) => {
      connections.push(socket);
      const rl = readline.createInterface({ input: socket });

      rl.on('line', (line) => {
        let msg: Record<string, unknown>;
        try { msg = JSON.parse(line); } catch { return; }
        receivedMessages.push(msg);

        // Respond to initialize
        if (msg.method === 'initialize') {
          socket.write(JSON.stringify(rpcResponse(msg.id as string, {
            protocolVersion: '2024-11-05',
            capabilities: {},
            serverInfo: { name: 'fake-obsidian', version: '1.0.0' },
          })) + '\n');
          return;
        }

        // Swallow notifications (no id)
        if (msg.id === undefined || msg.id === null) return;

        // Echo everything else back as a response
        socket.write(JSON.stringify(rpcResponse(msg.id as string, {
          echo: true,
          method: msg.method,
          params: msg.params,
        })) + '\n');
      });

      socket.on('error', () => {});
    });

    server.listen(OBSIDIAN_SOCKET, () => {
      resolve({
        server,
        connections,
        receivedMessages,
        close: () => new Promise<void>((res) => {
          connections.forEach((s) => s.destroy());
          server.close(() => {
            try { fs.unlinkSync(OBSIDIAN_SOCKET); } catch {}
            res();
          });
        }),
      });
    });
  });
}

/**
 * Start the mux daemon as a child process, patched to use our test sockets
 * and a short idle timeout.
 *
 * We write a patched copy of the mux to a temp file (swapping socket paths,
 * idle timeout, and forcing daemon mode) then spawn it directly.
 */
const PATCHED_MUX_PATH = `/tmp/nexus_mux_${TEST_ID}_patched.js`;

function writePatchedMux(): void {
  let src = fs.readFileSync(MUX_PATH, 'utf8');
  src = src.replace(/^#!.*\n/, '');
  src = src.replace(
    /const OBSIDIAN_SOCKET = .+/,
    `const OBSIDIAN_SOCKET = ${JSON.stringify(OBSIDIAN_SOCKET)};`,
  );
  src = src.replace(
    /const PROXY_SOCKET\s*= .+/,
    `const PROXY_SOCKET = ${JSON.stringify(PROXY_SOCKET)};`,
  );
  src = src.replace(
    /const IDLE_TIMEOUT_MS = .+/,
    `const IDLE_TIMEOUT_MS = ${TEST_IDLE_TIMEOUT_MS};`,
  );
  // Force daemon mode: replace the entry-point conditional with just runDaemon()
  src = src.replace(
    /if \(process\.argv\.includes\('--daemon'\)\) runDaemon\(\);\nelse runClient\(\);/,
    'runDaemon();',
  );
  fs.writeFileSync(PATCHED_MUX_PATH, src);
}

function startDaemon(): ChildProcess {
  writePatchedMux();
  const child = fork(PATCHED_MUX_PATH, [], {
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    env: { ...process.env, NEXUS_MUX_DEBUG: '1' },
  });
  return child;
}

/** Connect to the proxy socket and return a line-based interface. */
function connectClient(): Promise<{
  socket: net.Socket;
  lines: string[];
  waitForLine: (predicate?: (msg: Record<string, unknown>) => boolean) => Promise<Record<string, unknown>>;
  send: (msg: Record<string, unknown>) => void;
  close: () => void;
}> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(PROXY_SOCKET);
    const lines: string[] = [];
    const waiters: Array<{
      predicate: (msg: Record<string, unknown>) => boolean;
      resolve: (msg: Record<string, unknown>) => void;
    }> = [];

    socket.once('error', reject);

    socket.once('connect', () => {
      socket.removeListener('error', reject);
      const rl = readline.createInterface({ input: socket });

      rl.on('line', (line) => {
        lines.push(line);
        let msg: Record<string, unknown>;
        try { msg = JSON.parse(line); } catch { return; }

        // Check waiters
        for (let i = waiters.length - 1; i >= 0; i--) {
          if (waiters[i].predicate(msg)) {
            const waiter = waiters.splice(i, 1)[0];
            waiter.resolve(msg);
          }
        }
      });

      resolve({
        socket,
        lines,
        send: (msg) => socket.write(JSON.stringify(msg) + '\n'),
        waitForLine: (predicate = () => true) => new Promise((res) => {
          waiters.push({ predicate, resolve: res });
        }),
        close: () => socket.destroy(),
      });
    });
  });
}

/** Wait for the proxy socket to exist. */
async function waitForProxy(timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      fs.statSync(PROXY_SOCKET);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error(`Proxy socket ${PROXY_SOCKET} not created within ${timeoutMs}ms`);
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('nexus-mux', () => {
  let fakeObsidian: Awaited<ReturnType<typeof createFakeObsidian>>;
  let daemon: ChildProcess;

  beforeEach(async () => {
    // Clean up any stale sockets
    try { fs.unlinkSync(OBSIDIAN_SOCKET); } catch {}
    try { fs.unlinkSync(PROXY_SOCKET); } catch {}

    fakeObsidian = await createFakeObsidian();
    daemon = startDaemon();
    await waitForProxy();
  });

  afterEach(async () => {
    // Kill daemon
    if (daemon && !daemon.killed) {
      daemon.kill('SIGTERM');
      // Wait for it to die
      await new Promise<void>((resolve) => {
        daemon.once('exit', () => resolve());
        setTimeout(resolve, 2000);
      });
    }

    await fakeObsidian.close();

    // Final cleanup
    try { fs.unlinkSync(PROXY_SOCKET); } catch {}
    try { fs.unlinkSync(PATCHED_MUX_PATH); } catch {}
  });

  // ── Handshake ───────────────────────────────────────────────────────────

  it('performs MCP handshake with Obsidian on startup', async () => {
    // Give the daemon a moment to handshake
    await new Promise((r) => setTimeout(r, 500));

    const initMsg = fakeObsidian.receivedMessages.find(
      (m) => m.method === 'initialize'
    );
    expect(initMsg).toBeDefined();
    expect((initMsg!.params as Record<string, unknown>).clientInfo).toEqual({
      name: 'nexus-mux',
      version: '1.0.0',
    });

    // Should also have sent notifications/initialized
    const initialized = fakeObsidian.receivedMessages.find(
      (m) => m.method === 'notifications/initialized'
    );
    expect(initialized).toBeDefined();
  });

  // ── Client initialize ─────────────────────────────────────────────────

  it('replies to client initialize from cache without forwarding to Obsidian', async () => {
    // Wait for daemon to be ready
    await new Promise((r) => setTimeout(r, 500));
    const msgCountBefore = fakeObsidian.receivedMessages.length;

    const client = await connectClient();
    client.send(rpc('initialize', 1, {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '0.1.0' },
    }));

    const response = await client.waitForLine((m) => m.id === 1);
    expect(response.result).toBeDefined();
    expect((response.result as Record<string, unknown>).serverInfo).toEqual({
      name: 'fake-obsidian',
      version: '1.0.0',
    });

    // No new messages forwarded to Obsidian (initialize is handled locally)
    expect(fakeObsidian.receivedMessages.length).toBe(msgCountBefore);

    client.close();
  });

  // ── Request routing ───────────────────────────────────────────────────

  it('routes requests to Obsidian and responses back to the correct client', async () => {
    await new Promise((r) => setTimeout(r, 500));

    const client = await connectClient();

    // Do the handshake first
    client.send(rpc('initialize', 'init-1', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test', version: '0.1.0' },
    }));
    await client.waitForLine((m) => m.id === 'init-1');

    // Send a real request
    client.send(rpc('tools/list', 42));

    const response = await client.waitForLine((m) => m.id === 42);
    expect(response.result).toBeDefined();
    const result = response.result as Record<string, unknown>;
    expect(result.echo).toBe(true);
    expect(result.method).toBe('tools/list');

    // Verify the ID was rewritten for Obsidian (contains clientId prefix)
    const forwarded = fakeObsidian.receivedMessages.find(
      (m) => m.method === 'tools/list'
    );
    expect(forwarded).toBeDefined();
    expect(typeof forwarded!.id).toBe('string');
    expect((forwarded!.id as string)).toContain(':42');

    client.close();
  });

  // ── Multi-client routing ──────────────────────────────────────────────

  it('routes responses to the correct client when multiple are connected', async () => {
    await new Promise((r) => setTimeout(r, 500));

    const clientA = await connectClient();
    const clientB = await connectClient();

    // Handshake both
    for (const [client, name] of [[clientA, 'A'], [clientB, 'B']] as const) {
      client.send(rpc('initialize', `init-${name}`, {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: `client-${name}`, version: '0.1.0' },
      }));
      await client.waitForLine((m) => m.id === `init-${name}`);
    }

    // Both send requests with the same ID (collision test)
    clientA.send(rpc('tools/list', 1));
    clientB.send(rpc('resources/list', 1));

    const responseA = await clientA.waitForLine((m) => m.id === 1);
    const responseB = await clientB.waitForLine((m) => m.id === 1);

    // Each gets their own response back, with the original ID restored
    expect((responseA.result as Record<string, unknown>).method).toBe('tools/list');
    expect((responseB.result as Record<string, unknown>).method).toBe('resources/list');

    clientA.close();
    clientB.close();
  });

  // ── Shutdown interception ─────────────────────────────────────────────

  it('intercepts shutdown/exit without forwarding to Obsidian', async () => {
    await new Promise((r) => setTimeout(r, 500));
    const msgCountBefore = fakeObsidian.receivedMessages.length;

    const client = await connectClient();
    client.send(rpc('initialize', 'init', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test', version: '0.1.0' },
    }));
    await client.waitForLine((m) => m.id === 'init');

    // shutdown should be acked locally
    client.send(rpc('shutdown', 'sd-1'));
    const sdResponse = await client.waitForLine((m) => m.id === 'sd-1');
    expect(sdResponse.result).toBeNull();

    // exit (notification, no id) should be swallowed
    client.send(rpc('exit'));

    // Brief wait, then verify nothing was forwarded
    await new Promise((r) => setTimeout(r, 200));
    const newMessages = fakeObsidian.receivedMessages.slice(msgCountBefore);
    const forwarded = newMessages.filter(
      (m) => m.method === 'shutdown' || m.method === 'exit'
    );
    expect(forwarded).toHaveLength(0);

    client.close();
  });

  // ── notifications/initialized swallowed ───────────────────────────────

  it('swallows client notifications/initialized', async () => {
    await new Promise((r) => setTimeout(r, 500));
    const msgCountBefore = fakeObsidian.receivedMessages.length;

    const client = await connectClient();
    client.send(rpc('initialize', 'init', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test', version: '0.1.0' },
    }));
    await client.waitForLine((m) => m.id === 'init');

    client.send(rpc('notifications/initialized'));

    await new Promise((r) => setTimeout(r, 200));
    const newMessages = fakeObsidian.receivedMessages.slice(msgCountBefore);
    const forwarded = newMessages.filter(
      (m) => m.method === 'notifications/initialized'
    );
    expect(forwarded).toHaveLength(0);

    client.close();
  });

  // ── Idle timeout ──────────────────────────────────────────────────────

  it('shuts down after idle timeout with no clients', async () => {
    await new Promise((r) => setTimeout(r, 500));

    // Connect and then disconnect a client
    const client = await connectClient();
    client.send(rpc('initialize', 'init', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test', version: '0.1.0' },
    }));
    await client.waitForLine((m) => m.id === 'init');
    client.close();

    // Daemon should exit after TEST_IDLE_TIMEOUT_MS (1s) + some grace
    const exitCode = await new Promise<number | null>((resolve) => {
      const timeout = setTimeout(() => resolve(null), 5000);
      daemon.once('exit', (code) => {
        clearTimeout(timeout);
        resolve(code);
      });
    });

    expect(exitCode).toBe(0);

    // Proxy socket should be cleaned up
    expect(() => fs.statSync(PROXY_SOCKET)).toThrow();
  });

  it('cancels idle timeout when a new client connects', async () => {
    await new Promise((r) => setTimeout(r, 500));

    // Connect, disconnect — starts idle timer
    const client1 = await connectClient();
    client1.close();

    // Wait for most of the idle timeout, then connect again
    await new Promise((r) => setTimeout(r, TEST_IDLE_TIMEOUT_MS * 0.7));

    const client2 = await connectClient();
    client2.send(rpc('initialize', 'init', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test', version: '0.1.0' },
    }));
    const response = await client2.waitForLine((m) => m.id === 'init');
    expect(response.result).toBeDefined();

    // Daemon should still be alive after the original timeout would have fired
    await new Promise((r) => setTimeout(r, TEST_IDLE_TIMEOUT_MS * 0.5));
    expect(daemon.killed).toBe(false);
    expect(daemon.exitCode).toBeNull();

    client2.close();
  });

  // ── Boot idle timeout ─────────────────────────────────────────────────

  it('shuts down if no client ever connects', async () => {
    // Don't connect any clients — daemon should exit after idle timeout
    const exitCode = await new Promise<number | null>((resolve) => {
      const timeout = setTimeout(() => resolve(null), 5000);
      daemon.once('exit', (code) => {
        clearTimeout(timeout);
        resolve(code);
      });
    });

    expect(exitCode).toBe(0);
  });
});
