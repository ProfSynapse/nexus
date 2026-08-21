/**
 * Chat message spacing style guards.
 *
 * Regression covered: on desktop, assistant replies were separated from the
 * preceding user message by a 1.4rem top margin, while the mid-stream thinking
 * ticker sat directly against the assistant's last line of text.
 *
 * These checks read the shipped stylesheet directly. If either load-bearing
 * spacing declaration is removed or widened again, this suite fails without an
 * Obsidian DOM mock deciding the result.
 */

import { promises as fs } from 'fs';
import * as path from 'path';

const STYLES_FILE = path.resolve(__dirname, '..', '..', 'styles.css');

async function readStyles(): Promise<string> {
  return fs.readFile(STYLES_FILE, 'utf8');
}

function ruleBody(css: string, selector: string): string {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`${escapedSelector}\\s*\\{([^}]*)\\}`));
  return match?.[1] ?? '';
}

describe('Desktop chat message spacing', () => {
  it('uses the compact spacing token before assistant messages', async () => {
    const css = await readStyles();
    const body = ruleBody(css, '.message-container.message-assistant');

    expect(body).toMatch(/margin-top:\s*var\(--space-s\)/);
  });

  it('separates a continuation ticker only when it follows rendered content', async () => {
    const css = await readStyles();
    const body = ruleBody(
      css,
      '.message-content > .ai-loading-continuation:not(:first-child)'
    );

    expect(body).toMatch(/margin-top:\s*var\(--space-s\)/);
  });
});
