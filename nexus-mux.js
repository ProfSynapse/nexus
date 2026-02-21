#!/usr/bin/env node
// nexus-mux.js — MCP multiplexer for Obsidian nexus-core
//
// The nexus plugin exposes a single-transport MCP server over a Unix socket.
// Only one client can hold that transport at a time.  This multiplexer sits
// in front, owning the one Obsidian connection and fanning out to any number
// of Claude clients (Code, Desktop, Claudian) via a proxy socket.
//
// Architecture:
//   Claude (stdio) → [client mode] → proxy socket → [daemon] → Obsidian socket
//
// Two modes:
//   --daemon   Long-running process.  Connects to Obsidian, listens on the
//              proxy socket, multiplexes requests/responses between clients.
//              Shuts itself down after IDLE_TIMEOUT_MS with no clients.
//   (default)  Short-lived stdio bridge.  Connects to the proxy socket (auto-
//              starting the daemon if needed) and pipes stdin/stdout through.
//              This is what MCP clients actually spawn.
"use strict";

const net       = require('net');
const { spawn } = require('child_process');
const readline  = require('readline');
const fs        = require('fs');

// Obsidian's IPC socket — created by the nexus plugin on load
const OBSIDIAN_SOCKET = '/tmp/nexus_mcp_core.sock';
// Proxy socket — the daemon listens here for client connections
const PROXY_SOCKET    = '/tmp/nexus_mcp_proxy.sock';
// Daemon exits after this long with zero connected clients
const IDLE_TIMEOUT_MS = 5 * 60 * 1000;

const log = process.env.NEXUS_MUX_DEBUG
  ? (...a) => process.stderr.write('[mux] ' + a.join(' ') + '\n')
  : () => {};

// ── Daemon ────────────────────────────────────────────────────────────────────

function runDaemon() {
  // — Obsidian connection state —
  let obsidian     = null;   // net.Socket to Obsidian, null when disconnected
  let ready        = false;  // true once our MCP handshake with Obsidian completes
  let serverResult = null;   // cached initialize result — replayed to each client

  // — Client bookkeeping —
  const clients     = new Map();  // clientId → { socket }
  const pending     = new Map();  // rewrittenId → { clientId, origId }
  const queue       = [];         // messages buffered while Obsidian is (re)connecting
  const pendingInit = new Map();  // clientId → msgId (clients awaiting init response)
  let   idleTimer   = null;       // handle for the idle shutdown timer

  // — Idle shutdown —
  // When the last client disconnects, start a countdown.  If no new client
  // arrives before it fires, the daemon tears down cleanly.  The timer is
  // also started on boot in case the spawning client never connects.

  const teardown = () => {
    try { fs.unlinkSync(PROXY_SOCKET); } catch {}
    process.exit(0);
  };

  function resetIdleTimer() {
    if (idleTimer) clearTimeout(idleTimer);
    if (clients.size === 0) {
      log(`no clients — shutting down in ${IDLE_TIMEOUT_MS / 1000}s`);
      idleTimer = setTimeout(() => {
        log('idle timeout reached, exiting');
        teardown();
      }, IDLE_TIMEOUT_MS);
    }
  }

  function cancelIdleTimer() {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  }

  // — Obsidian message plumbing —

  /** Send a JSON-RPC message to Obsidian, or queue it if not yet connected. */
  function toObsidian(msg) {
    if (ready && obsidian) obsidian.write(JSON.stringify(msg) + '\n');
    else queue.push(msg);
  }

  /** Drain the queue once the Obsidian connection is live. */
  function flush() {
    while (queue.length && ready && obsidian)
      obsidian.write(JSON.stringify(queue.shift()) + '\n');
  }

  /** Send a synthetic initialize response to a client using our cached result. */
  function replyInit(clientId, msgId) {
    const c = clients.get(clientId);
    if (c) c.socket.write(JSON.stringify({
      jsonrpc: '2.0', id: msgId,
      result: serverResult,
    }) + '\n');
  }

  // — Obsidian connection lifecycle —
  // We maintain exactly one MCP session with Obsidian.  If the connection
  // drops (Obsidian restart, plugin reload), we reconnect and re-handshake.

  function connectObsidian() {
    log('connecting to Obsidian…');
    const sock = net.createConnection(OBSIDIAN_SOCKET);
    const rl   = readline.createInterface({ input: sock });

    sock.on('connect', () => {
      obsidian = sock;
      // Perform the MCP handshake — one session for the lifetime of this daemon
      sock.write(JSON.stringify({
        jsonrpc: '2.0', id: '__mux__', method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: { roots: { listChanged: true }, sampling: {} },
          clientInfo: { name: 'nexus-mux', version: '1.0.0' },
        },
      }) + '\n');
    });

    rl.on('line', line => {
      let msg;
      try { msg = JSON.parse(line); } catch { return; }

      // Before the handshake completes, the only message we expect is our
      // own initialize response.  Everything else is ignored.
      if (!ready) {
        if (msg.id === '__mux__' && msg.result) {
          serverResult = msg.result;
          sock.write(JSON.stringify({
            jsonrpc: '2.0', method: 'notifications/initialized',
          }) + '\n');
          ready = true;
          log('Obsidian ready');
          // Any clients that connected before the handshake finished get
          // their initialize response now
          for (const [cid, msgId] of pendingInit) replyInit(cid, msgId);
          pendingInit.clear();
          flush();
        }
        return;
      }

      // — Route responses and notifications to clients —

      if (msg.id !== undefined && msg.id !== null) {
        // Response: look up which client sent the original request via the
        // rewritten ID (format: "clientId:originalId")
        const key = typeof msg.id === 'string' ? msg.id : JSON.stringify(msg.id);
        const p   = pending.get(key);
        if (p) {
          pending.delete(key);
          const c = clients.get(p.clientId);
          if (c) c.socket.write(JSON.stringify({ ...msg, id: p.origId }) + '\n');
        }
      } else {
        // Notification (no id): broadcast to every connected client
        const out = JSON.stringify(msg) + '\n';
        for (const c of clients.values()) c.socket.write(out);
      }
    });

    const reconnect = () => {
      obsidian = null;
      ready    = false;
      log('Obsidian disconnected, retrying in 1.5s…');
      setTimeout(connectObsidian, 1500);
    };
    sock.on('error', reconnect);
    sock.on('close', reconnect);
  }

  // — Proxy server —
  // Each MCP client (Claude Code, Desktop, Claudian) connects here.
  // We intercept session-lifecycle messages (initialize, shutdown) so that
  // individual clients can come and go without disturbing the one Obsidian
  // session.  Everything else is forwarded with rewritten IDs for routing.

  // Clean up stale socket from a previous crash
  try { fs.unlinkSync(PROXY_SOCKET); } catch {}

  const server = net.createServer(clientSock => {
    const id = Math.random().toString(36).slice(2, 8);
    log(`client ${id} connected`);
    cancelIdleTimer();
    clients.set(id, { socket: clientSock });
    const rl = readline.createInterface({ input: clientSock });

    rl.on('line', line => {
      let msg;
      try { msg = JSON.parse(line); } catch { return; }

      // initialize — reply from cache (or queue if Obsidian isn't ready yet).
      // Never forward to Obsidian; we already have a session.
      if (msg.method === 'initialize') {
        if (ready) {
          replyInit(id, msg.id);
        } else {
          pendingInit.set(id, msg.id);
        }
        return;
      }

      // initialized — swallow; our own was sent during the handshake
      if (msg.method === 'notifications/initialized') return;

      // shutdown / exit — ack locally.  One client leaving doesn't end
      // the Obsidian session; other clients may still be connected.
      if (msg.method === 'shutdown' || msg.method === 'exit') {
        if (msg.id !== undefined && msg.id !== null)
          clientSock.write(JSON.stringify({
            jsonrpc: '2.0', id: msg.id, result: null,
          }) + '\n');
        return;
      }

      // All other messages: rewrite the ID so we can route the response
      // back to this specific client, then forward to Obsidian.
      if (msg.id !== undefined && msg.id !== null) {
        const rewritten = `${id}:${msg.id}`;
        pending.set(rewritten, { clientId: id, origId: msg.id });
        toObsidian({ ...msg, id: rewritten });
      } else {
        // Notifications (no id) pass straight through
        toObsidian(msg);
      }
    });

    const cleanup = () => {
      clients.delete(id);
      pendingInit.delete(id);
      // Drop any pending responses for this client — Obsidian's replies
      // will arrive but we'll have nowhere to send them; that's fine.
      for (const [k, p] of pending) if (p.clientId === id) pending.delete(k);
      log(`client ${id} gone (${clients.size} remaining)`);
      resetIdleTimer();
    };
    clientSock.on('close', cleanup);
    clientSock.on('error', cleanup);
  });

  server.listen(PROXY_SOCKET, () => {
    log(`proxy listening on ${PROXY_SOCKET}`);
    connectObsidian();
    // Start idle timer — if no client connects within the timeout, exit.
    // (The spawning client usually connects within ~1s, cancelling this.)
    resetIdleTimer();
  });

  process.on('exit',    () => { try { fs.unlinkSync(PROXY_SOCKET); } catch {} });
  process.on('SIGTERM', teardown);
  process.on('SIGINT',  teardown);
  process.on('SIGHUP',  teardown);
}

// ── Client (stdio bridge) ─────────────────────────────────────────────────────
// This is the process that MCP clients actually spawn.  It connects to the
// daemon's proxy socket and pipes stdin/stdout through — a transparent bridge.
// If the daemon isn't running, it spawns one and retries.

function runClient(attempt = 0) {
  const sock = net.createConnection(PROXY_SOCKET);

  sock.once('connect', () => {
    process.stdin.pipe(sock);
    sock.pipe(process.stdout);
  });

  sock.once('error', () => {
    if (attempt === 0) {
      // First failure — no daemon running.  Spawn one detached and retry.
      log('starting daemon…');
      spawn(process.execPath, [__filename, '--daemon'], {
        detached: true,
        stdio:    'ignore',
      }).unref();
      setTimeout(() => runClient(1), 700);
    } else if (attempt < 20) {
      // Daemon is probably still starting up — keep trying
      setTimeout(() => runClient(attempt + 1), 300);
    } else {
      // Give up after ~7s of retries
      process.exit(1);
    }
  });

  // If the proxy socket closes, we're done
  sock.on('close', () => process.exit(0));
  // If the MCP client closes stdin, tear down our side
  process.stdin.on('end', () => sock.destroy());
}

// ── Entry ─────────────────────────────────────────────────────────────────────

if (process.argv.includes('--daemon')) runDaemon();
else runClient();
