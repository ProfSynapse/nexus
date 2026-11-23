import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { DesktopChildProcess } from '../../src/utils/desktopProcess';
import { spawnDesktopProcess } from '../../src/utils/desktopProcess';
import { withAntigravitySession } from '../../src/services/llm/adapters/google-gemini-cli/AntigravityAcpSession';

jest.mock('../../src/utils/desktopProcess');

const emitJson = (stream: PassThrough, frame: Record<string, unknown>) => {
  stream.write(JSON.stringify({ jsonrpc: '2.0', ...frame }) + '\n');
};

describe('Antigravity ACP permissions', () => {
  const fs = {
    mkdtemp: jest.fn().mockResolvedValue('/scratch/nexus-antigravity-test'),
    mkdir: jest.fn(),
    writeFile: jest.fn(),
    stat: jest.fn().mockResolvedValue({ isSocket: () => true }),
    rm: jest.fn()
  };

  beforeEach(() => {
    jest.replaceProperty(globalThis, 'window', {
      require: (name: string) => name === 'node:fs/promises' ? fs : require(name),
      setTimeout,
      clearTimeout
    });
  });

  afterEach(() => jest.restoreAllMocks());

  it('allows only the real Nexus MCP tool names when tools are enabled', async () => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: () => child.emit('close', 0)
    });
    jest.mocked(spawnDesktopProcess).mockReturnValue(child as unknown as DesktopChildProcess);
    const names = [
      'mcp_ide-tools_toolManager_getTools',
      'mcp_ide-tools_toolManager_useTools',
      'mcp_other_toolManager_useTools',
      'mcp_ide-tools_useTools',
      'run_command'
    ];
    const approvals: string[] = [];
    child.stdin.on('data', (line: Buffer) => {
      const message = JSON.parse(line.toString());
      switch (message.method) {
        case 'initialize':
          emitJson(child.stdout, { id: message.id, result: { protocolVersion: 1, agentInfo: { version: '1.5.14' } } });
          break;
        case 'session/new':
          emitJson(child.stdout, { id: message.id, result: { sessionId: 'test-session' } });
          break;
        case 'session/prompt':
          for (const name of names) {
            emitJson(child.stdout, {
              id: name, method: 'session/request_permission',
              params: { toolCall: { name }, options: [
                { kind: 'allow_once', optionId: 'allow' }, { kind: 'reject_once', optionId: 'deny' }
              ] }
            });
          }
          emitJson(child.stdout, { id: message.id, result: { stopReason: 'end_turn' } });
          break;
        default:
          approvals.push(message.result.outcome.optionId);
      }
    });

    await withAntigravitySession({
      binary: '/bin/agy', nodePath: '/bin/node', ipcPath: '/vault.sock', onUpdate: jest.fn()
    }, async (rpc, { sessionId }) => {
      await rpc.request('session/prompt', { sessionId, prompt: [] });
    });

    expect(approvals).toEqual(['allow', 'allow', 'deny', 'deny', 'deny']);
  });
});
