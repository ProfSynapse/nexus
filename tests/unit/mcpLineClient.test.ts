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
