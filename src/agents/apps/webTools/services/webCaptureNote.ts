import { stringifyYaml } from 'obsidian';
import type { WebPageMetadata } from './WebContentExtractor';

export type WebCaptureTransport = 'fetch' | 'browser';

/**
 * Build the note body for a captured page: YAML frontmatter carrying the
 * metadata Defuddle recovered, followed by the article markdown.
 *
 * Keys whose value is null or empty are omitted rather than written blank, so a
 * page with no byline does not gain an `author:` key that Dataview would then
 * treat as present-but-empty.
 */
export function buildCaptureNote(
  markdown: string,
  metadata: WebPageMetadata,
  sourceUrl: string | null,
  capturedAtIso: string
): string {
  const frontmatter: Record<string, string> = {};

  assign(frontmatter, 'title', metadata.title);
  assign(frontmatter, 'source', sourceUrl);
  assign(frontmatter, 'author', metadata.author);
  assign(frontmatter, 'published', metadata.published);
  assign(frontmatter, 'site', metadata.site);
  assign(frontmatter, 'description', metadata.description);
  assign(frontmatter, 'language', metadata.language);
  assign(frontmatter, 'image', metadata.image);
  frontmatter.captured = capturedAtIso;

  const body = markdown.trim();
  return `---\n${stringifyYaml(frontmatter)}---\n\n${body}${body ? '\n' : ''}`;
}

/**
 * Whether an HTTP response is worth handing to the extractor.
 *
 * A non-2xx status or a non-HTML content type means the fetch transport cannot
 * produce an article, and the caller should fall back to the browser transport
 * (design plan §6.3).
 */
export function isExtractableResponse(status: number, contentType: string | undefined): boolean {
  if (status < 200 || status >= 300) {
    return false;
  }

  if (!contentType) {
    // Servers that omit Content-Type are rare; attempting extraction and
    // getting an empty article is a better failure than refusing outright.
    return true;
  }

  const mime = contentType.split(';')[0].trim().toLowerCase();
  return mime === 'text/html' || mime === 'application/xhtml+xml' || mime === 'text/plain';
}

/**
 * Read `content-type` from a header map without assuming its casing.
 *
 * `requestUrl` lowercases header names on desktop but this is not contractual,
 * and the browser transport supplies no headers at all.
 */
export function readContentType(headers: Record<string, string> | undefined): string | undefined {
  if (!headers) {
    return undefined;
  }

  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === 'content-type') {
      return value;
    }
  }

  return undefined;
}

/**
 * The SPA-shell signal.
 *
 * A client-rendered page served to a plain HTTP fetch returns its loading
 * shell: valid HTML, almost no prose. Word count is the cheapest reliable
 * discriminator, so a result under the threshold is treated as "the fetch
 * transport did not really get this page".
 */
export function looksLikeEmptyShell(wordCount: number, minWordCount: number): boolean {
  return wordCount < minWordCount;
}

function assign(target: Record<string, string>, key: string, value: string | null): void {
  const trimmed = value?.trim();
  if (trimmed) {
    target[key] = trimmed;
  }
}
