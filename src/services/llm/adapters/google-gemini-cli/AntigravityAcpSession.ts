import type { DesktopChildProcess } from '../../../../utils/desktopProcess';
import { spawnDesktopProcess } from '../../../../utils/desktopProcess';
import { desktopRequire } from '../../../../utils/desktopRequire';
import { buildGeminiCliEnv } from '../../../../utils/geminiCli';
import { LLMProviderError } from '../types';

type Frame = Record<string, unknown>;
type Pending = { resolve: (frame: Frame) => void; reject: (error: Error) => void };

export const ANTIGRAVITY_PROVIDER = 'google-gemini-cli';
// Exact ACP names produced by the IDE bridge for the Nexus MCP server.
export const ANTIGRAVITY_TOOLS = new Map([
  ['mcp_ide-tools_toolManager_getTools', 'getTools'],
  ['mcp_ide-tools_toolManager_useTools', 'useTools']
]);

const AGENT_NAME = 'nexus-vault';
const AGENT = `---
name: nexus-vault
description: Works with the current Obsidian vault through Nexus.
mainAgent: true
subagent: false
tools: []
inheritCustomizations: false
inheritMcp: false
excludeDefaultComponents: true
commandExecutionPolicy: "off"
---
Use the Nexus MCP tools for all vault operations.
`;
const INACTIVITY_TIMEOUT_MS = 120_000;
const SESSION_TIMEOUT_MS = 300_000;

export function asAcpObject(value: unknown): Frame {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Frame : {};
}

function rpcError(value: unknown): Error {
  const { code, message } = asAcpObject(value);
  if (code === -32000) {
    return new LLMProviderError(
      'Antigravity is not signed in. Run agy acp --login and reconnect in Nexus settings.',
      ANTIGRAVITY_PROVIDER, 'AUTHENTICATION_ERROR'
    );
  }
  return new LLMProviderError(
    typeof message === 'string' ? message : 'Antigravity ACP request failed.',
    ANTIGRAVITY_PROVIDER, 'PROVIDER_ERROR'
  );
}

class AntigravityConnection {
  private nextId = 0;
  private pending = new Map<number, Pending>();
  private failure: Error | undefined;
  private timer: number | undefined;
  private readonly exited: Promise<void>;
  private readonly sessionTimer: number;
  private readonly reader: ReturnType<typeof import('node:readline').createInterface>;
  private stop = () => this.fail(new DOMException('Antigravity request cancelled', 'AbortError'));

  constructor(
    private child: DesktopChildProcess,
    private readonly signal: AbortSignal | undefined,
    private readonly toolsEnabled: boolean,
    private readonly onUpdate: (frame: Frame) => void
  ) {
    const readline = desktopRequire<typeof import('node:readline')>('node:readline');
    if (!child.stdout) throw new Error('Could not capture Antigravity ACP output.');
    this.reader = readline.createInterface({ input: child.stdout });
    this.exited = new Promise(resolve => child.once('close', () => resolve()));
    this.sessionTimer = window.setTimeout(() => this.fail(new LLMProviderError(
      'Antigravity reached the session time limit.', ANTIGRAVITY_PROVIDER, 'PROVIDER_TIMEOUT'
    )), SESSION_TIMEOUT_MS);
    this.reader.on('line', this.receive);
    child.stderr?.resume();
    child.on('error', () => this.fail(new Error('Could not launch Antigravity ACP.')));
    child.stdin?.on('error', () => this.fail(new Error('Antigravity closed its input stream.')));
    child.on('close', (code) => this.fail(new Error(`Antigravity ACP exited with status ${code ?? 'unknown'}.`)));
    signal?.addEventListener('abort', this.stop, { once: true });
    if (signal?.aborted) this.stop();
  }

  async request(method: string, params: Frame): Promise<Frame> {
    if (this.failure) throw this.failure;
    const id = ++this.nextId;
    return new Promise<Frame>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.resetTimeout();
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  async close(): Promise<void> {
    this.signal?.removeEventListener('abort', this.stop);
    this.reader.close();
    this.fail(new Error('Antigravity ACP session closed.'));
    const forceExit = window.setTimeout(() => this.child.kill('SIGKILL'), 2_000);
    try {
      await this.exited;
    } finally {
      window.clearTimeout(forceExit);
    }
  }

  private resetTimeout(): void {
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.fail(new LLMProviderError(
      'Antigravity stopped responding.',
      ANTIGRAVITY_PROVIDER, 'PROVIDER_TIMEOUT'
    )), INACTIVITY_TIMEOUT_MS);
  }

  private send(message: Frame): void {
    this.child.stdin?.write(JSON.stringify(message) + '\n');
  }

  private receive = (line: string): void => {
    let frame: Frame;
    try {
      frame = asAcpObject(JSON.parse(line));
    } catch {
      return;
    }
    if (this.pending.size > 0) this.resetTimeout();
    if (frame.method === 'session/update') {
      this.onUpdate(asAcpObject(asAcpObject(frame.params).update));
      return;
    }
    if (frame.method === 'session/request_permission' && frame.id != null) {
      const params = asAcpObject(frame.params);
      const name = asAcpObject(params.toolCall).name;
      const allowed = this.toolsEnabled && typeof name === 'string' && ANTIGRAVITY_TOOLS.has(name);
      const options = Array.isArray(params.options) ? params.options.map(asAcpObject) : [];
      const option = options.find(item => item.kind === (allowed ? 'allow_once' : 'reject_once'));
      const outcome = typeof option?.optionId === 'string'
        ? { outcome: 'selected', optionId: option.optionId }
        : { outcome: 'cancelled' };
      this.send({ jsonrpc: '2.0', id: frame.id, result: { outcome } });
      return;
    }
    if (typeof frame.method === 'string' && frame.id != null) {
      this.send({ jsonrpc: '2.0', id: frame.id, error: { code: -32601, message: 'Unsupported client method' } });
      return;
    }
    if (typeof frame.id !== 'number') return;
    const request = this.pending.get(frame.id);
    if (!request) return;
    this.pending.delete(frame.id);
    if (this.pending.size === 0) window.clearTimeout(this.timer);
    if (frame.error) request.reject(rpcError(frame.error));
    else request.resolve(asAcpObject(frame.result));
  };

  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    window.clearTimeout(this.sessionTimer);
    window.clearTimeout(this.timer);
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
    this.child.kill();
  }
}

export interface AntigravitySessionOptions {
  binary: string;
  nodePath?: string;
  ipcPath?: string;
  systemPrompt?: string;
  signal?: AbortSignal;
  onUpdate: (update: Frame) => void;
}

export async function withAntigravitySession<T>(
  options: AntigravitySessionOptions,
  run: (connection: AntigravityConnection, session: Frame) => Promise<T>
): Promise<T> {
  const fs = desktopRequire<typeof import('node:fs/promises')>('node:fs/promises');
  const path = desktopRequire<typeof import('node:path')>('node:path');
  const os = desktopRequire<typeof import('node:os')>('node:os');
  const childProcess = desktopRequire<typeof import('node:child_process')>('node:child_process');
  if (options.signal?.aborted) throw new DOMException('Antigravity request cancelled', 'AbortError');
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-antigravity-'));
  const appData = path.basename(workspace);
  let connection: AntigravityConnection | undefined;
  try {
    const agents = path.join(workspace, '.agents', 'agents');
    await fs.mkdir(agents, { recursive: true });
    await fs.writeFile(path.join(agents, AGENT_NAME + '.md'), AGENT);
    const env = buildGeminiCliEnv(options.nodePath);
    const args = [
      'acp', '--agent', AGENT_NAME, '--include-default-customizations=false',
      '--disable-telemetry', '--app-data-dir', appData, '--log-file', path.join(workspace, 'acp.log')
    ];
    if (options.ipcPath && options.nodePath) {
      // The official IDE transport launches nc via PATH. Our private shim links
      // its stdio to the current vault's Unix socket, so no TCP port is opened.
      const socket = await fs.stat(options.ipcPath).catch(() => undefined);
      if (!socket?.isSocket()) {
        throw new LLMProviderError('Enable the Nexus MCP server for this vault before using vault tools.',
          ANTIGRAVITY_PROVIDER, 'CONFIGURATION_ERROR');
      }
      const shim = path.join(workspace, 'nexus-ipc.cjs');
      await fs.writeFile(shim,
        "const socket = require('node:net').createConnection(process.env.NEXUS_AGY_VAULT_SOCKET);\n" +
        "socket.once('error', () => { process.exitCode = 1; process.stdin.pause(); });\n" +
        "socket.once('close', () => process.stdin.pause());\n" +
        "process.stdin.pipe(socket); socket.pipe(process.stdout);\n"
      );
      await fs.writeFile(path.join(workspace, 'nc'), '#!/bin/sh\nexec "$NEXUS_AGY_NODE" "$NEXUS_AGY_SHIM"\n', { mode: 0o700 });
      env.NEXUS_AGY_NODE = options.nodePath;
      env.NEXUS_AGY_SHIM = shim;
      env.NEXUS_AGY_VAULT_SOCKET = options.ipcPath;
      env.PATH = workspace + path.delimiter + (env.PATH ?? '');
      args.push('--ide-mcp-port', '1');
    }
    connection = new AntigravityConnection(spawnDesktopProcess(childProcess, options.binary, args, {
      cwd: workspace, env, shell: false, stdio: ['pipe', 'pipe', 'pipe']
    }), options.signal, Boolean(options.ipcPath), options.onUpdate);
    const init = await connection.request('initialize', {
      protocolVersion: 1,
      clientInfo: { name: 'nexus', version: '1' },
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }
    });
    if (init.protocolVersion !== 1) throw new Error('Antigravity did not negotiate ACP version 1.');
    const version = asAcpObject(init.agentInfo).version;
    const release = typeof version === 'string' && /^(\d+)\.(\d+)\.(\d+)(?:[+-].*)?$/.exec(version);
    if (!release || Number(release[1]) < 1 || (release[1] === '1' &&
        (Number(release[2]) < 5 || (release[2] === '5' && Number(release[3]) < 14)))) {
      throw new LLMProviderError('Update Antigravity CLI to version 1.5.14 or newer.',
        ANTIGRAVITY_PROVIDER, 'CONFIGURATION_ERROR');
    }
    const capability = asAcpObject(asAcpObject(init.agentCapabilities)._meta);
    const systemPrompt = asAcpObject(asAcpObject(capability.antigravity).systemPrompt);
    if (options.systemPrompt && systemPrompt.append !== true) {
      throw new LLMProviderError('This Antigravity CLI cannot accept Nexus chat instructions.',
        ANTIGRAVITY_PROVIDER, 'CONFIGURATION_ERROR');
    }
    const session = await connection.request('session/new', {
      cwd: workspace,
      mcpServers: [],
      _meta: options.systemPrompt ? { antigravity: { systemPrompt: { append: options.systemPrompt } } } : undefined
    });
    if (typeof session.sessionId !== 'string') throw new Error('Antigravity did not create an ACP session.');
    return await run(connection, session);
  } finally {
    await connection?.close();
    await Promise.allSettled([
      fs.rm(workspace, { recursive: true, force: true }),
      fs.rm(path.join(os.homedir(), '.gemini', appData), { recursive: true, force: true })
    ]);
  }
}
