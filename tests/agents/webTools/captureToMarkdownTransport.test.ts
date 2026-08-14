/**
 * Transport selection for `web capture-markdown` (design plan §6.3).
 *
 * The point of the redesign is that the cheap HTTP transport handles most pages
 * and the expensive browser one is a fallback, so these tests pin *which*
 * transport runs for a given response — including the mobile case, where the
 * browser transport does not exist and a fetch result must be returned rather
 * than a "desktop only" refusal.
 *
 * The extractor is stubbed: Defuddle needs a real DOM, which this environment
 * does not have. That is deliberate — the decision under test is the selection,
 * not the parse. Extraction quality is `tests/manual/web-capture-bakeoff.md`.
 */

import { Platform, __setRequestUrlMock } from 'obsidian';
import { CaptureToMarkdownTool } from '@/agents/apps/webTools/tools/captureToMarkdown';
import type { BaseAppAgent } from '@/agents/apps/BaseAppAgent';
import type { ExtractedWebPage, WebContentExtractor } from '@/agents/apps/webTools/services/WebContentExtractor';

interface FetchCall {
  url?: string;
  status: number;
  contentType?: string;
  body: string;
}

function page(overrides: Partial<ExtractedWebPage['metadata']> & { markdown?: string } = {}): ExtractedWebPage {
  const { markdown, ...metadata } = overrides;
  return {
    markdown: markdown ?? 'Extracted body text.',
    html: '<p>Extracted body text.</p>',
    metadata: {
      title: 'Title',
      description: null,
      author: null,
      published: null,
      site: null,
      domain: null,
      image: null,
      favicon: null,
      language: null,
      wordCount: 500,
      ...metadata,
    },
    extractorType: null,
    parseTimeMs: 1,
  };
}

/** Records what HTML it was handed and returns a canned extraction per call. */
function stubExtractor(results: ExtractedWebPage[]): { extractor: WebContentExtractor; htmlSeen: string[] } {
  const htmlSeen: string[] = [];
  let index = 0;
  const extractor = {
    extractFromHtml: (html: string) => {
      htmlSeen.push(html);
      return Promise.resolve(results[Math.min(index++, results.length - 1)]);
    },
    extractFromDocument: () => Promise.reject(new Error('not used')),
  } as unknown as WebContentExtractor;

  return { extractor, htmlSeen };
}

function makeAgent(): { agent: BaseAppAgent; created: Array<{ path: string; contents: string }> } {
  const created: Array<{ path: string; contents: string }> = [];
  const app = {
    vault: {
      getAbstractFileByPath: () => null,
      createFolder: () => Promise.resolve(),
      create: (path: string, contents: string) => {
        created.push({ path, contents });
        return Promise.resolve({ path });
      },
    },
  };

  return { agent: { getApp: () => app } as unknown as BaseAppAgent, created };
}

function mockFetch(call: FetchCall): { urls: string[] } {
  const urls: string[] = [];
  __setRequestUrlMock(async (request) => {
    urls.push(request.url ?? '');
    return {
      status: call.status,
      headers: call.contentType ? { 'Content-Type': call.contentType } : {},
      text: call.body,
      json: {},
      arrayBuffer: new ArrayBuffer(0),
    };
  });
  return { urls };
}

/**
 * The browser transport is gated on `isDesktop() && isElectron()`, i.e. on
 * `Platform` plus `process.versions.electron`. Jest is neither, so desktop has
 * to be simulated explicitly — which also means the default state of these
 * tests is the mobile one.
 */
function withElectron(present: boolean): () => void {
  const originalVersions = process.versions;
  const originalIsDesktop = Platform.isDesktop;
  const originalIsMobile = Platform.isMobile;

  Object.defineProperty(process, 'versions', {
    value: present ? { ...originalVersions, electron: '30.0.0' } : { ...originalVersions, electron: undefined },
    configurable: true,
  });
  Platform.isDesktop = present;
  Platform.isMobile = !present;

  return () => {
    Object.defineProperty(process, 'versions', { value: originalVersions, configurable: true });
    Platform.isDesktop = originalIsDesktop;
    Platform.isMobile = originalIsMobile;
  };
}

describe('capture-markdown transport selection', () => {
  let restorePlatform: () => void = () => undefined;

  afterEach(() => {
    restorePlatform();
    restorePlatform = () => undefined;
    __setRequestUrlMock(async () => ({
      status: 200,
      headers: {},
      text: '',
      json: {},
      arrayBuffer: new ArrayBuffer(0),
    }));
  });

  describe('on mobile, where only the fetch transport exists', () => {
    beforeEach(() => {
      restorePlatform = withElectron(false);
    });

    it('captures an ordinary article and writes it to the requested path', async () => {
      const { urls } = mockFetch({ status: 200, contentType: 'text/html', body: '<html><body>hi</body></html>' });
      const { extractor, htmlSeen } = stubExtractor([page({ title: 'Ordinary Article' })]);
      const { agent, created } = makeAgent();

      const result = await new CaptureToMarkdownTool(agent, extractor).execute({
        url: 'https://example.com/post',
        outputPath: 'captures/post',
      } as never);

      expect(result.success).toBe(true);
      expect(urls).toEqual(['https://example.com/post']);
      expect(htmlSeen).toEqual(['<html><body>hi</body></html>']);
      expect(created).toHaveLength(1);
      expect(created[0].path).toBe('captures/post.md');
      expect(created[0].contents).toContain('title: Ordinary Article');
      expect(created[0].contents).toContain('source: https://example.com/post');
      expect(created[0].contents).toContain('Extracted body text.');
      expect(result.data).toMatchObject({ path: 'captures/post.md', transport: 'fetch' });
    });

    it('keeps a thin fetch result instead of failing, because there is nothing to fall back to', async () => {
      // Under `auto` on desktop this word count would trigger the browser
      // transport. On mobile the fetch result is all there is.
      mockFetch({ status: 200, contentType: 'text/html', body: '<html></html>' });
      const { extractor } = stubExtractor([page({ wordCount: 3, markdown: 'Loading…' })]);
      const { agent, created } = makeAgent();

      const result = await new CaptureToMarkdownTool(agent, extractor).execute({
        url: 'https://spa.example.com',
        outputPath: 'captures/spa',
      } as never);

      expect(result.success).toBe(true);
      expect(result.data).toMatchObject({ transport: 'fetch' });
      expect(created).toHaveLength(1);
    });

    it('refuses the browser transport with an actionable message', async () => {
      const { extractor } = stubExtractor([page()]);
      const { agent, created } = makeAgent();

      const result = await new CaptureToMarkdownTool(agent, extractor).execute({
        url: 'https://example.com',
        outputPath: 'captures/x',
        transport: 'browser',
      } as never);

      expect(result.success).toBe(false);
      expect(result.error).toContain('fetch');
      expect(created).toHaveLength(0);
    });

    it('requires a url, since capturing the open tab needs a Web Viewer', async () => {
      const { extractor } = stubExtractor([page()]);
      const { agent } = makeAgent();

      const result = await new CaptureToMarkdownTool(agent, extractor).execute({
        outputPath: 'captures/x',
      } as never);

      expect(result.success).toBe(false);
      expect(result.error).toContain('url is required');
    });

    it.each([
      ['a 404', { status: 404, contentType: 'text/html', body: 'Not found' }],
      ['a PDF', { status: 200, contentType: 'application/pdf', body: '%PDF-1.4' }],
      ['an image', { status: 200, contentType: 'image/png', body: 'PNG' }],
    ])('reports %s as unretrievable without writing a note', async (_label, call) => {
      mockFetch(call as FetchCall);
      const { extractor, htmlSeen } = stubExtractor([page()]);
      const { agent, created } = makeAgent();

      const result = await new CaptureToMarkdownTool(agent, extractor).execute({
        url: 'https://example.com/file',
        outputPath: 'captures/x',
      } as never);

      expect(result.success).toBe(false);
      expect(htmlSeen).toHaveLength(0);
      expect(created).toHaveLength(0);
    });

    it('reports an empty extraction separately from an unreachable page', async () => {
      mockFetch({ status: 200, contentType: 'text/html', body: '<html></html>' });
      const { extractor } = stubExtractor([page({ markdown: '' })]);
      const { agent, created } = makeAgent();

      const result = await new CaptureToMarkdownTool(agent, extractor).execute({
        url: 'https://example.com',
        outputPath: 'captures/x',
      } as never);

      expect(result.success).toBe(false);
      expect(result.error).toContain('no readable content');
      expect(result.error).toContain('fetch');
      expect(created).toHaveLength(0);
    });

    it('rejects a non-http URL before any request is made', async () => {
      const { urls } = mockFetch({ status: 200, contentType: 'text/html', body: '<html></html>' });
      const { extractor } = stubExtractor([page()]);
      const { agent } = makeAgent();

      const result = await new CaptureToMarkdownTool(agent, extractor).execute({
        url: 'file:///etc/passwd',
        outputPath: 'captures/x',
      } as never);

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/scheme/);
      expect(urls).toHaveLength(0);
    });

    it('rejects an outputPath that escapes the vault, after fetching but before writing', async () => {
      mockFetch({ status: 200, contentType: 'text/html', body: '<html></html>' });
      const { extractor } = stubExtractor([page()]);
      const { agent, created } = makeAgent();

      const result = await new CaptureToMarkdownTool(agent, extractor).execute({
        url: 'https://example.com',
        outputPath: '../../../../tmp/ESCAPE',
      } as never);

      expect(result.success).toBe(false);
      expect(created).toHaveLength(0);
    });
  });

  describe('on desktop', () => {
    beforeEach(() => {
      restorePlatform = withElectron(true);
    });

    it('does not open a Web Viewer when the fetch result is substantial', async () => {
      mockFetch({ status: 200, contentType: 'text/html', body: '<html><body>article</body></html>' });
      const { extractor, htmlSeen } = stubExtractor([page({ wordCount: 900 })]);
      const { agent } = makeAgent();

      const result = await new CaptureToMarkdownTool(agent, extractor).execute({
        url: 'https://example.com/article',
        outputPath: 'captures/article',
      } as never);

      expect(result.success).toBe(true);
      expect(result.data).toMatchObject({ transport: 'fetch' });
      // One extraction only: the browser transport was never reached, so no
      // leaf was opened and the workspace was not mutated.
      expect(htmlSeen).toHaveLength(1);
    });

    it('falls back to the fetch result when the browser transport itself fails', async () => {
      // `auto` sees an SPA shell and tries the browser; there is no Obsidian
      // workspace in this environment, so that attempt throws. A thin capture
      // beats surfacing a Web Viewer error the caller never asked for.
      mockFetch({ status: 200, contentType: 'text/html', body: '<html></html>' });
      const { extractor } = stubExtractor([page({ wordCount: 4, markdown: 'Loading…' })]);
      const { agent, created } = makeAgent();

      const result = await new CaptureToMarkdownTool(agent, extractor).execute({
        url: 'https://spa.example.com',
        outputPath: 'captures/spa',
      } as never);

      expect(result.success).toBe(true);
      expect(result.data).toMatchObject({ transport: 'fetch' });
      expect(created[0].contents).toContain('Loading…');
    });

    it('surfaces the browser failure when there is no fetch result to fall back on', async () => {
      mockFetch({ status: 503, contentType: 'text/html', body: 'down' });
      const { extractor } = stubExtractor([page()]);
      const { agent, created } = makeAgent();

      const result = await new CaptureToMarkdownTool(agent, extractor).execute({
        url: 'https://spa.example.com',
        outputPath: 'captures/spa',
      } as never);

      expect(result.success).toBe(false);
      expect(created).toHaveLength(0);
    });

    it('honours transport "fetch" and never falls back, even on a shell', async () => {
      mockFetch({ status: 200, contentType: 'text/html', body: '<html></html>' });
      const { extractor, htmlSeen } = stubExtractor([page({ wordCount: 2, markdown: 'Loading…' })]);
      const { agent } = makeAgent();

      const result = await new CaptureToMarkdownTool(agent, extractor).execute({
        url: 'https://spa.example.com',
        outputPath: 'captures/spa',
        transport: 'fetch',
      } as never);

      expect(result.success).toBe(true);
      expect(result.data).toMatchObject({ transport: 'fetch' });
      expect(htmlSeen).toHaveLength(1);
    });

    it('rejects transport "fetch" without a url rather than silently using the open tab', async () => {
      const { extractor } = stubExtractor([page()]);
      const { agent } = makeAgent();

      const result = await new CaptureToMarkdownTool(agent, extractor).execute({
        outputPath: 'captures/x',
        transport: 'fetch',
      } as never);

      expect(result.success).toBe(false);
      expect(result.error).toContain('url is required');
    });

    it('respects a custom minWordCount when judging a shell', async () => {
      // 300 words clears the default threshold but not this one, so `auto`
      // must attempt the browser transport (which then fails, falling back).
      mockFetch({ status: 200, contentType: 'text/html', body: '<html></html>' });
      const { extractor, htmlSeen } = stubExtractor([page({ wordCount: 300 })]);
      const { agent } = makeAgent();

      const result = await new CaptureToMarkdownTool(agent, extractor).execute({
        url: 'https://example.com',
        outputPath: 'captures/x',
        minWordCount: 1000,
      } as never);

      expect(result.success).toBe(true);
      expect(result.data).toMatchObject({ transport: 'fetch' });
      expect(htmlSeen).toHaveLength(1);
    });
  });
});
