/**
 * Frontmatter assembly and transport-selection signals for `web capture-markdown`.
 *
 * These are the parts of the Defuddle capture pipeline that hold no DOM: what
 * lands in the note's frontmatter, whether an HTTP response is worth extracting,
 * and what counts as a JavaScript-rendered shell. The Defuddle parse itself
 * needs a real DOM and is covered by `tests/manual/web-capture-bakeoff.md`.
 */

import { parseYaml } from 'obsidian';
import {
  buildCaptureNote,
  isExtractableResponse,
  looksLikeEmptyShell,
  readContentType,
} from '@/agents/apps/webTools/services/webCaptureNote';
import type { WebPageMetadata } from '@/agents/apps/webTools/services/WebContentExtractor';

const EMPTY_METADATA: WebPageMetadata = {
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
};

function frontmatterOf(note: string): Record<string, unknown> {
  const match = /^---\n([\s\S]*?)\n?---\n/.exec(note);
  if (!match) {
    throw new Error(`No frontmatter block in note:\n${note}`);
  }
  return (parseYaml(match[1]) ?? {}) as Record<string, unknown>;
}

function bodyOf(note: string): string {
  return note.replace(/^---\n[\s\S]*?\n?---\n/, '').trim();
}

describe('buildCaptureNote', () => {
  const capturedAt = '2026-08-14T10:00:00.000Z';

  it('writes the metadata Defuddle recovered as parseable frontmatter', () => {
    const note = buildCaptureNote(
      'Body text.',
      {
        ...EMPTY_METADATA,
        title: 'A Study in Scarlet',
        author: 'Arthur Conan Doyle',
        published: '1887-11-01',
        site: 'Beeton',
        description: 'The first Holmes novel.',
        language: 'en',
        image: 'https://example.com/cover.png',
        wordCount: 43000,
      },
      'https://example.com/scarlet',
      capturedAt
    );

    expect(frontmatterOf(note)).toEqual({
      title: 'A Study in Scarlet',
      source: 'https://example.com/scarlet',
      author: 'Arthur Conan Doyle',
      published: '1887-11-01',
      site: 'Beeton',
      description: 'The first Holmes novel.',
      language: 'en',
      image: 'https://example.com/cover.png',
      captured: capturedAt,
    });
    expect(bodyOf(note)).toBe('Body text.');
  });

  it('omits keys the page did not supply rather than writing them blank', () => {
    const note = buildCaptureNote(
      'Body.',
      { ...EMPTY_METADATA, title: 'Untitled Post' },
      'https://example.com/post',
      capturedAt
    );

    const frontmatter = frontmatterOf(note);
    expect(Object.keys(frontmatter).sort()).toEqual(['captured', 'source', 'title']);
    expect(frontmatter).not.toHaveProperty('author');
  });

  it('treats whitespace-only metadata as absent', () => {
    const note = buildCaptureNote(
      'Body.',
      { ...EMPTY_METADATA, author: '   ', title: '  Trimmed  ' },
      null,
      capturedAt
    );

    const frontmatter = frontmatterOf(note);
    expect(frontmatter).not.toHaveProperty('author');
    expect(frontmatter).not.toHaveProperty('source');
    expect(frontmatter.title).toBe('Trimmed');
  });

  it('escapes values that would otherwise break the YAML block', () => {
    // A colon-space in a title is the classic frontmatter corruptor, and page
    // titles are attacker-influenced text we never sanitize ourselves.
    const note = buildCaptureNote(
      'Body.',
      {
        ...EMPTY_METADATA,
        title: 'Rust: a retrospective',
        description: 'He said "hello"\nthen left',
        author: '- not a list item',
      },
      'https://example.com/x',
      capturedAt
    );

    const frontmatter = frontmatterOf(note);
    expect(frontmatter.title).toBe('Rust: a retrospective');
    expect(frontmatter.description).toBe('He said "hello"\nthen left');
    expect(frontmatter.author).toBe('- not a list item');
  });

  it('produces a valid note when extraction found metadata but no body', () => {
    const note = buildCaptureNote('', { ...EMPTY_METADATA, title: 'Empty' }, 'https://example.com', capturedAt);

    expect(frontmatterOf(note).title).toBe('Empty');
    expect(bodyOf(note)).toBe('');
  });
});

describe('isExtractableResponse', () => {
  it.each([
    ['text/html; charset=utf-8', true],
    ['text/html', true],
    ['application/xhtml+xml', true],
    ['text/plain', true],
    ['application/pdf', false],
    ['image/png', false],
    ['application/json', false],
  ])('content type %s -> %s', (contentType, expected) => {
    expect(isExtractableResponse(200, contentType)).toBe(expected);
  });

  it.each([301, 404, 429, 500])('rejects status %s regardless of content type', (status) => {
    expect(isExtractableResponse(status, 'text/html')).toBe(false);
  });

  it('accepts a 2xx response with no content type at all', () => {
    expect(isExtractableResponse(204, undefined)).toBe(true);
  });
});

describe('readContentType', () => {
  it('finds the header whatever its casing', () => {
    expect(readContentType({ 'Content-Type': 'text/html' })).toBe('text/html');
    expect(readContentType({ 'content-type': 'text/html' })).toBe('text/html');
    expect(readContentType({ 'CONTENT-TYPE': 'text/html' })).toBe('text/html');
  });

  it('returns undefined when absent or unavailable', () => {
    expect(readContentType({ 'x-other': 'v' })).toBeUndefined();
    expect(readContentType(undefined)).toBeUndefined();
  });
});

describe('looksLikeEmptyShell', () => {
  it('flags a word count under the threshold and clears one at it', () => {
    expect(looksLikeEmptyShell(12, 100)).toBe(true);
    expect(looksLikeEmptyShell(100, 100)).toBe(false);
    expect(looksLikeEmptyShell(101, 100)).toBe(false);
  });

  it('never flags anything when the threshold is zero', () => {
    expect(looksLikeEmptyShell(0, 0)).toBe(false);
  });
});
