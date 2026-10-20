import {
  compactTraceMetadata,
  compactTraceMetadataJson,
  MAX_TRACE_METADATA_BYTES,
  utf8ByteLength
} from '../../src/services/trace/TraceMetadataCompactor';
import { splitTopLevelSegments, tokenize } from '../../src/agents/toolManager/services/ToolCliNormalizer';

/**
 * Same quoting the CLI applies when it splices `--content-stdin` /
 * `--content-file` payloads into the command (cli/commandLine.ts
 * `quoteToolToken`), so fixtures have the shape real traces have.
 */
function cliQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=-]+$/.test(value)) return value;
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
  return `"${escaped}"`;
}

function cliCommand(argv: string[]): string {
  return argv.map(cliQuote).join(' ');
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return `sha256:${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')}`;
}

function useToolsTrace(tool: string): Record<string, unknown> {
  return {
    schemaVersion: 1,
    tool: { id: 'toolManager_useTools', agent: 'toolManager', mode: 'useTools' },
    context: { workspaceId: 'ws-1', sessionId: 's-1', memory: 'Writing QA evidence.', goal: 'Record the fixture.' },
    input: { arguments: { tool } },
    outcome: { success: true },
    batch: { results: [{ agent: 'contentManager', tool: 'write', success: true }] }
  };
}

/** A payload with every character class the CLI has to escape. */
function awkwardPayload(bytes: number): string {
  const unit = '{"quote":"say \\"hi\\"","path":"C:\\\\dir","emoji":"🧪✓"}\n\t, next\r\n';
  return unit.repeat(Math.ceil(bytes / unit.length)).slice(0, bytes);
}

describe('compactTraceMetadata', () => {
  it('returns ordinary traces untouched, as the same object', async () => {
    const metadata = useToolsTrace(cliCommand(['content', 'read', '--path', 'Projects/A.md']));
    const result = await compactTraceMetadata(metadata);
    expect(result.changed).toBe(false);
    expect(result.metadata).toBe(metadata);
    expect(result.json).toBe(JSON.stringify(metadata));
  });

  it('replaces a spliced content payload but keeps the command parseable', async () => {
    const payload = awkwardPayload(3 * 1024 * 1024);
    const tool = cliCommand(['content', 'write', '--path', 'QA Evidence/native "after".json', '--content', payload, '--overwrite']);
    const metadata = useToolsTrace(tool);

    const result = await compactTraceMetadata(metadata);
    expect(result.changed).toBe(true);
    expect(utf8ByteLength(result.json)).toBeLessThan(MAX_TRACE_METADATA_BYTES);

    const compactedTool = (result.metadata as { input: { arguments: { tool: string } } }).input.arguments.tool;
    const tokens = tokenize(compactedTool);
    expect(tokens.slice(0, 4)).toEqual(['content', 'write', '--path', 'QA Evidence/native "after".json']);
    expect(tokens[4]).toBe('--content');
    expect(tokens[5]).toMatch(/^<omitted \d+\.\d MB sha256:[0-9a-f]{12}>$/);
    expect(tokens[6]).toBe('--overwrite');

    const compaction = (result.metadata as { compaction: { omitted: Array<Record<string, unknown>>; originalBytes: number } }).compaction;
    expect(compaction.originalBytes).toBe(utf8ByteLength(JSON.stringify(metadata)));
    expect(compaction.omitted).toEqual([
      expect.objectContaining({
        path: 'input.arguments.tool#0:--content',
        bytes: utf8ByteLength(payload),
        hash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/)
      })
    ]);
  });

  it('records the hash of the exact payload bytes, so it can be matched to a file version', async () => {
    const payload = awkwardPayload(10_000);
    const result = await compactTraceMetadata(useToolsTrace(cliCommand(['content', 'write', '--path', 'a.md', '--content', payload])));
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload));
    const hex = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
    const omitted = (result.metadata as { compaction: { omitted: Array<{ hash: string }> } }).compaction.omitted;
    expect(omitted[0].hash).toBe(`sha256:${hex}`);
  });

  it('handles an unquoted payload (base64 is a bare token) and keeps other segments byte-for-byte', async () => {
    const base64 = 'QUJD'.repeat(5000);
    const first = cliCommand(['content', 'read', '--path', 'Notes/keep me.md']);
    const second = cliCommand(['content', 'write', '--path', 'img.b64', '--content', base64]);
    const result = await compactTraceMetadata(useToolsTrace(`${first}, ${second}`));

    const compactedTool = (result.metadata as { input: { arguments: { tool: string } } }).input.arguments.tool;
    const segments = splitTopLevelSegments(compactedTool);
    expect(segments).toHaveLength(2);
    expect(segments[0]).toBe(first);
    expect(tokenize(segments[1]).slice(0, 5)).toEqual(['content', 'write', '--path', 'img.b64', '--content']);
    expect(tokenize(segments[1])[5]).toMatch(/^<omitted /);
  });

  it('keeps a quoted value that looks like a flag quoted', async () => {
    const tool = `content write --path "a.md" --content "--not-a-flag" --note ${cliQuote(awkwardPayload(5000))}`;
    const result = await compactTraceMetadata(useToolsTrace(tool));
    const compactedTool = (result.metadata as { input: { arguments: { tool: string } } }).input.arguments.tool;
    expect(compactedTool).toContain('--content "--not-a-flag"');
  });

  it('keeps the verb when a segment cannot be tokenized', async () => {
    const broken = `content write --path a.md --content "${'x'.repeat(5000)}`; // unclosed quote
    const result = await compactTraceMetadata(useToolsTrace(broken));
    const compactedTool = (result.metadata as { input: { arguments: { tool: string } } }).input.arguments.tool;
    expect(tokenize(compactedTool).slice(0, 2)).toEqual(['content', 'write']);
  });

  it('drops large legacy results to a descriptor', async () => {
    const result = await compactTraceMetadata({
      schemaVersion: 1,
      tool: { id: 'memoryManager_loadWorkspace', agent: 'memoryManager', mode: 'loadWorkspace' },
      context: { workspaceId: 'ws-1', sessionId: 's-1' },
      outcome: { success: true },
      legacy: { params: { id: 'ws-1' }, result: { data: { workspace: { sessions: { a: 'x'.repeat(1500), b: 'y'.repeat(1500) } } } } }
    });
    const metadata = result.metadata as { legacy: { result: unknown; params: unknown } };
    expect(metadata.legacy.result).toMatch(/^<omitted /);
    expect(metadata.legacy.params).toEqual({ id: 'ws-1' });
  });

  it('brings a deeply nested legacy dump made of small strings under budget', async () => {
    // Shape of the real 59 MB record: thousands of small strings, none of them over the value limit.
    const sessions: Record<string, unknown> = {};
    for (let index = 0; index < 400; index += 1) {
      sessions[`s-${index}`] = { memoryTraces: { [`t-${index}`]: { content: 'small trace '.repeat(40), metadata: { n: index } } } };
    }
    const result = await compactTraceMetadata({
      schemaVersion: 1,
      tool: { id: 'memoryManager_loadWorkspace', agent: 'memoryManager', mode: 'loadWorkspace' },
      context: { workspaceId: 'ws-1', sessionId: 's-1', memory: 'm', goal: 'g' },
      outcome: { success: true },
      response: { workspace: { sessions } }
    });
    expect(utf8ByteLength(result.json)).toBeLessThanOrEqual(MAX_TRACE_METADATA_BYTES);
    const metadata = result.metadata as { tool: unknown; context: { memory: string } };
    expect(metadata.tool).toEqual({ id: 'memoryManager_loadWorkspace', agent: 'memoryManager', mode: 'loadWorkspace' });
    expect(metadata.context.memory).toBe('m');
  });

  it('keeps as much as possible when trimming to budget', async () => {
    // Twelve 1.9 KB strings (each under the value limit) blow the 16 KB budget.
    // Only enough of them should go; input.files must survive.
    const notes: Record<string, string> = {};
    for (let index = 0; index < 12; index += 1) notes[`n${index}`] = `${index}`.repeat(1900);
    const result = await compactTraceMetadata({
      schemaVersion: 1,
      tool: { id: 'x_y', agent: 'x', mode: 'y' },
      context: { workspaceId: 'ws', sessionId: 's' },
      input: { files: ['a.md', 'b.md'], notes },
      outcome: { success: true }
    });
    const metadata = result.metadata as { input: { files: string[]; notes: Record<string, string> } };
    expect(utf8ByteLength(result.json)).toBeLessThanOrEqual(MAX_TRACE_METADATA_BYTES);
    expect(metadata.input.files).toEqual(['a.md', 'b.md']);
    const kept = Object.values(metadata.input.notes).filter(value => !value.startsWith('<omitted'));
    expect(kept.length).toBeGreaterThan(0);
  });

  it('agrees with the real tokenizer on every token it keeps', async () => {
    const big = awkwardPayload(8000);
    const commands = [
      cliCommand(['content', 'write', '--path', 'a b/c.md', '--content', big]),
      `${cliCommand(['content', 'read', '--path', 'x.md'])}, ${cliCommand(['content', 'replace', '--path', 'y.md', '--old', 'short', '--new', big])}`,
      `content write --path 'single quoted.md' --content ${cliQuote(big)} --tags a,b,c`,
      `task update --id t1 --note ${cliQuote('it\'s "fine" \\ ok')} --metadata ${cliQuote(big)}`,
      // A bare token with a backslash-escaped space.
      String.raw`content write --path esc\ aped.md --content ` + cliQuote(big),
      // Values ending in a backslash: the closing quote follows an escaped backslash.
      cliCommand(['content', 'write', '--path', 'C:\\dir\\', '--content', big, '--note', 'tail\\']),
      // Escapes JSON reads differently (\b, \f, \') force the exact unescape path.
      String.raw`content write --path b.md --content "` + 'x\\b\\f\\\'y '.repeat(800) + '"',
      // A quoted payload that itself ends in an escaped quote.
      cliCommand(['content', 'write', '--path', 'q.md', '--content', `${big}"`, '--after', 'x'])
    ];
    for (const command of commands) {
      const result = await compactTraceMetadata(useToolsTrace(command));
      const compacted = (result.metadata as { input: { arguments: { tool: string } } }).input.arguments.tool;
      const before = splitTopLevelSegments(command).map(segment => tokenize(segment));
      const after = splitTopLevelSegments(compacted).map(segment => tokenize(segment));
      expect(after.map(tokens => tokens.length)).toEqual(before.map(tokens => tokens.length));
      const omittedHashes = (result.metadata as { compaction: { omitted: Array<{ hash: string; bytes: number }> } })
        .compaction.omitted.map(entry => `${entry.hash}/${entry.bytes}`);
      const expectedHashes: string[] = [];
      for (const [segmentIndex, tokens] of before.entries()) {
        for (const [tokenIndex, token] of tokens.entries()) {
          const kept = after[segmentIndex][tokenIndex];
          if (utf8ByteLength(token) > 4096) {
            expect(kept).toMatch(/^<omitted [\d.]+ KB sha256:[0-9a-f]{12}>$/);
            // The recorded hash is of the value the tool received, i.e. what the real tokenizer yields.
            expectedHashes.push(`${await sha256Hex(token)}/${utf8ByteLength(token)}`);
          } else {
            expect(kept).toBe(token);
          }
        }
      }
      expect(omittedHashes).toEqual(expectedHashes);
    }
  });

  it('is deterministic: identical input gives identical bytes', async () => {
    const build = () => useToolsTrace(cliCommand(['content', 'write', '--path', 'a.md', '--content', awkwardPayload(50_000)]));
    const [a, b] = await Promise.all([compactTraceMetadata(build()), compactTraceMetadata(build())]);
    expect(a.json).toBe(b.json);
  });
});

describe('compactTraceMetadataJson', () => {
  it('returns small JSON without parsing it', async () => {
    const parse = jest.spyOn(JSON, 'parse');
    const json = JSON.stringify(useToolsTrace('content read --path a.md'));
    await expect(compactTraceMetadataJson(json)).resolves.toBe(json);
    expect(parse).not.toHaveBeenCalled();
    parse.mockRestore();
  });

  it('compacts serialized metadata and passes through null', async () => {
    const json = JSON.stringify(useToolsTrace(cliCommand(['content', 'write', '--path', 'a.md', '--content', awkwardPayload(100_000)])));
    const compacted = await compactTraceMetadataJson(json);
    expect(utf8ByteLength(compacted as string)).toBeLessThan(MAX_TRACE_METADATA_BYTES);
    await expect(compactTraceMetadataJson(null)).resolves.toBeNull();
  });

  it('reduces a record over the parse ceiling to a stub without parsing it', async () => {
    const json = JSON.stringify(useToolsTrace(cliCommand(['content', 'write', '--path', 'a.md', '--content', awkwardPayload(300_000)])));
    const parse = jest.spyOn(JSON, 'parse');
    const compacted = await compactTraceMetadataJson(json, { maxParseBytes: 100_000 });
    expect(parse).not.toHaveBeenCalled();
    parse.mockRestore();
    const stub = JSON.parse(compacted as string) as { compaction: { originalBytes: number } };
    expect(stub.compaction.originalBytes).toBe(utf8ByteLength(json));
  });
});
