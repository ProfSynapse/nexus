/**
 * tests/unit/ContentWriteGuard.test.ts — tool-layer guards for
 * `contentManager.write`. Previously an empty-string path was silently
 * rewritten to `untitled-<timestamp>.md` at the vault root, leaving orphan
 * files behind when an LLM or parser dropped the path by mistake. The tool
 * now rejects empty/whitespace paths explicitly.
 *
 * Exercises the public CLI-first `useTools` surface so regressions at the
 * parser boundary are caught alongside the tool guard.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHeadlessAgentStack, HeadlessAgentStackResult } from '../eval/headless/HeadlessAgentStack';
import { TestVaultManager } from '../eval/headless/TestVaultManager';

const TEST_CONTEXT = {
  workspaceId: 'test-ws',
  sessionId: 'test-session',
  memory: 'ContentWrite guard regression test session.',
  goal: 'Verify contentManager.write rejects empty paths.',
};

interface CallResult {
  success: boolean;
  error?: string;
}

// ToolBatchExecutionService.formatUseToolResult flattens single-call results
// to the top level; multi-call results nest under `data.results`. Normalize
// to the flat shape here so tests don't care.
function getCallResult(result: unknown): CallResult {
  const r = result as { success?: boolean; error?: string; data?: { results?: CallResult[] } };
  if (r.data?.results && Array.isArray(r.data.results) && r.data.results.length > 0) {
    return r.data.results[0];
  }
  return { success: r.success ?? false, error: r.error };
}

describe('contentManager.write — empty-path guard', () => {
  let stack: HeadlessAgentStackResult;
  let vaultManager: TestVaultManager;
  let testDir: string;

  beforeAll(async () => {
    testDir = path.join(os.tmpdir(), `nexus-write-guard-${Date.now()}`);
    vaultManager = new TestVaultManager(testDir);
    vaultManager.reset();
    vaultManager.seed({});

    stack = await createHeadlessAgentStack({
      basePath: testDir,
      vaultName: 'write-guard-vault',
    });
  }, 30000);

  afterAll(() => {
    vaultManager.cleanup();
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('rejects empty string path with a clear error', async () => {
    const result = await stack.useTools({
      ...TEST_CONTEXT,
      tool: 'content write "" "body"',
    });

    const call = getCallResult(result);
    expect(call.success).toBe(false);
    expect(call.error).toMatch(/path must be a non-empty string/);
  });

  it('rejects whitespace-only path', async () => {
    const result = await stack.useTools({
      ...TEST_CONTEXT,
      tool: 'content write "   " "body"',
    });

    const call = getCallResult(result);
    expect(call.success).toBe(false);
    expect(call.error).toMatch(/path must be a non-empty string/);
  });

  it('does not create any orphan file when path is empty', async () => {
    await stack.useTools({
      ...TEST_CONTEXT,
      tool: 'content write "" "body"',
    });

    // No untitled-*.md should have been created at vault root.
    const rootEntries = fs.readdirSync(testDir);
    const orphans = rootEntries.filter(name => name.startsWith('untitled-') && name.endsWith('.md'));
    expect(orphans).toEqual([]);
  });

  it('still accepts "/" as a "pick a filename in vault root" shortcut', async () => {
    const result = await stack.useTools({
      ...TEST_CONTEXT,
      tool: 'content write "/" "body"',
    });

    const call = getCallResult(result);
    expect(call.success).toBe(true);
    const rootEntries = fs.readdirSync(testDir);
    const generated = rootEntries.filter(name => name.startsWith('untitled-') && name.endsWith('.md'));
    expect(generated.length).toBeGreaterThanOrEqual(1);
  });

  it('still accepts normal paths', async () => {
    const result = await stack.useTools({
      ...TEST_CONTEXT,
      tool: 'content write "notes/regular.md" "hello"',
    });

    const call = getCallResult(result);
    expect(call.success).toBe(true);
    const written = fs.readFileSync(path.join(testDir, 'notes/regular.md'), 'utf-8');
    expect(written).toBe('hello');
  });
});

describe('contentManager.write — frontmatter guard', () => {
  let stack: HeadlessAgentStackResult;
  let vaultManager: TestVaultManager;
  let testDir: string;

  beforeAll(async () => {
    testDir = path.join(os.tmpdir(), `nexus-write-frontmatter-${Date.now()}`);
    vaultManager = new TestVaultManager(testDir);
    vaultManager.reset();
    vaultManager.seed({});

    stack = await createHeadlessAgentStack({
      basePath: testDir,
      vaultName: 'write-frontmatter-vault',
    });
  }, 30000);

  afterAll(() => {
    vaultManager.cleanup();
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('rejects unquoted colon syntax inside a frontmatter value', async () => {
    const content = [
      '---',
      'fonte: Texto com (subitem: que tem dois pontos)',
      'status: ativo',
      '---',
      '',
      '# Repro',
    ].join('\n');

    const result = await stack.useTools({
      ...TEST_CONTEXT,
      tool: `content write "notes/invalid-colon.md" ${JSON.stringify(content)}`,
    });

    const call = getCallResult(result);
    expect(call.success).toBe(false);
    expect(call.error).toContain('Frontmatter is invalid YAML');
    expect(call.error).toContain('fonte: Texto com');
    expect(fs.existsSync(path.join(testDir, 'notes/invalid-colon.md'))).toBe(false);
  });

  it('rejects malformed YAML frontmatter', async () => {
    const content = [
      '---',
      'title: "Unclosed',
      '---',
      '',
      'Body',
    ].join('\n');

    const result = await stack.useTools({
      ...TEST_CONTEXT,
      tool: `content write "notes/unclosed-quote.md" ${JSON.stringify(content)}`,
    });

    const call = getCallResult(result);
    expect(call.success).toBe(false);
    expect(call.error).toContain('Frontmatter is invalid YAML');
  });

  it('rejects non-mapping frontmatter documents', async () => {
    const listContent = [
      '---',
      '- status',
      '- ativo',
      '---',
      '',
      'Body',
    ].join('\n');

    const result = await stack.useTools({
      ...TEST_CONTEXT,
      tool: `content write "notes/list-frontmatter.md" ${JSON.stringify(listContent)}`,
    });

    const call = getCallResult(result);
    expect(call.success).toBe(false);
    expect(call.error).toContain('Frontmatter must be a YAML mapping');
  });

  it('accepts empty frontmatter', async () => {
    const content = [
      '---',
      '---',
      '',
      'Body',
    ].join('\n');

    const result = await stack.useTools({
      ...TEST_CONTEXT,
      tool: `content write "notes/empty-frontmatter.md" ${JSON.stringify(content)}`,
    });

    const call = getCallResult(result);
    expect(call.success).toBe(true);
    const written = fs.readFileSync(path.join(testDir, 'notes/empty-frontmatter.md'), 'utf-8');
    expect(written).toBe(content);
  });

  it('writes valid mapped frontmatter byte-for-byte', async () => {
    const content = [
      '---',
      '# keep this comment',
      'status: ativo',
      'fonte: "Texto com (subitem: que tem dois pontos)"',
      'aliases:',
      '  - "Primeiro alias"',
      '---',
      '',
      '# Titulo',
      '',
      'Body',
    ].join('\n');

    const result = await stack.useTools({
      ...TEST_CONTEXT,
      tool: `content write "notes/valid-frontmatter.md" ${JSON.stringify(content)}`,
    });

    const call = getCallResult(result);
    expect(call.success).toBe(true);
    const written = fs.readFileSync(path.join(testDir, 'notes/valid-frontmatter.md'), 'utf-8');
    expect(written).toBe(content);
  });

  it('accepts content without leading frontmatter', async () => {
    const content = '# No frontmatter\n\nBody: with a colon is fine.';

    const result = await stack.useTools({
      ...TEST_CONTEXT,
      tool: `content write "notes/no-frontmatter.md" ${JSON.stringify(content)}`,
    });

    const call = getCallResult(result);
    expect(call.success).toBe(true);
    const written = fs.readFileSync(path.join(testDir, 'notes/no-frontmatter.md'), 'utf-8');
    expect(written).toBe(content);
  });

  it('does not treat body delimiters as frontmatter', async () => {
    const content = [
      '# Body delimiter',
      '',
      '---',
      'fonte: Texto com (subitem: que tem dois pontos)',
      '---',
    ].join('\n');

    const result = await stack.useTools({
      ...TEST_CONTEXT,
      tool: `content write "notes/body-delimiter.md" ${JSON.stringify(content)}`,
    });

    const call = getCallResult(result);
    expect(call.success).toBe(true);
    const written = fs.readFileSync(path.join(testDir, 'notes/body-delimiter.md'), 'utf-8');
    expect(written).toBe(content);
  });

  it('does not overwrite an existing file when incoming frontmatter is invalid', async () => {
    const existingPath = path.join(testDir, 'notes/existing.md');
    fs.mkdirSync(path.dirname(existingPath), { recursive: true });
    fs.writeFileSync(existingPath, 'original', 'utf-8');

    const invalidContent = [
      '---',
      'fonte: Texto com (subitem: que tem dois pontos)',
      '---',
      '',
      'replacement',
    ].join('\n');

    const result = await stack.useTools({
      ...TEST_CONTEXT,
      tool: `content write "notes/existing.md" ${JSON.stringify(invalidContent)} --overwrite true`,
    });

    const call = getCallResult(result);
    expect(call.success).toBe(false);
    expect(fs.readFileSync(existingPath, 'utf-8')).toBe('original');
  });
});
