/**
 * tests/unit/ToolManagerCliSyntax.test.ts — CLI parser regression pins for
 * `ToolCliNormalizer`. Two layers:
 *
 * 1. **End-to-end stack tests** — exercise `getTools`/`useTools` through a
 *    real `HeadlessAgentStack` (slow; asserts the full discovery/write path).
 * 2. **Direct parser tests** — construct `ToolCliNormalizer` against a
 *    lightweight stub agent registry and hit `normalizeDiscoveryRequests` /
 *    `normalizeExecutionCalls` / `buildCliSchema` directly. Fast; exhaustive
 *    coverage of throw sites, value coercions, and edge tokens.
 *
 * These are characterization tests: they capture current parser behavior so
 * future refactors surface unintended changes. If a test reveals what looks
 * like a bug, leave the assertion as-is (or mark with `it.skip` + comment)
 * and flag it upstream — do not silently "fix" the parser here.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHeadlessAgentStack, HeadlessAgentStackResult } from '../eval/headless/HeadlessAgentStack';
import { TestVaultManager } from '../eval/headless/TestVaultManager';
import { ToolCliNormalizer, parseCliForDisplay, tokenizeWithMeta } from '../../src/agents/toolManager/services/ToolCliNormalizer';
import type { IAgent } from '../../src/agents/interfaces/IAgent';
import type { ITool } from '../../src/agents/interfaces/ITool';

const TEST_CONTEXT = {
  workspaceId: 'test-ws',
  sessionId: 'test-session',
  memory: 'CLI syntax regression test session.',
  goal: 'Verify ToolManager CLI discovery and execution.',
};

describe('ToolManager CLI syntax', () => {
  let stack: HeadlessAgentStackResult;
  let vaultManager: TestVaultManager;
  let testDir: string;

  beforeAll(async () => {
    testDir = path.join(os.tmpdir(), `nexus-cli-syntax-${Date.now()}`);
    vaultManager = new TestVaultManager(testDir);
    vaultManager.reset();
    vaultManager.seed({
      'notes/source.md': '# Source\n\nInitial body.',
    });

    stack = await createHeadlessAgentStack({
      basePath: testDir,
      vaultName: 'cli-syntax-vault',
    });
  }, 30000);

  afterAll(() => {
    vaultManager.cleanup();
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('returns CLI metadata for a specific selector', async () => {
    const result = await stack.getTools({
      ...TEST_CONTEXT,
      tool: 'content read',
    });

    expect(result.success).toBe(true);
    expect(result.data?.tools).toHaveLength(1);
    expect(result.data?.tools[0]).toMatchObject({
      agent: 'contentManager',
      tool: 'read',
      command: 'content read',
    });
    expect(result.data?.tools[0].usage).toContain('content read');
  });

  it('supports comma-separated multi-discovery', async () => {
    const result = await stack.getTools({
      ...TEST_CONTEXT,
      tool: 'content read, storage list',
    });

    expect(result.success).toBe(true);
    const identifiers = (result.data?.tools || []).map(tool => `${tool.agent}_${tool.tool}`);
    expect(identifiers).toContain('contentManager_read');
    expect(identifiers).toContain('storageManager_list');
  });

  it('writes newline-preserving content via CLI command string', async () => {
    const result = await stack.useTools({
      ...TEST_CONTEXT,
      tool: 'content write "notes/generated.md" "# Title\\n\\n- Item 1\\n- Item 2"',
    });

    expect(result.success).toBe(true);
    const written = fs.readFileSync(path.join(testDir, 'notes/generated.md'), 'utf-8');
    expect(written).toBe('# Title\n\n- Item 1\n- Item 2');
  });

  it('decodes escaped unicode sequences in quoted CLI content', async () => {
    const result = await stack.useTools({
      ...TEST_CONTEXT,
      tool: 'content write "notes/unicode.md" "dash \\u2014 multiply \\u00D7"',
    });

    expect(result.success).toBe(true);
    const written = fs.readFileSync(path.join(testDir, 'notes/unicode.md'), 'utf-8');
    expect(written).toBe('dash — multiply ×');
  });

  it('rejects deprecated structured calls payloads', async () => {
    await expect(stack.useTools({
      ...TEST_CONTEXT,
      calls: [
        {
          agent: 'contentManager',
          tool: 'write',
          params: {
            path: 'notes/structured.md',
            content: 'Structured body',
          },
        },
      ],
    } as unknown as Parameters<typeof stack.useTools>[0])).rejects.toThrow(/no longer accepts "calls"/i);
  });
});

// ---------------------------------------------------------------------------
// Direct parser tests — `ToolCliNormalizer` against a stub IAgent registry.
// No headless stack; every case runs in microseconds. These pin every throw
// site and every value-coercion branch in the parser.
// ---------------------------------------------------------------------------

type SchemaShape = Record<string, unknown>;

function makeStubTool(slug: string, schema: SchemaShape, description = `${slug} description`): ITool {
  const tool: Partial<ITool> & { slug: string } = {
    slug,
    name: slug,
    description,
    version: '1.0.0',
    execute: async () => ({}),
    getParameterSchema: () => schema as never,
    getResultSchema: () => ({ type: 'object' } as never),
  };
  return tool as ITool;
}

function makeStubAgent(name: string, tools: ITool[]): IAgent {
  const toolMap = new Map(tools.map(t => [t.slug, t]));
  const agent: Partial<IAgent> & { name: string } = {
    name,
    description: `${name} description`,
    version: '1.0.0',
    getTools: () => [...tools],
    getTool: (slug: string) => toolMap.get(slug),
    initialize: async () => { /* no-op */ },
    executeTool: async () => ({}),
    setAgentManager: () => { /* no-op */ },
  };
  return agent as IAgent;
}

function buildStubRegistry(): Map<string, IAgent> {
  // contentManager → read(path: string, required), write(path: string, required; content: string, required)
  const contentAgent = makeStubAgent('contentManager', [
    makeStubTool('read', {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Note path' },
      },
      required: ['path'],
    }),
    makeStubTool('write', {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['path', 'content'],
    }),
  ]);

  // storageManager → list(path: string, optional), move(from: string, to: string, required), archive(paths: array<string>, required; permanent: boolean, optional)
  const storageAgent = makeStubAgent('storageManager', [
    makeStubTool('list', {
      type: 'object',
      properties: {
        path: { type: 'string' },
      },
      required: [],
    }),
    makeStubTool('move', {
      type: 'object',
      properties: {
        from: { type: 'string' },
        to: { type: 'string' },
      },
      required: ['from', 'to'],
    }),
    makeStubTool('archive', {
      type: 'object',
      properties: {
        paths: { type: 'array', items: { type: 'string' } },
        permanent: { type: 'boolean' },
      },
      required: ['paths'],
    }),
  ]);

  // numericAgent → convert(count: integer/number, factor: number, enabled: boolean, tags: array<string>, config: object)
  // Used to cover every coerceValue branch. `pages: array<integer>`,
  // `weights: array<number>`, and `objects: array<object>` were added for the
  // EC-3 typed-array coverage; they are optional so they only bind when the
  // test explicitly passes the flag.
  const coerceAgent = makeStubAgent('numericAgent', [
    makeStubTool('convert', {
      type: 'object',
      properties: {
        count: { type: 'integer' },
        factor: { type: 'number' },
        enabled: { type: 'boolean' },
        tags: { type: 'array', items: { type: 'string' } },
        pages: { type: 'array', items: { type: 'integer' } },
        weights: { type: 'array', items: { type: 'number' } },
        objects: { type: 'array', items: { type: 'object' } },
        config: { type: 'object' },
        label: { type: 'string' },
      },
      required: [],
    }),
  ]);

  // oneOfAgent → setProp(value: oneOf[string|number|boolean|array<string>], required)
  // Mirrors the real `contentManager.setProperty.value` schema so the CLI
  // coercion path for issue #172 is exercised end-to-end through
  // `normalizeExecutionCalls` without depending on the full ContentManager
  // agent. Alias is `one-of` (see `toKebabCase`).
  const oneOfAgent = makeStubAgent('oneOfAgent', [
    makeStubTool('setProp', {
      type: 'object',
      properties: {
        value: {
          oneOf: [
            { type: 'string' },
            { type: 'number' },
            { type: 'boolean' },
            { type: 'array', items: { type: 'string' } },
          ],
          description: 'Value to set (scalar or array of strings)',
        },
      },
      required: ['value'],
    }),
  ]);

  return new Map<string, IAgent>([
    ['contentManager', contentAgent],
    ['storageManager', storageAgent],
    ['numericAgent', coerceAgent],
    ['oneOfAgent', oneOfAgent],
    ['toolManager', makeStubAgent('toolManager', [])], // excluded from --help
  ]);
}

function makeNormalizer(): ToolCliNormalizer {
  return new ToolCliNormalizer(buildStubRegistry());
}

function captureError(fn: () => unknown): Error {
  try {
    fn();
  } catch (err) {
    if (err instanceof Error) return err;
    throw new Error(`Non-Error thrown: ${String(err)}`);
  }
  throw new Error('Expected function to throw');
}

describe('ToolCliNormalizer — direct parser coverage', () => {
  // -------------------------------------------------------------------------
  // Discovery (getTools) — throw sites + branches
  // -------------------------------------------------------------------------

  describe('normalizeDiscoveryRequests', () => {
    it('throws when tool selector is missing/empty', () => {
      const err = captureError(() => makeNormalizer().normalizeDiscoveryRequests({}));
      expect(err.message).toMatch(/tool is required/);
    });

    it('throws when tool selector is whitespace-only', () => {
      const err = captureError(() => makeNormalizer().normalizeDiscoveryRequests({ tool: '   ' }));
      expect(err.message).toMatch(/tool is required/);
    });

    it('"--help" expands to all agents except toolManager', () => {
      const result = makeNormalizer().normalizeDiscoveryRequests({ tool: '--help' });
      const agents = result.map(r => r.agent).sort();
      expect(agents).toEqual(['contentManager', 'numericAgent', 'oneOfAgent', 'storageManager']);
    });

    it('throws on unknown agent token', () => {
      const err = captureError(() => makeNormalizer().normalizeDiscoveryRequests({ tool: 'ghost' }));
      expect(err.message).toMatch(/Unknown agent "ghost"/);
    });

    it('throws on unknown tool for a known agent', () => {
      const err = captureError(() => makeNormalizer().normalizeDiscoveryRequests({ tool: 'content bogusTool' }));
      expect(err.message).toMatch(/Unknown tool "bogusTool" for agent "content"/);
    });

    it('throws on segment with more than two tokens', () => {
      const err = captureError(() => makeNormalizer().normalizeDiscoveryRequests({ tool: 'content read extra' }));
      expect(err.message).toMatch(/Invalid selector "content read extra"/);
    });

    it('fails fast on mixed valid+invalid segments in a comma batch', () => {
      // First segment is valid; second segment has an unknown agent.
      // Parser walks segments in order via `.map()`, so the first throw
      // propagates — there is no multi-error aggregation.
      const err = captureError(() =>
        makeNormalizer().normalizeDiscoveryRequests({ tool: 'content read, ghost' })
      );
      expect(err.message).toMatch(/Unknown agent "ghost"/);
    });

    it('resolves agent via trimmed alias and camelCase, but NOT via kebab-cased full name', () => {
      // Characterization (see review M1): `toKebabCase` strips a trailing
      // "Manager"/"Agent" suffix, so `contentManager` resolves via both
      // `content` (alias) and `contentManager` (identity). But passing the
      // explicit kebab form `content-manager` produces `content-` after
      // suffix strip, which matches no alias — current parser rejects it.
      // Pinning the behavior here so future refactors surface any change.
      const normalizer = makeNormalizer();
      expect(normalizer.normalizeDiscoveryRequests({ tool: 'content' })[0].agent).toBe('contentManager');
      expect(normalizer.normalizeDiscoveryRequests({ tool: 'contentManager' })[0].agent).toBe('contentManager');
      expect(() => normalizer.normalizeDiscoveryRequests({ tool: 'content-manager' }))
        .toThrow(/Unknown agent "content-manager"/);
    });

    it('rejects deprecated request-array discovery payloads', () => {
      const err = captureError(() =>
        makeNormalizer().normalizeDiscoveryRequests({
          request: [{ agent: 'storageManager', tools: ['list'] }],
        } as unknown as Parameters<ToolCliNormalizer['normalizeDiscoveryRequests']>[0])
      );
      expect(err.message).toMatch(/no longer accepts "request"/i);
    });
  });

  // -------------------------------------------------------------------------
  // Execution (useTools) — throw sites
  // -------------------------------------------------------------------------

  describe('normalizeExecutionCalls — throw sites', () => {
    it('rejects deprecated structured calls payloads', () => {
      const err = captureError(() =>
        makeNormalizer().normalizeExecutionCalls({
          calls: [
            {
              agent: 'contentManager',
              tool: 'read',
              params: { path: 'notes/test.md' },
            },
          ],
        } as unknown as Parameters<ToolCliNormalizer['normalizeExecutionCalls']>[0])
      );
      expect(err.message).toMatch(/no longer accepts "calls"/i);
    });

    it('throws when tool command is missing/empty', () => {
      const err = captureError(() => makeNormalizer().normalizeExecutionCalls({}));
      expect(err.message).toMatch(/tool is required/);
    });

    it('throws when a command has only an agent (missing tool name)', () => {
      const err = captureError(() => makeNormalizer().normalizeExecutionCalls({ tool: 'content' }));
      expect(err.message).toMatch(/Invalid command "content"/);
    });

    it('rejects a context flag placed inside the tool string', () => {
      const err = captureError(() =>
        makeNormalizer().normalizeExecutionCalls({ tool: 'content read --workspace-id abc --path foo.md' })
      );
      expect(err.message).toMatch(/Do not include --workspace-id inside "tool"/);
    });

    it('rejects every CONTEXT_FLAG_NAME variant placed inside the tool string', () => {
      const normalizer = makeNormalizer();
      const contextFlags = [
        'workspace-id', 'session-id', 'memory', 'goal', 'constraints',
        'image-provider', 'image-model', 'transcription-provider', 'transcription-model',
      ];
      for (const flag of contextFlags) {
        const err = captureError(() =>
          normalizer.normalizeExecutionCalls({ tool: `content read --${flag} x --path foo.md` })
        );
        expect(err.message).toMatch(new RegExp(`Do not include --${flag} inside "tool"`));
      }
    });

    it('throws on an unknown flag', () => {
      const err = captureError(() =>
        makeNormalizer().normalizeExecutionCalls({ tool: 'content read --bogus 1 --path foo.md' })
      );
      expect(err.message).toMatch(/Unknown flag "--bogus" for contentManager\.read/);
    });

    it('throws on an unknown --no-<flag> negation', () => {
      const err = captureError(() =>
        makeNormalizer().normalizeExecutionCalls({ tool: 'content read --no-bogus --path foo.md' })
      );
      expect(err.message).toMatch(/Unknown flag "--no-bogus" for contentManager\.read/);
    });

    it('throws when a flag requires a value but EOF arrives first', () => {
      const err = captureError(() =>
        makeNormalizer().normalizeExecutionCalls({ tool: 'content read --path' })
      );
      expect(err.message).toMatch(/Flag "--path" requires a value/);
    });

    it('throws on too many positional arguments', () => {
      const err = captureError(() =>
        makeNormalizer().normalizeExecutionCalls({ tool: 'content read foo.md extra-positional' })
      );
      expect(err.message).toMatch(/Too many positional arguments for contentManager\.read/);
    });

    it('throws when a required argument is missing', () => {
      const err = captureError(() =>
        makeNormalizer().normalizeExecutionCalls({ tool: 'content read' })
      );
      expect(err.message).toMatch(/Missing required argument "path" for contentManager\.read/);
    });

    it('surfaces unknown-tool errors via parseCommandSegment path', () => {
      const err = captureError(() =>
        makeNormalizer().normalizeExecutionCalls({ tool: 'content ghostTool' })
      );
      expect(err.message).toMatch(/Unknown tool "ghostTool" for agent "content"/);
    });
  });

  // -------------------------------------------------------------------------
  // Value coercion — coerceValue branches
  // -------------------------------------------------------------------------

  describe('normalizeExecutionCalls — value coercion', () => {
    it('coerces integer values via --flag number syntax', () => {
      const [call] = makeNormalizer().normalizeExecutionCalls({
        tool: 'numeric convert --count 42',
      });
      expect(call.params.count).toBe(42);
    });

    it('coerces float values via --flag number syntax', () => {
      const [call] = makeNormalizer().normalizeExecutionCalls({
        tool: 'numeric convert --factor 1.5',
      });
      expect(call.params.factor).toBe(1.5);
    });

    it('falls through to raw string when number coercion yields NaN', () => {
      const [call] = makeNormalizer().normalizeExecutionCalls({
        tool: 'numeric convert --count not-a-number',
      });
      expect(call.params.count).toBe('not-a-number');
    });

    it('coerces boolean flags (bare) to true', () => {
      const [call] = makeNormalizer().normalizeExecutionCalls({
        tool: 'numeric convert --enabled',
      });
      expect(call.params.enabled).toBe(true);
    });

    it('coerces --no-<flag> to false', () => {
      const [call] = makeNormalizer().normalizeExecutionCalls({
        tool: 'numeric convert --no-enabled',
      });
      expect(call.params.enabled).toBe(false);
    });

    it('coerces array<string> via comma-separated value', () => {
      const [call] = makeNormalizer().normalizeExecutionCalls({
        tool: 'numeric convert --tags "alpha,beta,gamma"',
      });
      expect(call.params.tags).toEqual(['alpha', 'beta', 'gamma']);
    });

    it('trims whitespace around array<string> items and drops empty entries', () => {
      const [call] = makeNormalizer().normalizeExecutionCalls({
        tool: 'numeric convert --tags " one , , two "',
      });
      expect(call.params.tags).toEqual(['one', 'two']);
    });

    it('coerces object value via JSON.parse', () => {
      const [call] = makeNormalizer().normalizeExecutionCalls({
        tool: 'numeric convert --config \'{"key":"value"}\'',
      });
      expect(call.params.config).toEqual({ key: 'value' });
    });

    it('falls through to raw string when object JSON.parse fails', () => {
      const [call] = makeNormalizer().normalizeExecutionCalls({
        tool: 'numeric convert --config not-json',
      });
      expect(call.params.config).toBe('not-json');
    });

    it('keeps plain string values unchanged', () => {
      const [call] = makeNormalizer().normalizeExecutionCalls({
        tool: 'numeric convert --label hello',
      });
      expect(call.params.label).toBe('hello');
    });
  });

  // -------------------------------------------------------------------------
  // array<string> JSON syntax — Bug #2 fix
  // -------------------------------------------------------------------------
  // Previous behavior: `array<string>` values were always split on `,`, so
  // items containing literal commas could not be expressed. Fix accepts a
  // JSON-array prefix (`[...]`) of strings and falls back to CSV split
  // otherwise — strictly additive, zero breakage for the old syntax.

  describe('normalizeExecutionCalls — array<string> JSON syntax (Bug #2)', () => {
    it('parses JSON array and preserves literal commas inside items', () => {
      const [call] = makeNormalizer().normalizeExecutionCalls({
        tool: 'numeric convert --tags \'["alpha, with comma","beta"]\'',
      });
      expect(call.params.tags).toEqual(['alpha, with comma', 'beta']);
    });

    it('falls back to CSV split when JSON parse fails', () => {
      const [call] = makeNormalizer().normalizeExecutionCalls({
        tool: 'numeric convert --tags "[broken"',
      });
      expect(call.params.tags).toEqual(['[broken']);
    });

    it('falls back to CSV split on multi-item malformed JSON and preserves all items', () => {
      // `[a,b,c]` wraps with [] so the JSON-parse branch IS attempted, then
      // throws (unquoted identifiers). The catch falls through to
      // splitCsvRespectingQuotes, which splits on top-level commas. This is
      // the real proof that the fallback preserves every item, not just the
      // single-token case above.
      const [call] = makeNormalizer().normalizeExecutionCalls({
        tool: 'numeric convert --tags "[a,b,c]"',
      });
      expect(call.params.tags).toEqual(['[a', 'b', 'c]']);
    });

    it('non-wrapped multi-item raw input skips JSON branch and CSV-splits', () => {
      // No bracket wrapping, so the JSON-parse branch is never entered. This
      // exercises the non-JSON path of the array<string> coercer with a
      // multi-item input, complementing the malformed-JSON fallback above.
      const [call] = makeNormalizer().normalizeExecutionCalls({
        tool: 'numeric convert --tags "alpha,beta,gamma"',
      });
      expect(call.params.tags).toEqual(['alpha', 'beta', 'gamma']);
    });

    it('preserves existing CSV syntax (no regression)', () => {
      const [call] = makeNormalizer().normalizeExecutionCalls({
        tool: 'numeric convert --tags "a,b,c"',
      });
      expect(call.params.tags).toEqual(['a', 'b', 'c']);
    });

    it('empty JSON array yields empty array', () => {
      const [call] = makeNormalizer().normalizeExecutionCalls({
        tool: 'numeric convert --tags "[]"',
      });
      expect(call.params.tags).toEqual([]);
    });

    it('single-item JSON array with unicode is preserved', () => {
      const [call] = makeNormalizer().normalizeExecutionCalls({
        tool: 'numeric convert --tags \'["só um"]\'',
      });
      expect(call.params.tags).toEqual(['só um']);
    });
  });

  // -------------------------------------------------------------------------
  // Issue #172: `oneOf: [string|number|boolean, array<string>]` slot.
  // Previously `getSchemaType` had no branch for `oneOf`, so the type marker
  // fell through to `'unknown'` and `coerceValue` returned `raw` verbatim.
  // A multi-item CSV like `"a,b,c"` reached the tool as the literal string
  // `"a,b,c"` and corrupted the frontmatter. Fix: detect oneOf-with-array,
  // return marker `oneOfArray`, and branch in coerceValue on JSON array
  // literal vs CSV split vs single-item scalar.
  // -------------------------------------------------------------------------

  describe('normalizeExecutionCalls — oneOf array|scalar coercion (Issue #172)', () => {
    it('single segment preserves raw scalar string (no array wrap)', () => {
      const [call] = makeNormalizer().normalizeExecutionCalls({
        tool: 'one-of set-prop "single-tag"',
      });
      expect(call.params.value).toBe('single-tag');
    });

    it('CSV multi-segment coerces to string[] (fix target for #172)', () => {
      const [call] = makeNormalizer().normalizeExecutionCalls({
        tool: 'one-of set-prop "a,b,c"',
      });
      expect(call.params.value).toEqual(['a', 'b', 'c']);
    });

    it('JSON array literal coerces to string[]', () => {
      const [call] = makeNormalizer().normalizeExecutionCalls({
        tool: 'one-of set-prop \'["alpha","beta","gamma"]\'',
      });
      expect(call.params.value).toEqual(['alpha', 'beta', 'gamma']);
    });

    it('outer-quoted item with internal comma collapses to scalar', () => {
      // Shell tokenizer strips the outer single quotes, leaving
      // `"multi, comma"`. splitCsvRespectingQuotes then honors the inner
      // double quotes and yields a single item, so the oneOfArray branch
      // collapses to a scalar string (precedent: #163 splitCsvRespectingQuotes).
      const [call] = makeNormalizer().normalizeExecutionCalls({
        tool: 'one-of set-prop \'"multi, comma"\'',
      });
      expect(call.params.value).toBe('multi, comma');
    });

    it('empty JSON array literal yields empty array', () => {
      const [call] = makeNormalizer().normalizeExecutionCalls({
        tool: 'one-of set-prop "[]"',
      });
      expect(call.params.value).toEqual([]);
    });

    it('JSON array with non-string items preserves parsed types', () => {
      // oneOf allows number/boolean/string scalars in its non-array arms.
      // When the caller explicitly writes a JSON array, we honor the parsed
      // types verbatim — downstream schema validation decides whether the
      // mix is acceptable for a given slot. This is a characterization pin:
      // no per-item coercion is applied to the array branch.
      const [call] = makeNormalizer().normalizeExecutionCalls({
        tool: 'one-of set-prop "[1,2,3]"',
      });
      expect(call.params.value).toEqual([1, 2, 3]);
    });

    it('empty-string value preserved as empty scalar (not dropped, not empty array)', () => {
      // `splitCsvRespectingQuotes("")` returns `[]`, which the oneOfArray
      // branch treats as the empty-length fall-through: return raw. This
      // avoids silently coercing a missing value to `[]` (which would
      // masquerade as a successful write).
      const [call] = makeNormalizer().normalizeExecutionCalls({
        tool: 'one-of set-prop ""',
      });
      expect(call.params.value).toBe('');
    });

    it('whitespace-only value preserved as raw scalar', () => {
      // Trimmed items drop; zero items means no CSV match, so we return the
      // raw whitespace unchanged. Parity with the EC-4 rule for numeric
      // slots (whitespace-only is not silently coerced to 0/empty-array).
      const [call] = makeNormalizer().normalizeExecutionCalls({
        tool: 'one-of set-prop "   "',
      });
      expect(call.params.value).toBe('   ');
    });

    it('bracket-wrapped malformed JSON falls through to CSV split', () => {
      // `[a,b,c]` wraps in brackets so the JSON branch is attempted, fails
      // on unquoted identifiers, and falls through to splitCsvRespectingQuotes.
      // Outer brackets stay attached to the first/last items. Matches the
      // array<string> branch's fallback behavior (see Bug #2 characterization).
      const [call] = makeNormalizer().normalizeExecutionCalls({
        tool: 'one-of set-prop "[a,b,c]"',
      });
      expect(call.params.value).toEqual(['[a', 'b', 'c]']);
    });

    it('bracket-prefix-only (no closing bracket) skips JSON and splits as CSV', () => {
      // Starts with `[` but doesn't end with `]` → the JSON branch's
      // startsWith/endsWith gate is not satisfied, so JSON.parse is never
      // attempted. The single-item CSV result collapses to scalar.
      const [call] = makeNormalizer().normalizeExecutionCalls({
        tool: 'one-of set-prop "[broken"',
      });
      expect(call.params.value).toBe('[broken');
    });

    it('numeric-looking scalar stays a string (parser does not second-guess oneOf branch)', () => {
      // oneOf includes {type: 'number'}, but the CLI parser has no way to
      // know which branch the caller intended. Single-item CSV result is
      // returned as a string; downstream schema validation (or the receiving
      // tool) handles type coercion if it wants. Pinned to prevent a well-
      // meaning "smart" coercion from sneaking in later and changing
      // behavior for existing callers that expect strings.
      const [call] = makeNormalizer().normalizeExecutionCalls({
        tool: 'one-of set-prop "42"',
      });
      expect(call.params.value).toBe('42');
    });
  });

  // -------------------------------------------------------------------------
  // Edge cases — quoting, escapes, multi-command
  // -------------------------------------------------------------------------

  describe('normalizeExecutionCalls — edge cases', () => {
    it('preserves empty quoted tokens — bare "" emits empty string', () => {
      // After the D.2 fix in tokenize(), a bare `""` emits an empty-string
      // token instead of being silently dropped. `content write "" "body"`
      // becomes tokens `['content','write','','body']` — path='' fills slot 0,
      // content='body' fills slot 1, both required args set.
      const [call] = makeNormalizer().normalizeExecutionCalls({
        tool: 'content write "" "body"',
      });
      expect(call.params.path).toBe('');
      expect(call.params.content).toBe('body');
    });

    it('accepts single-quoted tokens equivalently to double-quoted tokens', () => {
      const [call] = makeNormalizer().normalizeExecutionCalls({
        tool: "content write 'notes/x.md' 'hello'",
      });
      expect(call.params.path).toBe('notes/x.md');
      expect(call.params.content).toBe('hello');
    });

    it('preserves commas inside quoted string values (no segment split)', () => {
      // Top-level comma-splitter should ignore commas inside quotes.
      const calls = makeNormalizer().normalizeExecutionCalls({
        tool: 'content write "notes/a.md" "one, two, three"',
      });
      expect(calls).toHaveLength(1);
      expect(calls[0].params.content).toBe('one, two, three');
    });

    it('unescapes \\n, \\t, \\r, \\" inside quoted values', () => {
      const [call] = makeNormalizer().normalizeExecutionCalls({
        tool: 'content write "x.md" "line1\\nline2\\tend\\r\\"quoted\\""',
      });
      expect(call.params.content).toBe('line1\nline2\tend\r"quoted"');
    });

    it('splits multi-command batches on top-level commas', () => {
      const calls = makeNormalizer().normalizeExecutionCalls({
        tool: 'content read "a.md", content read "b.md"',
      });
      expect(calls).toHaveLength(2);
      expect(calls[0]).toMatchObject({ agent: 'contentManager', tool: 'read', params: { path: 'a.md' } });
      expect(calls[1]).toMatchObject({ agent: 'contentManager', tool: 'read', params: { path: 'b.md' } });
    });

    it('fails fast on first invalid segment in a multi-command batch', () => {
      // Characterization: parser walks segments in order; first failure aborts.
      const err = captureError(() =>
        makeNormalizer().normalizeExecutionCalls({ tool: 'content read "a.md", ghost tool' })
      );
      expect(err.message).toMatch(/Unknown agent "ghost"/);
    });

    it('rejects deprecated structured calls payloads consistently', () => {
      const err = captureError(() =>
        makeNormalizer().normalizeExecutionCalls({
          calls: [{ agent: 'contentManager', tool: 'read', params: { path: 'x.md' } }],
        } as unknown as Parameters<ToolCliNormalizer['normalizeExecutionCalls']>[0])
      );
      expect(err.message).toMatch(/no longer accepts "calls"/i);
    });
  });

  // -------------------------------------------------------------------------
  // Quoted positional values that look like flags — Bug #1 regression pins
  // -------------------------------------------------------------------------
  //
  // Parser must not misclassify a *quoted* positional token whose text starts
  // with `--` (or `---`, `----`, etc.) as a CLI flag. Quoting carries intent:
  // quoted tokens stay positional regardless of leading characters. Regression
  // was accidentally reintroduced during the tokenize refactor that added
  // `hasToken` (D.2 fix) without preserving `wasQuoted` metadata.

  describe('normalizeExecutionCalls — positional values that look like flags', () => {
    it('accepts quoted positional starting with --- (YAML frontmatter)', () => {
      const [call] = makeNormalizer().normalizeExecutionCalls({
        tool: 'content write "notes/fm.md" "---\\nkey: value\\n---\\nbody"',
      });
      expect(call.params.path).toBe('notes/fm.md');
      expect(call.params.content).toBe('---\nkey: value\n---\nbody');
    });

    it('accepts quoted positional equal to --content (literal flag-looking text)', () => {
      const [call] = makeNormalizer().normalizeExecutionCalls({
        tool: 'content write "notes/weird.md" "--content"',
      });
      expect(call.params.path).toBe('notes/weird.md');
      expect(call.params.content).toBe('--content');
    });

    it('accepts quoted positional starting with -- that does not match any flag', () => {
      const [call] = makeNormalizer().normalizeExecutionCalls({
        tool: 'content write "notes/dash.md" "--no-such-flag"',
      });
      expect(call.params.content).toBe('--no-such-flag');
    });

    it('explicit named flags still work when value starts with --- (no regression)', () => {
      const [call] = makeNormalizer().normalizeExecutionCalls({
        tool: 'content write --path "notes/named.md" --content "---\\nheader"',
      });
      expect(call.params.path).toBe('notes/named.md');
      expect(call.params.content).toBe('---\nheader');
    });

    it('unquoted -- prefix still classifies as a flag (no regression)', () => {
      const err = captureError(() =>
        makeNormalizer().normalizeExecutionCalls({ tool: 'content read --bogus 1 --path foo.md' })
      );
      expect(err.message).toMatch(/Unknown flag "--bogus" for contentManager\.read/);
    });

    it('plain-content positional without -- prefix still succeeds (baseline)', () => {
      const [call] = makeNormalizer().normalizeExecutionCalls({
        tool: 'content write "notes/plain.md" "normal content"',
      });
      expect(call.params.content).toBe('normal content');
    });
  });

  // -------------------------------------------------------------------------
  // array<string> CSV split — quote-aware (issue #163)
  // -------------------------------------------------------------------------
  //
  // CSV fallback for array<string> values respects outer quote pairs as
  // item-internal literals. A comma inside "..." or '...' is preserved; only
  // commas outside any quoted region act as separators. Backward compatible
  // with bare CSV.

  describe('coerceValue — array<string> quote-aware CSV split', () => {
    it('bare CSV without quotes still splits on every comma (no regression)', () => {
      const [call] = makeNormalizer().normalizeExecutionCalls({
        tool: 'storage archive --paths "a,b,c"',
      });
      expect(call.params.paths).toEqual(['a', 'b', 'c']);
    });

    it('inner double quotes protect commas — issue #163 main repro', () => {
      const [call] = makeNormalizer().normalizeExecutionCalls({
        tool: 'storage archive --paths \'"a, b",c\'',
      });
      expect(call.params.paths).toEqual(['a, b', 'c']);
    });

    it('multiple quoted items each preserve their internal commas', () => {
      const [call] = makeNormalizer().normalizeExecutionCalls({
        tool: 'storage archive --paths \'"a,b","c,d"\'',
      });
      expect(call.params.paths).toEqual(['a,b', 'c,d']);
    });

    it('inner single quotes also protect commas', () => {
      const [call] = makeNormalizer().normalizeExecutionCalls({
        tool: "storage archive --paths \"'one, two',three\"",
      });
      expect(call.params.paths).toEqual(['one, two', 'three']);
    });

    it('JSON array path still works (existing behavior, no regression)', () => {
      const [call] = makeNormalizer().normalizeExecutionCalls({
        tool: 'storage archive --paths \'["a, b","c"]\'',
      });
      expect(call.params.paths).toEqual(['a, b', 'c']);
    });

    it('mixed quoted + unquoted items', () => {
      const [call] = makeNormalizer().normalizeExecutionCalls({
        tool: 'storage archive --paths \'plain,"with, comma",last\'',
      });
      expect(call.params.paths).toEqual(['plain', 'with, comma', 'last']);
    });

    it('empty items are filtered (preserves existing filter(Boolean) behavior)', () => {
      const [call] = makeNormalizer().normalizeExecutionCalls({
        tool: 'storage archive --paths "a,,b,"',
      });
      expect(call.params.paths).toEqual(['a', 'b']);
    });
  });
});

// ---------------------------------------------------------------------------
// CLI migration audit — 25 characterization cases (A.1–G.3).
// Each `it` asserts what the parser SHOULD do. All 25 cases currently pass:
//   CHAR (current behavior is correct):
//     A.1, A.2, A.3, B.1–B.5, C.1, C.4, C.5, C.6, D.1, D.3, E.1, E.2, E.3, F.1, G.3
//   Fixed in prior PRs (originally failing, now passing):
//     A.4 (unescape ordering), D.2 (empty-quote token emission),
//     C.2, C.3 (bool flag explicit value — fixed in 215a77a6),
//     G.1, G.2 (flag/positional conflict — fixed in 215a77a6)
// ---------------------------------------------------------------------------

describe('parser characterization — CLI migration audit', () => {
  // A — quoting & escapes
  it('A.1: nested double quotes preserve inner quotes', () => {
    const [call] = makeNormalizer().normalizeExecutionCalls({
      tool: 'content write "a.md" "say \\"hi\\""',
    });
    expect(call.params.content).toBe('say "hi"');
  });

  it('A.2: single-quoted tokens work equivalently to double-quoted', () => {
    const [call] = makeNormalizer().normalizeExecutionCalls({
      tool: "content write 'a.md' 'hello'",
    });
    expect(call.params.path).toBe('a.md');
    expect(call.params.content).toBe('hello');
  });

  it('A.3: mixed quotes preserve literal apostrophes inside double quotes', () => {
    const [call] = makeNormalizer().normalizeExecutionCalls({
      tool: `content write 'a.md' "body has 'inner'"`,
    });
    expect(call.params.content).toBe("body has 'inner'");
  });

  it('A.4: literal backslash+n in content stays as two chars (not newline)', () => {
    // CLI input: content write "a.md" "foo\\nbar"  (token content = foo\\nbar, 9 chars)
    // Correct parse: foo\nbar (8 chars: f,o,o,\,n,b,a,r) — the double-backslash
    // consumes the single-backslash first, then `n` stays literal.
    const [call] = makeNormalizer().normalizeExecutionCalls({
      tool: 'content write "a.md" "foo\\\\nbar"',
    });
    expect(call.params.content).toBe('foo\\nbar');
  });

  // B — whitespace & unicode
  it('B.1: leading/trailing whitespace in command is tolerated', () => {
    const [call] = makeNormalizer().normalizeExecutionCalls({
      tool: '   content read "a.md"   ',
    });
    expect(call.params.path).toBe('a.md');
  });

  it('B.2: multiple spaces between tokens collapse to delimiters', () => {
    const [call] = makeNormalizer().normalizeExecutionCalls({
      tool: 'content     read    "a.md"',
    });
    expect(call.params.path).toBe('a.md');
  });

  it('B.3: tab whitespace separates tokens', () => {
    const [call] = makeNormalizer().normalizeExecutionCalls({
      tool: 'content\tread\t"a.md"',
    });
    expect(call.params.path).toBe('a.md');
  });

  it('B.4: unicode text passes through unchanged', () => {
    const [call] = makeNormalizer().normalizeExecutionCalls({
      tool: 'content write "a.md" "café ☕ ñoño"',
    });
    expect(call.params.content).toBe('café ☕ ñoño');
  });

  it('B.5: emoji passes through unchanged', () => {
    const [call] = makeNormalizer().normalizeExecutionCalls({
      tool: 'content write "a.md" "hello 🎉 world 👋"',
    });
    expect(call.params.content).toBe('hello 🎉 world 👋');
  });

  // C — numbers & booleans
  it('C.1: boolean bare flag yields true', () => {
    const [call] = makeNormalizer().normalizeExecutionCalls({
      tool: 'numeric convert --enabled',
    });
    expect(call.params.enabled).toBe(true);
  });

  // §C.2: bool flag followed by unquoted `true` literal — accepts as value.
  it('C.2: --enabled followed by literal "true" — value accepted', () => {
    const [call] = makeNormalizer().normalizeExecutionCalls({
      tool: 'numeric convert --enabled true',
    });
    expect(call.params.enabled).toBe(true);
  });

  // §C.3: same logic, `false` literal.
  it('C.3: --enabled followed by literal "false" — value accepted', () => {
    const [call] = makeNormalizer().normalizeExecutionCalls({
      tool: 'numeric convert --enabled false',
    });
    expect(call.params.enabled).toBe(false);
  });

  // §C.2/§C.3 guardrail: a *quoted* `"true"` after a bool flag stays as a
  // positional (matching shell semantics). Since numericAgent_convert has no
  // positional slots, this must raise "Too many positional arguments" — the
  // quoting signals user intent of literal string, not boolean value.
  it('C.2 quoted: --enabled "true" keeps bool=true and treats "true" as positional', () => {
    const err = captureError(() =>
      makeNormalizer().normalizeExecutionCalls({
        tool: 'numeric convert --enabled "true"',
      })
    );
    expect(err.message).toMatch(/Too many positional arguments/);
  });

  // §C.2 edge: next token that is neither `true` nor `false` stays positional.
  it('C.2 non-bool next: --enabled followed by non-bool literal leaves bool=true', () => {
    const [call] = makeNormalizer().normalizeExecutionCalls({
      tool: 'numeric convert --enabled --count 3',
    });
    // --enabled = true (next token is another flag), --count = 3
    expect(call.params.enabled).toBe(true);
    expect(call.params.count).toBe(3);
  });

  it('C.4: negative number coerced as negative integer', () => {
    const [call] = makeNormalizer().normalizeExecutionCalls({
      tool: 'numeric convert --count -5',
    });
    expect(call.params.count).toBe(-5);
  });

  it('C.5: large integer within Number precision is preserved', () => {
    const [call] = makeNormalizer().normalizeExecutionCalls({
      tool: 'numeric convert --count 9999999999',
    });
    expect(call.params.count).toBe(9999999999);
  });

  it('C.6: float with fractional part coerced to number', () => {
    const [call] = makeNormalizer().normalizeExecutionCalls({
      tool: 'numeric convert --factor 3.14159',
    });
    expect(call.params.factor).toBeCloseTo(3.14159);
  });

  // D — empties
  it('D.1: empty quoted positional fills slot with empty string', () => {
    // After D.2 fix: bare "" emits an empty-string token, so path='' and the
    // following "body" fills content. Parser has no domain knowledge of path
    // validity — domain validation belongs to the tool, not the parser.
    const [call] = makeNormalizer().normalizeExecutionCalls({
      tool: 'content write "" "body"',
    });
    expect(call.params.path).toBe('');
    expect(call.params.content).toBe('body');
  });

  it('D.2: empty quoted flag value does not silently consume next token', () => {
    // Correct: --label "" → label=''; --tags "a" → tags=['a'].
    const [call] = makeNormalizer().normalizeExecutionCalls({
      tool: 'numeric convert --label "" --tags "a"',
    });
    expect(call.params.label).toBe('');
    expect(call.params.tags).toEqual(['a']);
  });

  it('D.3: omitted optional flag stays undefined', () => {
    const [call] = makeNormalizer().normalizeExecutionCalls({
      tool: 'numeric convert --factor 1.5',
    });
    expect(call.params.factor).toBe(1.5);
    expect(call.params.count).toBeUndefined();
    expect(call.params.enabled).toBeUndefined();
  });

  // E — multi-command
  it('E.1: comma inside quoted content does not split segments', () => {
    const calls = makeNormalizer().normalizeExecutionCalls({
      tool: 'content write "a.md" "alpha, beta, gamma"',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].params.content).toBe('alpha, beta, gamma');
  });

  it('E.2: comma inside JSON array-flag value does not split segments', () => {
    const calls = makeNormalizer().normalizeExecutionCalls({
      tool: 'numeric convert --tags \'["a, with comma","b"]\'',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].params.tags).toEqual(['a, with comma', 'b']);
  });

  it('E.3: command-like tokens inside quoted content stay literal', () => {
    const [call] = makeNormalizer().normalizeExecutionCalls({
      tool: 'content write "a.md" "content read fake"',
    });
    expect(call.params.content).toBe('content read fake');
  });

  // F — objects
  it('F.1: JSON object flag value is parsed via JSON.parse', () => {
    const [call] = makeNormalizer().normalizeExecutionCalls({
      tool: 'numeric convert --config \'{"nested":{"a":1}}\'',
    });
    expect(call.params.config).toEqual({ nested: { a: 1 } });
  });

  // G — positionals
  // §G.1: flag fills a slot first; positionals skip flag-filled slots and land
  // on the next unfilled one. No silent overwrite.
  it('G.1: flag set first, then positional fills remaining required slot', () => {
    const [call] = makeNormalizer().normalizeExecutionCalls({
      tool: 'content write --path "x.md" "body"',
    });
    expect(call.params.path).toBe('x.md');
    expect(call.params.content).toBe('body');
  });

  // §G.2: extra positional beyond remaining unfilled slots raises "Too many
  // positional" instead of silently overwriting a flag-set value.
  it('G.2: extra positional after flag+content raises Too many positional', () => {
    const err = captureError(() =>
      makeNormalizer().normalizeExecutionCalls({
        tool: 'content write --path "a.md" "body" "extra"',
      })
    );
    expect(err.message).toMatch(/Too many positional arguments/);
  });

  // §G.1/§G.2 guardrail: flag after positional also respects slot state.
  // First positional fills path (slot 0), then --content sets content, then
  // no more positionals — all required slots filled via legal routes.
  it('G.1 reverse: positional first then --flag fills content slot', () => {
    const [call] = makeNormalizer().normalizeExecutionCalls({
      tool: 'content write "x.md" --content "body"',
    });
    expect(call.params.path).toBe('x.md');
    expect(call.params.content).toBe('body');
  });

  it('G.3: positional omitted raises missing-required-arg for that slot', () => {
    const err = captureError(() =>
      makeNormalizer().normalizeExecutionCalls({ tool: 'content write --path "a.md"' })
    );
    expect(err.message).toMatch(/Missing required argument "content"/);
  });
});

// ---------------------------------------------------------------------------
// parseCliForDisplay — streaming-phase preview path
// ---------------------------------------------------------------------------
//
// `parseCliForDisplay` is the registry-free classifier used by the chat UI
// (accordion bubbles, status bar) to render in-flight tool calls before the
// executor resolves them. It shares `tokenizeWithMeta` + `unescapeQuotedContent`
// with `parseCommandSegment`, so the wasQuoted / A.4 / D.2 fixes need to
// surface here too. These tests pin that the display path inherits the
// upstream fixes correctly.
describe('parseCliForDisplay — display-path inheritance of parser fixes', () => {
  it('#160: quoted positional starting with -- is not surfaced as a flag', () => {
    const [segment] = parseCliForDisplay('content write "f.md" "---\nfront: matter\n---\nbody"');
    expect(segment.agent).toBe('content');
    expect(segment.tool).toBe('write');
    // The display-path classifier only collects flags into `parameters`. The
    // positional should not appear as a flag named `---\n...`.
    expect(Object.keys(segment.parameters)).toEqual([]);
  });

  it('#160: literal "--content" string in a quoted positional is not surfaced as a flag', () => {
    const [segment] = parseCliForDisplay('content write "f.md" "--content"');
    expect(Object.keys(segment.parameters)).toEqual([]);
  });

  it('A.4: literal backslash-n in a quoted flag value displays unescaped to a real newline', () => {
    const [segment] = parseCliForDisplay('content write --content "line1\\nline2"');
    expect(segment.parameters.content).toBe('line1\nline2');
  });

  it('D.2: empty quoted flag value displays as empty string (not consuming next token)', () => {
    const [segment] = parseCliForDisplay('content write --path "" --content "body"');
    expect(segment.parameters.path).toBe('');
    expect(segment.parameters.content).toBe('body');
  });

  it('flag without value displays as boolean true', () => {
    const [segment] = parseCliForDisplay('storage list --recursive');
    expect(segment.parameters.recursive).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Post-audit edge cases (EC-1..EC-5) — see docs/plans/cli-parser-edge-cases-plan.md
// ---------------------------------------------------------------------------

describe('EC-1: non-bool flag rejects a flag-like value as its argument', () => {
  // Symmetric to the boolean peek (§C.2/§C.3) that landed in PR #165: the
  // bool branch checks for true/false before consuming `next`, but the
  // non-bool branch used to trust `tokens[index + 1]` blindly. So
  // `content write --path --content "body"` silently set path="--content"
  // and then dropped "body" into the content slot. EC-1 throws instead.

  it('throws when next token is an unquoted flag', () => {
    const err = captureError(() =>
      makeNormalizer().normalizeExecutionCalls({
        tool: 'content write --path --content "body"',
      })
    );
    expect(err.message).toMatch(/Flag "--path" requires a value, got flag "--content"/);
  });

  it('still allows a quoted positional whose text starts with -- as a flag value', () => {
    // wasQuoted=true is the explicit "this is data, not a flag" signal, so
    // a deliberate quoted `--important` literal stays legal.
    const [call] = makeNormalizer().normalizeExecutionCalls({
      tool: 'numeric convert --label "--important"',
    });
    expect(call.params.label).toBe('--important');
  });

  it('does not falsely reject a value that happens to contain --', () => {
    // Unquoted `--` later in the string is fine as long as the *whole token*
    // is not flag-like (i.e., starts with --).
    const [call] = makeNormalizer().normalizeExecutionCalls({
      tool: 'numeric convert --label foo--bar',
    });
    expect(call.params.label).toBe('foo--bar');
  });
});

describe('EC-2: tokenizer throws on unclosed quote at end of input', () => {
  // tokenizeWithMeta enters quote mode and never re-emits if the closing
  // quote never arrives. The end-of-input fallback used to push whatever
  // accumulated; in a multi-segment call the unclosed quote silently
  // swallowed subsequent commands. EC-2 throws loud instead.

  it('throws on a single double-quote with no close', () => {
    expect(() => tokenizeWithMeta('content write "x.md" "unclosed'))
      .toThrow(/Unclosed double quote in segment/);
  });

  it('throws on a single single-quote with no close', () => {
    expect(() => tokenizeWithMeta("storage list 'unclosed"))
      .toThrow(/Unclosed single quote in segment/);
  });

  it('propagates the throw through the execution path', () => {
    const err = captureError(() =>
      makeNormalizer().normalizeExecutionCalls({
        tool: 'content write "x.md" "unclosed',
      })
    );
    expect(err.message).toMatch(/Unclosed double quote in segment/);
  });

  it('matched quotes still tokenize cleanly (regression guard)', () => {
    expect(() => tokenizeWithMeta('content write "x.md" "body"')).not.toThrow();
  });
});

describe('EC-3: array<X> coerces every element to X', () => {
  // Previously coerceValue's array<...> branch returned string[] for every
  // item type except the all-strings JSON case. So array<integer>/array<number>
  // tools would receive ["1","2","3"] and trip a downstream type error. EC-3
  // per-item coerces using the items.type extracted from the schema.

  it('array<integer> via CSV yields integers', () => {
    const [call] = makeNormalizer().normalizeExecutionCalls({
      tool: 'numeric convert --pages "1,2,3"',
    });
    expect(call.params.pages).toEqual([1, 2, 3]);
  });

  it('array<number> via CSV yields floats', () => {
    const [call] = makeNormalizer().normalizeExecutionCalls({
      tool: 'numeric convert --weights "1.5,2.5,3.5"',
    });
    expect(call.params.weights).toEqual([1.5, 2.5, 3.5]);
  });

  it('array<integer> via JSON yields integers (was already correct, regression guard)', () => {
    const [call] = makeNormalizer().normalizeExecutionCalls({
      tool: 'numeric convert --pages "[1,2,3]"',
    });
    expect(call.params.pages).toEqual([1, 2, 3]);
  });

  it('array<object> via JSON yields parsed objects', () => {
    // Pre-EC-3 the all-strings precondition rejected this and CSV-fell-through
    // to a string[] of broken JSON fragments. Now JSON path accepts any item
    // type, with per-item passthrough for already-typed items.
    const [call] = makeNormalizer().normalizeExecutionCalls({
      tool: 'numeric convert --objects \'[{"a":1},{"b":2}]\'',
    });
    expect(call.params.objects).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('array<string> via CSV is unchanged (per-item coerce of string is a no-op)', () => {
    const [call] = makeNormalizer().normalizeExecutionCalls({
      tool: 'numeric convert --tags "alpha,beta,gamma"',
    });
    expect(call.params.tags).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('array<string> via JSON is unchanged (regression guard)', () => {
    const [call] = makeNormalizer().normalizeExecutionCalls({
      tool: 'numeric convert --tags \'["alpha","beta","gamma"]\'',
    });
    expect(call.params.tags).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('array<integer> with an unparseable item leaves that item as raw string', () => {
    // Per-item coerceValue falls through to raw on NaN. Schema validation
    // downstream is the appropriate place to reject — parser does not.
    const [call] = makeNormalizer().normalizeExecutionCalls({
      tool: 'numeric convert --pages "1,not-a-number,3"',
    });
    expect(call.params.pages).toEqual([1, 'not-a-number', 3]);
  });
});

describe('EC-4: empty/whitespace number value is preserved as raw, not coerced to 0', () => {
  // Number("") === 0 and Number("   ") === 0 in JS, which sneaks past the
  // NaN guard. After D.2's empty-token emission landed in PR #165 these
  // empty values reach the coercer. Preserving the raw empty string lets
  // schema validation reject it as "expected number, got string" instead
  // of silently turning into 0.

  it('--count "" is preserved as the empty string', () => {
    const [call] = makeNormalizer().normalizeExecutionCalls({
      tool: 'numeric convert --count ""',
    });
    expect(call.params.count).toBe('');
  });

  it('--factor "   " (whitespace only) is preserved as the raw whitespace', () => {
    const [call] = makeNormalizer().normalizeExecutionCalls({
      tool: 'numeric convert --factor "   "',
    });
    expect(call.params.factor).toBe('   ');
  });

  it('valid numbers still coerce (regression guard)', () => {
    const [call] = makeNormalizer().normalizeExecutionCalls({
      tool: 'numeric convert --count 0',
    });
    // "0" → 0 is the legitimate zero, not the empty-string-shaped silent zero.
    expect(call.params.count).toBe(0);
  });
});

describe('EC-5: --flag=value GNU long-option syntax', () => {
  // LLMs frequently emit `--flag=value` instead of `--flag value`. The previous
  // tokenizer treated `=` as a regular character, so `--path=x.md` became one
  // token and the lookup failed. EC-5 splits on the first `=` before the
  // context/no-/lookup checks.

  it('accepts --flag=value for a non-bool flag', () => {
    const [call] = makeNormalizer().normalizeExecutionCalls({
      tool: 'content write --path=notes/x.md --content=body',
    });
    expect(call.params.path).toBe('notes/x.md');
    expect(call.params.content).toBe('body');
  });

  it('accepts --bool=true / --bool=false for boolean flags', () => {
    const [a] = makeNormalizer().normalizeExecutionCalls({
      tool: 'numeric convert --enabled=true',
    });
    expect(a.params.enabled).toBe(true);

    const [b] = makeNormalizer().normalizeExecutionCalls({
      tool: 'numeric convert --enabled=false',
    });
    expect(b.params.enabled).toBe(false);
  });

  it('rejects non-canonical literals for boolean inline values', () => {
    const err = captureError(() =>
      makeNormalizer().normalizeExecutionCalls({
        tool: 'numeric convert --enabled=yes',
      })
    );
    expect(err.message).toMatch(/Boolean flag "--enabled" only accepts =true or =false, got "yes"/);
  });

  it('keeps the first = as the separator so values may contain =', () => {
    const [call] = makeNormalizer().normalizeExecutionCalls({
      tool: 'numeric convert --label=key=value',
    });
    expect(call.params.label).toBe('key=value');
  });

  it('coerces typed numeric values via the inline path', () => {
    const [call] = makeNormalizer().normalizeExecutionCalls({
      tool: 'numeric convert --count=42 --factor=1.5',
    });
    expect(call.params.count).toBe(42);
    expect(call.params.factor).toBe(1.5);
  });

  // Note: CSV/JSON-array values cannot be expressed via the inline form
  // unquoted — they need quoting for the segment splitter (top-level commas)
  // and tokenizer (top-level brackets aren't a quote pair). And quoted
  // (`--tags="a,b"`) hits a separate pre-existing tokenizer limitation
  // (mid-token `"` flips the whole token to wasQuoted=true). Out of scope
  // for EC-5; use the space-separated form for those values.

  it('still rejects context flags via the inline form', () => {
    const err = captureError(() =>
      makeNormalizer().normalizeExecutionCalls({
        tool: 'content read --workspace-id=abc --path=foo.md',
      })
    );
    expect(err.message).toMatch(/Do not include --workspace-id inside "tool"/);
  });

  it('rejects --no-<flag>=value combination', () => {
    const err = captureError(() =>
      makeNormalizer().normalizeExecutionCalls({
        tool: 'numeric convert --no-enabled=true',
      })
    );
    expect(err.message).toMatch(/Negation flag "--no-enabled" cannot be combined with =value/);
  });

  it('--flag= (empty inline value) throws for non-bool flags (Backend M1)', () => {
    // Parser now rejects `--flag=` with empty RHS at the CLI layer instead of
    // silently coercing through to `""` and deferring to schema validation.
    // The `""` previously passed the `required !== undefined` check and only
    // string validators caught it. See task #5 Item 2. The bare form
    // `--count ""` (space-separated, explicit empty string) stays legal.
    const err = captureError(() =>
      makeNormalizer().normalizeExecutionCalls({
        tool: 'numeric convert --count=',
      })
    );
    expect(err.message).toMatch(/Flag "--count" requires a non-empty value after "="/);
  });
});

// ---------------------------------------------------------------------------
// Task #5 Minor bundle — parseCliForDisplay catches up to parseCommandSegment
// ---------------------------------------------------------------------------
//
// The display parser is registry-free (used by the streaming chat bubble
// before the executor resolves names), so it can't consult a schema. But it
// now mirrors the SHAPE-level conventions of the execution parser so the
// preview matches what the executor will produce post-resolution.

describe('parseCliForDisplay — Minor bundle (task #5 Item 1)', () => {
  it('splits --flag=value on first `=` (previously keyed as "flag=value")', () => {
    // Unquoted RHS: mirrors the execution parser, which also treats
    // `--flag="quoted"` as a single wasQuoted positional token (the `"`
    // opens mid-token → whole token flips to wasQuoted → not recognized as
    // a flag). Inline form with quoted RHS is out of scope; use the
    // space-separated form for that.
    const [segment] = parseCliForDisplay('content write --path=notes/today.md --content=body');
    expect(segment.parameters.path).toBe('notes/today.md');
    expect(segment.parameters.content).toBe('body');
    expect(Object.keys(segment.parameters)).not.toContain('path=notes/today.md');
  });

  it('multiple `=` chars keep the first as the separator (--label=key=value)', () => {
    const [segment] = parseCliForDisplay('numeric convert --label=key=value');
    expect(segment.parameters.label).toBe('key=value');
  });

  it('coerces canonical true/false in --flag=value inline form to boolean', () => {
    const [segment] = parseCliForDisplay('numeric convert --enabled=true --other=false');
    expect(segment.parameters.enabled).toBe(true);
    expect(segment.parameters.other).toBe(false);
  });

  it('--no-foo negation displays as {foo: false} (previously {"no-foo": true})', () => {
    const [segment] = parseCliForDisplay('numeric convert --no-enabled');
    expect(segment.parameters.enabled).toBe(false);
    expect(Object.keys(segment.parameters)).not.toContain('no-enabled');
  });

  it('--no-foo is not treated as negation when combined with =value (displays inline key literally)', () => {
    // Execution parser throws for `--no-foo=value`; display parser preserves
    // the split for forensic visibility — the chat bubble will show an odd
    // key but the actual executor error is the source of truth.
    const [segment] = parseCliForDisplay('numeric convert --no-enabled=true');
    expect(segment.parameters['no-enabled']).toBe(true);
  });

  it('unquoted --verbose true peek coerces to boolean (previously string "true")', () => {
    const [segment] = parseCliForDisplay('numeric convert --verbose true --after extra');
    expect(segment.parameters.verbose).toBe(true);
    expect(segment.parameters.after).toBe('extra');
  });

  it('quoted --verbose "true" stays a string (quote is the "data not bool" signal)', () => {
    const [segment] = parseCliForDisplay('numeric convert --verbose "true"');
    expect(segment.parameters.verbose).toBe('true');
  });

  it('bare --flag followed by another flag stays boolean true', () => {
    const [segment] = parseCliForDisplay('numeric convert --enabled --path=x');
    expect(segment.parameters.enabled).toBe(true);
    expect(segment.parameters.path).toBe('x');
  });
});

// ---------------------------------------------------------------------------
// Task #5 Items 3 + 4 — coerceValue canonical-literal throw for booleans
// ---------------------------------------------------------------------------

describe('coerceValue — boolean canonical-literal enforcement (Backend M2)', () => {
  // Note on reachability: `coerceValue(raw, 'boolean')` is ONLY reached via
  // the `array<boolean>` item path — scalar boolean flags are handled earlier
  // in parseCommandSegment via the C.2/C.3 bool-peek without ever calling
  // coerceValue. Item 3 is therefore a defensive tightening that materializes
  // through the array path (see block below for array<boolean> coverage).
  // The scalar-flag-with-bogus-value case (`--enabled "maybe"`) intentionally
  // does NOT reach coerceValue — the quoted token is treated as the next
  // positional, which for numericAgent.convert (no positional slots) raises
  // "Too many positional arguments". This is the pre-existing behavior and
  // is left unchanged by Item 3.

  it('throws for non-canonical boolean via inline =value (EC-5, unchanged by Item 3)', () => {
    // The inline `--flag=value` branch has its own canonical-literal check
    // (EC-5). Pin the message so future refactors don't drift from the
    // array<boolean> canonical-literal message.
    const err = captureError(() =>
      makeNormalizer().normalizeExecutionCalls({
        tool: 'numeric convert --enabled=yes',
      })
    );
    expect(err.message).toMatch(/Boolean flag "--enabled" only accepts =true or =false, got "yes"/);
  });

  it('accepts canonical "true"/"false" via space-separated bool-peek (regression guard)', () => {
    const [call] = makeNormalizer().normalizeExecutionCalls({
      tool: 'numeric convert --enabled true',
    });
    expect(call.params.enabled).toBe(true);
  });

  it('treats quoted "maybe" after a bool flag as the next positional (unchanged)', () => {
    // Documents the current reachability boundary: the quoted value stays
    // a positional because wasQuoted=true blocks the bool-peek. For
    // numericAgent.convert this raises "Too many positional arguments".
    // If the tool had a positional slot, the quoted "maybe" would land
    // there — coerceValue for bool is never reached on this path.
    const err = captureError(() =>
      makeNormalizer().normalizeExecutionCalls({
        tool: 'numeric convert --enabled "maybe"',
      })
    );
    expect(err.message).toMatch(/Too many positional arguments/);
  });
});

describe('coerceValue — array<boolean> canonical-literal enforcement (Backend M3)', () => {
  // numericAgent.convert doesn't declare an array<boolean> slot, so define a
  // local stub just for this block.
  function makeBoolArrayNormalizer(): ToolCliNormalizer {
    const flagsAgent = makeStubAgent('flagsAgent', [
      makeStubTool('toggle', {
        type: 'object',
        properties: {
          values: { type: 'array', items: { type: 'boolean' } },
        },
        required: [],
      }),
    ]);
    return new ToolCliNormalizer(new Map<string, IAgent>([
      ['flagsAgent', flagsAgent],
      ['toolManager', makeStubAgent('toolManager', [])],
    ]));
  }

  it('coerces CSV of canonical true/false to boolean[]', () => {
    const [call] = makeBoolArrayNormalizer().normalizeExecutionCalls({
      tool: 'flags toggle --values "true,false,true"',
    });
    expect(call.params.values).toEqual([true, false, true]);
  });

  it('throws when any CSV item is non-canonical (Item 4)', () => {
    const err = captureError(() =>
      makeBoolArrayNormalizer().normalizeExecutionCalls({
        tool: 'flags toggle --values "true,maybe,false"',
      })
    );
    expect(err.message).toMatch(/Boolean value accepts only "true" or "false", got "maybe"/);
  });

  it('throws for non-canonical items inside a JSON-array literal', () => {
    // JSON-parsed string items flow through coerceArrayItem → coerceValue,
    // so the canonical check fires there too.
    const err = captureError(() =>
      makeBoolArrayNormalizer().normalizeExecutionCalls({
        tool: 'flags toggle --values \'["true","nope"]\'',
      })
    );
    expect(err.message).toMatch(/Boolean value accepts only "true" or "false", got "nope"/);
  });
});

// ---------------------------------------------------------------------------
// Issue #179 — `\X` default-branch policy in unescapeQuotedContent
// ---------------------------------------------------------------------------
//
// Before the fix, the switch's `default` branch re-emitted the backslash, so
// `\`` / `\$` / `\#` etc. carried a phantom backslash into the content
// payload — silently corrupting backticks, code fences, and any shell-ish
// character an LLM might defensively escape. Post-fix, `\X` for X outside
// the canonical set (`n r t " ' \ u`) drops the backslash (POSIX-shell
// double-quoted convention). Literal `\X` is still reachable via `\\X`,
// which collapses through the `\\` case.
describe('Issue #179: unescapeQuotedContent — `\\X` default-branch policy', () => {
  it('drops the backslash before a backtick inside a double-quoted positional (fix target)', () => {
    // Wire input: content write "x.md" "teste \`code\` fim"
    const [call] = makeNormalizer().normalizeExecutionCalls({
      tool: 'content write "x.md" "teste \\`code\\` fim"',
    });
    expect(call.params.content).toBe('teste `code` fim');
  });

  it('preserves naked backticks (regression guard — no escape, no transform)', () => {
    const [call] = makeNormalizer().normalizeExecutionCalls({
      tool: 'content write "x.md" "teste `code` fim"',
    });
    expect(call.params.content).toBe('teste `code` fim');
  });

  it('preserves a literal backslash+backtick via double-escape (`\\\\` then `\\\\`)', () => {
    // Wire input: content write "x.md" "\\`code\\`"
    // The `\\` consumes to a single backslash (canonical case), then `` ` ``
    // stays naked, giving the literal bytes `\` + `` ` ``.
    const [call] = makeNormalizer().normalizeExecutionCalls({
      tool: 'content write "x.md" "\\\\`code\\\\`"',
    });
    expect(call.params.content).toBe('\\`code\\`');
  });

  it('preserves naked fenced code block (triple backticks, no escapes)', () => {
    const [call] = makeNormalizer().normalizeExecutionCalls({
      tool: 'content write "x.md" "```dataview\nLIST\n```"',
    });
    expect(call.params.content).toBe('```dataview\nLIST\n```');
  });

  it('drops the backslash for non-canonical letter escapes (\\a \\b \\f \\v)', () => {
    // Characterization: these were previously preserved as `\a\b\f\v` (8
    // bytes). The fix aligns with shell double-quoted semantics — X with
    // no special meaning becomes X.
    const [call] = makeNormalizer().normalizeExecutionCalls({
      tool: 'content write "x.md" "\\a\\b\\f\\v"',
    });
    expect(call.params.content).toBe('abfv');
  });

  it('drops the backslash for shell-meta chars (\\$ \\# \\( \\))', () => {
    const [call] = makeNormalizer().normalizeExecutionCalls({
      tool: 'content write "x.md" "\\$var \\# heading \\(group\\)"',
    });
    expect(call.params.content).toBe('$var # heading (group)');
  });

  it('canonical escape set remains unchanged (\\n \\r \\t \\" \\\\)', () => {
    const [call] = makeNormalizer().normalizeExecutionCalls({
      tool: 'content write "x.md" "line1\\nline2\\tend\\r\\"q\\"\\\\done"',
    });
    expect(call.params.content).toBe('line1\nline2\tend\r"q"\\done');
  });

  it('valid `\\uXXXX` still decodes (unchanged)', () => {
    const [call] = makeNormalizer().normalizeExecutionCalls({
      tool: 'content write "x.md" "dash \\u2014 ok"',
    });
    expect(call.params.content).toBe('dash — ok');
  });

  it('invalid `\\u` followed by non-hex drops the backslash (falls through to default)', () => {
    // `\u` only takes the 4-hex fast path when the next 4 chars match
    // /^[0-9a-fA-F]{4}$/. Otherwise it falls through to the switch, and
    // post-fix the default branch drops the backslash. So `\user` → `user`.
    const [call] = makeNormalizer().normalizeExecutionCalls({
      tool: 'content write "x.md" "\\user"',
    });
    expect(call.params.content).toBe('user');
  });

  it('tokenizeWithMeta surface: backtick escape drops backslash', () => {
    const tokens = tokenizeWithMeta('content write "x.md" "\\`code\\`"');
    expect(tokens[tokens.length - 1]).toEqual({ value: '`code`', wasQuoted: true });
  });

  it('parseCliForDisplay surface: display path inherits the fix', () => {
    const [segment] = parseCliForDisplay('content write --content "teste \\`code\\` fim"');
    expect(segment.parameters.content).toBe('teste `code` fim');
  });
});
