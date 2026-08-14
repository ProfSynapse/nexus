/**
 * The DOM-free halves of the extractor: how a Defuddle response is mapped onto
 * our own shape, and the `requestUrl`-backed `fetch` shim handed to Defuddle's
 * async extractors.
 *
 * The Defuddle parse itself needs a real DOM (this suite runs on the `node`
 * environment) and is covered by `tests/manual/web-capture-bakeoff.md`. Note
 * that `htmlToMarkdown` here is a tag-stripping stub — these tests assert the
 * plumbing around it, never conversion fidelity.
 */

import { __setRequestUrlMock } from 'obsidian';
import { requestUrlFetch, toExtractedWebPage } from '@/agents/apps/webTools/services/WebContentExtractor';
import { toLiveDomSnapshot } from '@/agents/apps/webTools/services/liveDomCapture';

describe('toExtractedWebPage', () => {
  it('carries metadata across and converts the cleaned HTML', () => {
    const page = toExtractedWebPage({
      content: '<p>Hello world</p>',
      title: 'Post',
      author: 'Ada',
      published: '2026-01-02',
      site: 'Example',
      domain: 'example.com',
      description: 'A post',
      language: 'en',
      image: 'https://example.com/i.png',
      favicon: 'https://example.com/f.ico',
      wordCount: 2,
      parseTime: 12,
      extractorType: 'article',
    });

    expect(page.markdown).toBe('Hello world');
    expect(page.html).toBe('<p>Hello world</p>');
    expect(page.metadata.title).toBe('Post');
    expect(page.metadata.author).toBe('Ada');
    expect(page.metadata.domain).toBe('example.com');
    expect(page.metadata.wordCount).toBe(2);
    expect(page.extractorType).toBe('article');
    expect(page.parseTimeMs).toBe(12);
  });

  it('maps Defuddle\'s "not found" empty strings to null', () => {
    // Defuddle returns '' rather than omitting a field it could not resolve.
    // Passing that straight through would put empty keys in frontmatter.
    const page = toExtractedWebPage({
      content: '<p>x</p>',
      title: '',
      author: '   ',
      published: '',
      site: '',
      domain: '',
      description: '',
      language: '',
      image: '',
      favicon: '',
      extractorType: '',
    });

    expect(page.metadata).toEqual({
      title: null,
      description: null,
      author: null,
      published: null,
      site: null,
      domain: null,
      image: null,
      favicon: null,
      language: null,
      wordCount: 0,
    });
    expect(page.extractorType).toBeNull();
  });

  it('yields empty markdown when extraction found no content', () => {
    expect(toExtractedWebPage({}).markdown).toBe('');
    expect(toExtractedWebPage({ content: '' }).markdown).toBe('');
    expect(toExtractedWebPage({}).parseTimeMs).toBe(0);
  });
});

describe('requestUrlFetch', () => {
  afterEach(() => {
    __setRequestUrlMock(async () => ({
      status: 200,
      headers: {},
      text: '',
      json: {},
      arrayBuffer: new ArrayBuffer(0),
    }));
  });

  it('passes method, headers and body through to requestUrl and never throws on non-2xx', async () => {
    const seen: unknown[] = [];
    __setRequestUrlMock(async (request) => {
      seen.push(request);
      return { status: 404, headers: {}, text: 'nope', json: {}, arrayBuffer: new ArrayBuffer(0) };
    });

    const response = await requestUrlFetch('https://api.example.com/x', {
      method: 'POST',
      headers: { Accept: 'application/json' },
      body: '{"a":1}',
    });

    expect(seen[0]).toMatchObject({
      url: 'https://api.example.com/x',
      method: 'POST',
      headers: { Accept: 'application/json' },
      body: '{"a":1}',
      // Defuddle's extractors branch on `.ok`, so a 404 must come back as a
      // value rather than as a thrown error.
      throw: false,
    });
    expect(response.ok).toBe(false);
    expect(response.status).toBe(404);
    await expect(response.text()).resolves.toBe('nope');
  });

  it.each([
    [200, true],
    [204, true],
    [299, true],
    [300, false],
    [500, false],
  ])('reports status %s as ok=%s', async (status, ok) => {
    __setRequestUrlMock(async () => ({
      status,
      headers: {},
      text: '',
      json: {},
      arrayBuffer: new ArrayBuffer(0),
    }));

    expect((await requestUrlFetch('https://example.com')).ok).toBe(ok);
  });

  it('defaults to GET and accepts a URL object', async () => {
    const seen: unknown[] = [];
    __setRequestUrlMock(async (request) => {
      seen.push(request);
      return { status: 200, headers: {}, text: 'ok', json: {}, arrayBuffer: new ArrayBuffer(0) };
    });

    await requestUrlFetch(new URL('https://example.com/path?q=1'));

    expect(seen[0]).toMatchObject({ url: 'https://example.com/path?q=1', method: 'GET' });
  });

  it('does not parse the body as JSON unless json() is called', async () => {
    // `requestUrl`'s `json` is a parsing getter: touching it eagerly would make
    // every HTML fetch throw before the caller ever asked for JSON.
    let jsonReads = 0;
    __setRequestUrlMock(async () => ({
      status: 200,
      headers: {},
      text: '<html></html>',
      get json(): unknown {
        jsonReads += 1;
        throw new SyntaxError('Unexpected token < in JSON');
      },
      arrayBuffer: new ArrayBuffer(0),
    }));

    const response = await requestUrlFetch('https://example.com');
    expect(jsonReads).toBe(0);

    await expect(response.text()).resolves.toBe('<html></html>');
    expect(jsonReads).toBe(0);

    // And when it is called, the parse failure arrives as a rejection rather
    // than as a synchronous throw out of the shim.
    await expect(response.json()).rejects.toThrow(SyntaxError);
    expect(jsonReads).toBe(1);
  });
});

describe('toLiveDomSnapshot', () => {
  it('accepts a well-formed snapshot', () => {
    expect(toLiveDomSnapshot({ html: '<html></html>', url: 'https://e.com', title: 'T' })).toEqual({
      html: '<html></html>',
      url: 'https://e.com',
      title: 'T',
    });
  });

  it('defaults url and title when the page did not supply them', () => {
    expect(toLiveDomSnapshot({ html: '<html></html>' })).toEqual({
      html: '<html></html>',
      url: '',
      title: '',
    });
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'not an object'],
    ['a snapshot with no html', { url: 'https://e.com' }],
    ['a snapshot with blank html', { html: '   ' }],
    ['a snapshot with non-string html', { html: 42 }],
  ])('rejects %s', (_label, value) => {
    expect(toLiveDomSnapshot(value)).toBeNull();
  });
});
