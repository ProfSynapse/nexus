import { MarkdownSpeechPreprocessor } from '../../src/services/readAloud/MarkdownSpeechPreprocessor';

describe('MarkdownSpeechPreprocessor', () => {
  it('strips YAML frontmatter automatically', () => {
    const text = MarkdownSpeechPreprocessor.toSpeechText([
      '---',
      'title: Secret metadata',
      'tags:',
      '  - hidden',
      '---',
      '# Visible note',
      'Read this part.'
    ].join('\n'));

    expect(text).toContain('Visible note');
    expect(text).toContain('Read this part.');
    expect(text).not.toContain('Secret metadata');
    expect(text).not.toContain('tags');
  });

  it('keeps malformed frontmatter as readable content', () => {
    const text = MarkdownSpeechPreprocessor.toSpeechText([
      '---',
      'title: Still content',
      '# Note'
    ].join('\n'));

    expect(text).toContain('title: Still content');
    expect(text).toContain('Note');
  });

  it('removes common markdown syntax while keeping useful text', () => {
    const text = MarkdownSpeechPreprocessor.toSpeechText([
      '# Heading',
      '- **Important** [link text](https://example.com)',
      '[[Daily Note|today]] and `inline code`',
      '```ts',
      'const hidden = true;',
      '```'
    ].join('\n'));

    expect(text).toContain('Heading');
    expect(text).toContain('Important link text');
    expect(text).toContain('today and inline code');
    expect(text).toContain('Code block omitted.');
    expect(text).not.toContain('const hidden');
    expect(text).not.toContain('https://example.com');
  });

  it('chunks long text on sentence boundaries', () => {
    const first = 'First sentence has enough words to make a useful speech chunk and it keeps going with supporting context for the listener.';
    const second = 'Second sentence also has enough words to stand on its own while preserving a natural pause for audio playback.';
    const third = 'Third sentence is the final part of this note and should remain readable after chunking.';
    const paragraph = [first, second, third].join(' ');
    const chunks = MarkdownSpeechPreprocessor.preprocess(
      [paragraph, paragraph, paragraph, paragraph].join(' '),
      { maxChunkChars: 520 }
    );

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0].text.endsWith('.')).toBe(true);
    expect(chunks[0].text.length).toBeLessThanOrEqual(520);
  });

  it('returns no chunks for notes with no readable text', () => {
    const chunks = MarkdownSpeechPreprocessor.preprocess([
      '---',
      'title: Metadata only',
      '---'
    ].join('\n'));

    expect(chunks).toEqual([]);
  });
});
