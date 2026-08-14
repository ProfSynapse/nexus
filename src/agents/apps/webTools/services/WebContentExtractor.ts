import { htmlToMarkdown, requestUrl } from 'obsidian';

/**
 * Page metadata Defuddle recovers alongside the article body.
 *
 * Every field is nullable: Defuddle returns `''` for anything it could not find,
 * and an empty string in frontmatter is worse than an absent key.
 */
export interface WebPageMetadata {
  title: string | null;
  description: string | null;
  author: string | null;
  published: string | null;
  site: string | null;
  domain: string | null;
  image: string | null;
  favicon: string | null;
  language: string | null;
  wordCount: number;
}

export interface ExtractedWebPage {
  /** Article body converted with Obsidian's own `htmlToMarkdown`. */
  markdown: string;
  /** Cleaned article HTML as Defuddle emitted it, before conversion. */
  html: string;
  metadata: WebPageMetadata;
  /** Site-specific extractor Defuddle matched, if any (e.g. `youtube`). */
  extractorType: string | null;
  parseTimeMs: number;
}

/**
 * Subset of the Defuddle response we consume. Declared locally rather than
 * imported so this module has no top-level dependency on the package — see
 * `loadDefuddle` below for why that matters.
 */
export interface DefuddleResponseLike {
  content?: string;
  title?: string;
  description?: string;
  author?: string;
  published?: string;
  site?: string;
  domain?: string;
  image?: string;
  favicon?: string;
  language?: string;
  wordCount?: number;
  parseTime?: number;
  extractorType?: string;
}

interface DefuddleLike {
  parseAsync(): Promise<DefuddleResponseLike>;
}

type DefuddleConstructor = new (doc: Document, options?: Record<string, unknown>) => DefuddleLike;

/**
 * Minimal `fetch` surface Defuddle's async extractors use: `ok`, `status`,
 * `text()` and `json()`. Nothing else is called.
 */
interface FetchLikeResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
}

let defuddleModulePromise: Promise<DefuddleConstructor> | null = null;

/**
 * Load Defuddle lazily.
 *
 * The package's browser entry pulls in no Node built-ins (they live only in its
 * `fetch`/`cli` entries, which nothing here reaches), but per the mobile rules a
 * heavy dependency is still imported inside a function rather than at module
 * top level. The promise is memoized so repeated captures parse the module once.
 */
async function loadDefuddle(): Promise<DefuddleConstructor> {
  if (!defuddleModulePromise) {
    defuddleModulePromise = import('defuddle')
      .then((module) => (module.default ?? module) as unknown as DefuddleConstructor)
      .catch((error) => {
        defuddleModulePromise = null;
        throw error;
      });
  }

  return defuddleModulePromise;
}

/**
 * A `fetch`-shaped function backed by Obsidian's `requestUrl`.
 *
 * Defuddle's async extractors (YouTube transcripts, Reddit comments, oEmbed)
 * call `options.fetch ?? globalThis.fetch`. Handing them `requestUrl` keeps the
 * plugin on the sanctioned transport — no CORS, and no bare `fetch()` anywhere
 * in the capture path.
 *
 * `signal` and `credentials` are dropped because `requestUrl` supports neither;
 * the consequence is that an extractor's own timeout no longer aborts the
 * request early, and cookie-authenticated extractor calls are anonymous.
 */
export const requestUrlFetch = async (
  input: string | { toString(): string },
  init?: { method?: string; headers?: Record<string, string>; body?: string }
): Promise<FetchLikeResponse> => {
  const response = await requestUrl({
    url: typeof input === 'string' ? input : String(input),
    method: init?.method ?? 'GET',
    headers: init?.headers,
    body: init?.body,
    // Return non-2xx instead of throwing: Defuddle branches on `.ok`.
    throw: false,
  });

  return {
    ok: response.status >= 200 && response.status < 300,
    status: response.status,
    text: () => Promise.resolve(response.text),
    // `requestUrl`'s `json` is a parsing getter, so it must stay lazy: touching
    // it on a non-JSON body throws, and callers that only want text() must not
    // pay for that.
    json: (): Promise<unknown> => {
      try {
        return Promise.resolve(response.json as unknown);
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
    },
  };
};

/**
 * The single Defuddle call site.
 *
 * Both capture transports — an HTTP fetch and a live browser DOM — hand this
 * service HTML and get back markdown plus metadata. Keeping the library behind
 * one class means a 0.x API break touches one file (design plan §9).
 */
export class WebContentExtractor {
  /**
   * Parse a full HTML document string into an article.
   *
   * The resulting `DOMParser` document has `defaultView === null`, so Defuddle's
   * `getComputedStyle`-based passes (hidden elements, small images) no-op. Its
   * selector- and score-based cleanup is unaffected, so extraction still works;
   * CSS-hidden clutter can survive. See `LIVE_DOM_CAPTURE_SCRIPT` for how the
   * browser transport compensates.
   */
  async extractFromHtml(html: string, url?: string): Promise<ExtractedWebPage> {
    return this.extractFromDocument(parseHtmlDocument(html), url);
  }

  async extractFromDocument(doc: Document, url?: string): Promise<ExtractedWebPage> {
    const Defuddle = await loadDefuddle();
    // Defuddle mutates the document it is given. Every caller here passes a
    // freshly parsed one, so there is nothing live to damage.
    const result = await new Defuddle(doc, {
      url,
      fetch: requestUrlFetch,
    }).parseAsync();

    return toExtractedWebPage(result);
  }
}

/**
 * Map a Defuddle response onto our own shape.
 *
 * Split out from the extractor so it can be tested without a DOM: Defuddle
 * reports "not found" as `''`, and an empty string reaching frontmatter is a
 * key that looks present but says nothing.
 */
export function toExtractedWebPage(result: DefuddleResponseLike): ExtractedWebPage {
  const html = result.content ?? '';

  return {
    markdown: html ? htmlToMarkdown(html).trim() : '',
    html,
    metadata: {
      title: emptyToNull(result.title),
      description: emptyToNull(result.description),
      author: emptyToNull(result.author),
      published: emptyToNull(result.published),
      site: emptyToNull(result.site),
      domain: emptyToNull(result.domain),
      image: emptyToNull(result.image),
      favicon: emptyToNull(result.favicon),
      language: emptyToNull(result.language),
      wordCount: typeof result.wordCount === 'number' ? result.wordCount : 0,
    },
    extractorType: emptyToNull(result.extractorType),
    parseTimeMs: typeof result.parseTime === 'number' ? result.parseTime : 0,
  };
}

/**
 * Parse HTML into a detached document.
 *
 * `DOMParser` is a web standard present in both Electron and the mobile
 * webview, so this needs no platform guard.
 */
export function parseHtmlDocument(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html');
}

function emptyToNull(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}
