export interface SpeechTextChunk {
  text: string;
  index: number;
}

export interface SpeechPreprocessOptions {
  maxChunkChars?: number;
}

const DEFAULT_MAX_CHUNK_CHARS = 3600;
const MIN_TRAILING_CHUNK_CHARS = 240;

export class MarkdownSpeechPreprocessor {
  static preprocess(markdown: string, options: SpeechPreprocessOptions = {}): SpeechTextChunk[] {
    const maxChunkChars = Math.max(500, options.maxChunkChars ?? DEFAULT_MAX_CHUNK_CHARS);
    const speechText = this.toSpeechText(markdown);
    return this.chunkText(speechText, maxChunkChars);
  }

  static toSpeechText(markdown: string): string {
    const withoutFrontmatter = this.stripYamlFrontmatter(markdown);
    const withoutCodeBlocks = withoutFrontmatter.replace(
      /```[\s\S]*?```/g,
      '\nCode block omitted.\n'
    );

    const cleaned = withoutCodeBlocks
      .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/\[\[([^|\]]+)\|([^\]]+)\]\]/g, '$2')
      .replace(/\[\[([^\]]+)\]\]/g, '$1')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/^#{1,6}\s+/gm, '')
      .replace(/^\s*[-*+]\s+/gm, '')
      .replace(/^\s*\d+\.\s+/gm, '')
      .replace(/^\s*>\s?/gm, '')
      .replace(/^\s*\|?(?:\s*:?-{2,}:?\s*\|)+\s*$/gm, '')
      .replace(/\|/g, ' ')
      .replace(/[*_~]{1,3}/g, '')
      .replace(/\r/g, '\n')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    return cleaned;
  }

  static stripYamlFrontmatter(markdown: string): string {
    if (!markdown.startsWith('---')) {
      return markdown;
    }

    const lines = markdown.split(/\r?\n/);
    if (lines[0].trim() !== '---') {
      return markdown;
    }

    for (let index = 1; index < lines.length; index += 1) {
      if (lines[index].trim() === '---') {
        return lines.slice(index + 1).join('\n').trimStart();
      }
    }

    return markdown;
  }

  private static chunkText(text: string, maxChunkChars: number): SpeechTextChunk[] {
    const normalized = text.replace(/\s+/g, ' ').trim();
    if (!normalized) {
      return [];
    }

    const chunks: string[] = [];
    let remaining = normalized;

    while (remaining.length > maxChunkChars) {
      const splitIndex = this.findSplitIndex(remaining, maxChunkChars);
      chunks.push(remaining.slice(0, splitIndex).trim());
      remaining = remaining.slice(splitIndex).trim();
    }

    if (remaining.length > 0) {
      if (chunks.length > 0 && remaining.length < MIN_TRAILING_CHUNK_CHARS) {
        const previous = chunks.pop() ?? '';
        chunks.push(`${previous} ${remaining}`.trim());
      } else {
        chunks.push(remaining);
      }
    }

    return chunks.map((chunk, index) => ({ text: chunk, index }));
  }

  private static findSplitIndex(text: string, maxChunkChars: number): number {
    const candidates = ['. ', '? ', '! ', '\n\n', '; ', ', ', ' '];
    for (const candidate of candidates) {
      const index = text.lastIndexOf(candidate, maxChunkChars);
      if (index > Math.floor(maxChunkChars * 0.55)) {
        return index + candidate.length;
      }
    }

    return maxChunkChars;
  }
}
