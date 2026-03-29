/**
 * TextComposer — Markdown/text file concatenation.
 *
 * Located at: src/agents/apps/composer/services/TextComposer.ts
 * Pure string composition with frontmatter handling, file headers, and
 * configurable separators. Implements IFormatComposer. Zero dependencies.
 *
 * Used by: compose.ts tool when format='markdown'.
 */

import { Vault } from 'obsidian';
import { IFormatComposer, ComposeInput, ComposeOptions, ComposerError } from '../types';

export class TextComposer implements IFormatComposer {
  readonly supportedExtensions = ['md', 'txt', 'markdown'];
  readonly isAvailableOnPlatform = true;

  async compose(
    input: ComposeInput,
    vault: Vault,
    options: ComposeOptions
  ): Promise<string> {
    if (input.mode !== 'concat') {
      throw new ComposerError('Text composition only supports concat mode');
    }

    const files = input.files;
    const separator = options.separator ?? '\n---\n';
    const includeHeaders = options.includeHeaders ?? false;
    const headerLevel = options.headerLevel ?? 2;
    const frontmatterHandling = options.frontmatterHandling ?? 'first';

    const sections: string[] = [];
    let mergedFrontmatter: Record<string, unknown> = {};
    let isFirstFile = true;

    for (const file of files) {
      let content = await vault.read(file);

      const fmResult = extractFrontmatter(content);

      switch (frontmatterHandling) {
        case 'first':
          if (isFirstFile && fmResult.frontmatter) {
            // Keep first file's frontmatter intact in content
          } else {
            content = fmResult.body;
          }
          break;

        case 'merge':
          if (fmResult.frontmatter) {
            mergedFrontmatter = { ...mergedFrontmatter, ...fmResult.frontmatter };
          }
          content = fmResult.body;
          break;

        case 'strip':
          content = fmResult.body;
          break;
      }

      if (includeHeaders) {
        const heading = '#'.repeat(headerLevel) + ' ' + file.basename;
        content = heading + '\n\n' + content.trim();
      }

      sections.push(content.trim());
      isFirstFile = false;
    }

    let result = sections.join(separator);

    if (frontmatterHandling === 'merge' && Object.keys(mergedFrontmatter).length > 0) {
      const fmYaml = serializeFrontmatter(mergedFrontmatter);
      result = fmYaml + '\n' + result;
    }

    return result;
  }
}

/**
 * Extract YAML frontmatter from markdown content.
 * Uses a simple line-by-line parser — no YAML library dependency.
 * Handles the common case of simple key-value frontmatter.
 */
function extractFrontmatter(content: string): {
  frontmatter: Record<string, unknown> | null;
  body: string;
} {
  // Strip BOM if present
  const trimmed = content.replace(/^\uFEFF/, '');

  const match = trimmed.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return { frontmatter: null, body: trimmed };

  const body = trimmed.slice(match[0].length);
  const frontmatter: Record<string, unknown> = {};

  for (const line of match[1].split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx > 0) {
      const key = line.slice(0, colonIdx).trim();
      const value = line.slice(colonIdx + 1).trim();
      frontmatter[key] = value;
    }
  }

  return { frontmatter, body };
}

/**
 * Serialize a frontmatter object back to YAML format.
 */
function serializeFrontmatter(fm: Record<string, unknown>): string {
  const lines = Object.entries(fm).map(([k, v]) => `${k}: ${v}`);
  return '---\n' + lines.join('\n') + '\n---';
}
