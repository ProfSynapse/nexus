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
import { ToolCliNormalizer } from '../../src/agents/toolManager/services/ToolCliNormalizer';
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
  // Used to cover every coerceValue branch.
  const coerceAgent = makeStubAgent('numericAgent', [
    makeStubTool('convert', {
      type: 'object',
      properties: {
        count: { type: 'integer' },
        factor: { type: 'number' },
        enabled: { type: 'boolean' },
        tags: { type: 'array', items: { type: 'string' } },
        config: { type: 'object' },
        label: { type: 'string' },
      },
      required: [],
    }),
  ]);

  return new Map<string, IAgent>([
    ['contentManager', contentAgent],
    ['storageManager', storageAgent],
    ['numericAgent', coerceAgent],
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
      expect(agents).toEqual(['contentManager', 'numericAgent', 'storageManager']);
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

    it('returns preserved params.request array when provided (legacy path)', () => {
      const normalizer = makeNormalizer();
      const request = [{ agent: 'storageManager', tools: ['list'] }];
      const result = normalizer.normalizeDiscoveryRequests({ request });
      expect(result).toEqual(request);
    });
  });

  // -------------------------------------------------------------------------
  // Execution (useTools) — throw sites
  // -------------------------------------------------------------------------

  describe('normalizeExecutionCalls — throw sites', () => {
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
  // Edge cases — quoting, escapes, multi-command
  // -------------------------------------------------------------------------

  describe('normalizeExecutionCalls — edge cases', () => {
    it('drops empty quoted tokens — tokenizer does not emit "" as a value', () => {
      // Characterization (see review M1): the tokenizer only pushes a token
      // when `current.length > 0`. A bare `""` produces no token, so an
      // empty-string positional slot is silently skipped. Here
      // `content write "" "body"` becomes tokens `['content','write','body']`
      // — only `path` gets the value and `content` is missing.
      const err = captureError(() =>
        makeNormalizer().normalizeExecutionCalls({ tool: 'content write "" "body"' })
      );
      expect(err.message).toMatch(/Missing required argument "content" for contentManager\.write/);
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

    it('returns preserved calls array when provided (legacy path)', () => {
      const calls = [{ agent: 'contentManager', tool: 'read', params: { path: 'x.md' } }];
      const result = makeNormalizer().normalizeExecutionCalls({ calls });
      expect(result).toEqual(calls);
    });
  });
});
