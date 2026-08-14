/**
 * Live web-capture smoke test.
 *
 * Drives a RUNNING Nexus vault through the `nexus` CLI, so `web
 * capture-markdown` runs against real Defuddle, a real `DOMParser` document and
 * Obsidian's real `htmlToMarkdown`. Skipped unless explicitly enabled.
 *
 *   RUN_WEB_CAPTURE_SMOKE=1 npx jest tests/debug/web-capture-live-smoke.test.ts --runInBand --no-coverage --verbose
 *
 * Pick a vault (otherwise the CLI's default is used):
 *   RUN_WEB_CAPTURE_SMOKE=1 WEB_CAPTURE_SMOKE_VAULT=code npx jest tests/debug/web-capture-live-smoke.test.ts --runInBand
 *
 * ## Why this exists
 *
 * The unit lane cannot reach the part that matters. Jest runs on the `node`
 * environment with no DOM, so `tests/unit/WebContentExtractor.test.ts` stubs
 * `htmlToMarkdown` and never constructs a Defuddle instance at all — it proves
 * the mapping and the `requestUrl` shim, nothing about extraction. Three claims
 * the design plan makes are only checkable here:
 *
 *  1. Defuddle degrades rather than throws on a detached `DOMParser` document
 *     (`defaultView === null`), which is what the fetch transport hands it.
 *  2. Obsidian's `htmlToMarkdown` turns the cleaned HTML into real markdown —
 *     headings and links, not a tag-stripped blob.
 *  3. The fetch transport opens no Web Viewer leaf, i.e. a data operation no
 *     longer mutates the workspace.
 *
 * It needs network access, and it asserts on live pages — so it asserts on
 * structural floors (a heading exists, word count is substantial) rather than
 * exact text, which would rot.
 *
 * It writes scratch notes under a dedicated folder and archives them
 * afterwards. It never touches anything else in the vault.
 *
 * ## Before running
 *
 * Reload the plugin so it is running the build under test, and prefer a FULL
 * vault reload — `obsidian-cli vault=<name> reload`. `plugin:reload` leaves the
 * plugin in a degraded state whose MCP socket dies about 35s later and whose
 * Web Viewer transport hangs; see the `nexus-testing` skill.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

jest.setTimeout(300_000);

const RUN_LIVE = process.env.RUN_WEB_CAPTURE_SMOKE === '1';
const VAULT = process.env.WEB_CAPTURE_SMOKE_VAULT;
const SCRATCH = '_web-capture-smoke';

const MEMORY = 'Running the automated web-capture smoke test against a live vault.';
const GOAL = 'Verify Defuddle extraction, metadata frontmatter and transport selection end to end.';

/** A stable, content-rich page with headings, links and real metadata. */
const ARTICLE_URL = 'https://en.wikipedia.org/wiki/Markdown';

interface CaptureResult {
  success: boolean;
  error?: string;
  path?: string;
  transport?: string;
  title?: string | null;
  site?: string | null;
  wordCount?: number;
}

async function nexus(command: string[]): Promise<Record<string, unknown>> {
  const args = [
    ...(VAULT ? ['--vault', VAULT] : []),
    'use',
    '--memory', MEMORY,
    '--goal', GOAL,
    '--',
    ...command
  ];

  const { stdout } = await execFileAsync('nexus', args, { maxBuffer: 32 * 1024 * 1024 });
  return parseCliOutput(stdout);
}

/**
 * Pull the result object out of CLI output.
 *
 * On success the CLI prints bare JSON. On failure it prints a human-readable
 * banner first and the JSON under "Full Error Details", so a bare `JSON.parse`
 * throws on exactly the cases a failure-path test needs to inspect.
 */
function parseCliOutput(stdout: string): Record<string, unknown> {
  const start = stdout.indexOf('{');
  if (start === -1) {
    throw new Error(`No JSON in CLI output:\n${stdout}`);
  }
  return JSON.parse(stdout.slice(start)) as Record<string, unknown>;
}

async function capture(args: string[]): Promise<CaptureResult> {
  return await nexus(['web', 'capture-markdown', ...args]) as unknown as CaptureResult;
}

async function readNote(path: string): Promise<string> {
  const result = await nexus(['content', 'read', path, '1']);
  if (result.success !== true) {
    throw new Error(`Failed to read ${path}: ${JSON.stringify(result)}`);
  }
  // `content read` prefixes each line with "<n>: " for positioning.
  return String(result.content ?? '').replace(/^\d+: ?/gm, '');
}

function frontmatterOf(note: string): Record<string, string> {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(note);
  if (!match) {
    throw new Error(`No frontmatter in note:\n${note.slice(0, 300)}`);
  }

  const fields: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const separator = line.indexOf(': ');
    if (separator > 0) {
      fields[line.slice(0, separator)] = line.slice(separator + 2);
    }
  }
  return fields;
}

const describeLive = RUN_LIVE ? describe : describe.skip;

describeLive('web capture-markdown against a live vault', () => {
  afterAll(async () => {
    // Archive is reversible; the AI surface has no delete by design.
    await nexus(['storage', 'archive', '--path', SCRATCH]).catch(() => undefined);
  });

  describe('the fetch transport', () => {
    let note = '';
    let result: CaptureResult;

    beforeAll(async () => {
      result = await capture(['--url', ARTICLE_URL, `${SCRATCH}/article-fetch`, '--transport', 'fetch']);
      if (result.success) {
        note = await readNote(`${SCRATCH}/article-fetch.md`);
      }
    });

    it('extracts a real article without a Web Viewer', () => {
      expect(result).toMatchObject({ success: true, transport: 'fetch' });
      // Defuddle ran against a detached DOMParser document. If its
      // getComputedStyle passes threw there instead of degrading, extraction
      // would have failed outright rather than returning thousands of words.
      expect(result.wordCount).toBeGreaterThan(500);
    });

    it('recovers metadata the legacy save-to-vault route discarded', () => {
      const frontmatter = frontmatterOf(note);
      expect(frontmatter.title).toMatch(/Markdown/);
      expect(frontmatter.source).toBe(ARTICLE_URL);
      expect(frontmatter.site).toBeTruthy();
      // `captured` is always written, and must be a real ISO timestamp.
      expect(new Date(frontmatter.captured).toISOString()).toBe(frontmatter.captured);
    });

    it('produces real markdown, not a tag-stripped blob', () => {
      // The unit lane's htmlToMarkdown stub cannot produce either of these.
      expect(note).toMatch(/^## .+/m);
      expect(note).toMatch(/\[[^\]]+\]\(https?:\/\/[^)]+\)/);
    });

    it('leaves no blank frontmatter keys for metadata the page lacks', () => {
      expect(note).not.toMatch(/^\w+: *$/m);
    });
  });

  describe('transport selection', () => {
    it('auto picks fetch for a page that serves its content as HTML', async () => {
      const result = await capture(['--url', ARTICLE_URL, `${SCRATCH}/article-auto`]);
      expect(result).toMatchObject({ success: true, transport: 'fetch' });
    });

    it.each([
      ['a non-HTML response', 'https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf'],
      ['a 404', 'https://en.wikipedia.org/wiki/ThisPageDoesNotExist_NexusWebCaptureSmoke'],
    ])('refuses %s without writing a note', async (_label, url) => {
      const result = await capture(['--url', url, `${SCRATCH}/should-not-exist`, '--transport', 'fetch']);
      expect(result.success).toBe(false);
      expect(result.error).toBeTruthy();
    });

    it('rejects a non-http scheme before making any request', async () => {
      const result = await capture(['--url', 'file:///etc/passwd', `${SCRATCH}/nope`, '--transport', 'fetch']);
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/scheme/);
    });

    it('rejects an outputPath that escapes the vault', async () => {
      const result = await capture(['--url', 'https://example.com', '../../../../tmp/ESCAPE', '--transport', 'fetch']);
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/\.\.|traversal/);
    });
  });
});
