import { JSONLWriter } from '../../src/database/storage/JSONLWriter';

describe('JSONLWriter', () => {
  it('merges primary and fallback read roots without duplicating event ids', async () => {
    const files = new Map<string, string>([
      ['.obsidian/plugins/claudesidian-mcp/data/conversations/conv_alpha.jsonl', '{"id":"evt-1","deviceId":"a","timestamp":1}\n'],
      ['.nexus/conversations/conv_alpha.jsonl', '{"id":"evt-1","deviceId":"a","timestamp":1}\n{"id":"evt-2","deviceId":"b","timestamp":2}\n']
    ]);

    const writer = new JSONLWriter({
      app: {
        loadLocalStorage: jest.fn().mockReturnValue('device-a'),
        saveLocalStorage: jest.fn(),
        vault: {
          adapter: {
            exists: jest.fn(async (path: string) => files.has(path)),
            read: jest.fn(async (path: string) => files.get(path) ?? ''),
            list: jest.fn(async (path: string) => ({
              files: Array.from(files.keys()).filter(filePath => filePath.startsWith(`${path}/`)),
              folders: []
            }))
          }
        }
      } as never,
      basePath: '.obsidian/plugins/claudesidian-mcp/data',
      readBasePaths: ['.obsidian/plugins/claudesidian-mcp/data', '.nexus']
    });

    const events = await writer.readEvents<{ id: string; deviceId: string; timestamp: number }>('conversations/conv_alpha.jsonl');

    expect(events).toEqual([
      { id: 'evt-1', deviceId: 'a', timestamp: 1 },
      { id: 'evt-2', deviceId: 'b', timestamp: 2 }
    ]);
  });
});