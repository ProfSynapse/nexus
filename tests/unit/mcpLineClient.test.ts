import { parseJsonRpcResponse } from '../../cli/mcpLineClient';

describe('parseJsonRpcResponse', () => {
    it('accepts result and error responses with the expected shape', () => {
        expect(parseJsonRpcResponse('{"jsonrpc":"2.0","id":1,"result":{"ok":true}}')).toEqual({
            id: 1,
            result: { ok: true },
        });
        expect(parseJsonRpcResponse('{"jsonrpc":"2.0","id":2,"error":{"code":-32603,"message":"failed"}}')).toEqual({
            id: 2,
            error: { code: -32603, message: 'failed' },
        });
    });

    it.each([
        'not json',
        'null',
        '"text"',
        '[]',
        '{"id":"1","result":{}}',
        '{"id":1,"error":null}',
        '{"id":1,"error":{"code":"bad","message":"failed"}}',
    ])('rejects malformed or non-response input: %s', (input) => {
        expect(parseJsonRpcResponse(input)).toBeNull();
    });
});

import { createServer, Server } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    DEFAULT_TIMEOUT_MS,
    DEFAULT_TOOL_CALL_TIMEOUT_MS,
    McpLineClient,
    parseTimeoutEnv,
} from '../../cli/mcpLineClient';

describe('parseTimeoutEnv', () => {
    it.each([
        [undefined, undefined],
        ['', undefined],
        ['abc', undefined],
        ['0', undefined],
        ['-5', undefined],
        ['1500', 1500],
        ['1500.9', 1500],
    ])('parses %p as %p', (raw, expected) => {
        expect(parseTimeoutEnv(raw)).toBe(expected);
    });
});

describe('McpLineClient timeouts', () => {
    /**
     * A fake Nexus socket server: answers initialize immediately and delays
     * tools/call by `toolDelayMs`, so the two timeouts can be told apart.
     */
    function startServer(toolDelayMs: number): { server: Server; socketPath: string; dir: string } {
        const dir = mkdtempSync(join(tmpdir(), 'nexus-cli-'));
        const socketPath = join(dir, 'nexus.sock');
        const server = createServer((socket) => {
            let buffer = '';
            socket.on('data', (chunk) => {
                buffer += chunk.toString('utf8');
                let idx: number;
                while ((idx = buffer.indexOf('\n')) >= 0) {
                    const line = buffer.slice(0, idx);
                    buffer = buffer.slice(idx + 1);
                    if (!line.trim()) continue;
                    const msg = JSON.parse(line) as { id?: number; method: string };
                    if (msg.id === undefined) continue; // notification
                    const reply = JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { method: msg.method } }) + '\n';
                    if (msg.method === 'tools/call') {
                        setTimeout(() => socket.write(reply), toolDelayMs);
                    } else {
                        socket.write(reply);
                    }
                }
            });
        });
        server.listen(socketPath);
        return { server, socketPath, dir };
    }

    it('defaults to a short handshake timeout and a ten-minute tool-call timeout', () => {
        expect(DEFAULT_TIMEOUT_MS).toBe(20_000);
        expect(DEFAULT_TOOL_CALL_TIMEOUT_MS).toBe(600_000);
    });

    it('lets a tools/call outlive the handshake timeout', async () => {
        const { server, socketPath, dir } = startServer(120);
        const client = new McpLineClient(socketPath, { timeoutMs: 40, toolCallTimeoutMs: 2_000 });
        try {
            await client.connect();
            await client.initialize();
            const result = await client.callTool('toolManager_useTools', {});
            expect(result).toEqual({ method: 'tools/call' });
        } finally {
            client.close();
            server.close();
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('still times out a tools/call that exceeds the tool-call budget, naming the method', async () => {
        const { server, socketPath, dir } = startServer(500);
        const client = new McpLineClient(socketPath, { timeoutMs: 40, toolCallTimeoutMs: 60 });
        try {
            await client.connect();
            await client.initialize();
            await expect(client.callTool('toolManager_useTools', {}))
                .rejects.toThrow('Timeout after 60ms waiting for "tools/call"');
        } finally {
            client.close();
            server.close();
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
