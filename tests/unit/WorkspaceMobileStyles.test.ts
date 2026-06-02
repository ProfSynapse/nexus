/**
 * Workspace Mobile / Tap-Target Style Presence Guards (Wave 3 PR4)
 *
 * The plan's Visual Regression Strategy is MANUAL (no pixel-diff pipeline) but
 * endorses a "cheap DOM-snapshot for attribute presence". Since the layout is
 * driven entirely by styles.css (the project's non-negotiable "all styles in
 * styles.css, never inline"), the cheapest automatable VR guard is a
 * presence-scan of the load-bearing mobile/tap-target rules. These assert the
 * RULES EXIST — they cannot validate rendered pixels (that stays manual, see
 * the HANDOFF's manual-VR checklist).
 *
 * If a future edit deletes one of these blocks, this guard fails loudly and
 * points at the specific responsive affordance that regressed.
 *
 * Pure-Node fs read; CI/Windows-portable.
 */

import { promises as fs } from 'fs';
import * as path from 'path';

const STYLES_FILE = path.resolve(__dirname, '..', '..', 'styles.css');

async function readStyles(): Promise<string> {
  return fs.readFile(STYLES_FILE, 'utf8');
}

/** Extract the body of a CSS rule/at-rule by brace-matching from a header. */
function blockAfter(css: string, header: string): string {
  const start = css.indexOf(header);
  if (start === -1) return '';
  const open = css.indexOf('{', start);
  if (open === -1) return '';
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}') {
      depth--;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  return '';
}

describe('Workspace mobile / tap-target style guards (PR4 VR-lite)', () => {
  describe('.ws-section-action tap-target padding', () => {
    it('declares a 6px / var(--space-m) padding floor (~30px tall, WCAG 2.5.5)', async () => {
      const css = await readStyles();
      const body = blockAfter(css, '.ws-section-action {');
      expect(body).toMatch(/padding:\s*6px\s+var\(--space-m\)/);
    });
  });

  describe('.ws-tree-row clamp() per-depth indent', () => {
    it('uses a clamp()-bounded indent step so deep trees do not overflow narrow viewports', async () => {
      const css = await readStyles();
      // The depth-0 / depth-1 rows establish the clamp() step.
      expect(css).toMatch(/\.ws-tree-row\[data-depth="1"\][\s\S]*?clamp\(10px,\s*5vw,\s*20px\)/);
    });

    it('scales the indent multiplicatively for deeper levels (depth 2 = step × 2)', async () => {
      const css = await readStyles();
      expect(css).toMatch(/\.ws-tree-row\[data-depth="2"\][\s\S]*?clamp\(10px,\s*5vw,\s*20px\)\s*\*\s*2/);
    });
  });

  describe('@media (max-width: 480px) mobile breakpoint', () => {
    it('exists and collapses .ws-field-grid to a single column', async () => {
      const css = await readStyles();
      const body = blockAfter(css, '@media (max-width: 480px) {');
      expect(body).not.toBe('');
      expect(body).toMatch(/\.ws-field-grid\s*\{[\s\S]*?grid-template-columns:\s*1fr/);
    });

    it('drops the .ws-section-body internal scroll on mobile (max-height: none)', async () => {
      const css = await readStyles();
      const body = blockAfter(css, '@media (max-width: 480px) {');
      expect(body).toMatch(/\.ws-section-body\s*\{[\s\S]*?max-height:\s*none[\s\S]*?overflow:\s*visible/);
    });

    it('drops the .ws-tree internal scroll on mobile (max-height: none)', async () => {
      const css = await readStyles();
      const body = blockAfter(css, '@media (max-width: 480px) {');
      expect(body).toMatch(/\.ws-tree\s*\{[\s\S]*?max-height:\s*none[\s\S]*?overflow:\s*visible/);
    });
  });

  describe('@supports sticky-header graceful degradation', () => {
    it('falls back to position: static when sticky is unsupported (older iOS WebView)', async () => {
      const css = await readStyles();
      const body = blockAfter(css, '@supports not (position: sticky) {');
      expect(body).not.toBe('');
      expect(body).toMatch(/\.ws-section-header\s*\{[\s\S]*?position:\s*static/);
    });
  });

  describe('legacy .nexus-tree-* CSS removed (no dead orphans)', () => {
    it('contains no .nexus-tree-* selectors after the .ws-tree rename', async () => {
      const css = await readStyles();
      const lines = css.split(/\r?\n/);
      const hits = lines
        .map((line, i) => ({ line: i + 1, text: line.trim() }))
        .filter(h => /\.nexus-tree-/.test(h.text));
      if (hits.length > 0) {
        const summary = hits.map(h => `  styles.css:${h.line} → ${h.text}`).join('\n');
        throw new Error(`Legacy .nexus-tree-* CSS still present (should have been removed in PR4):\n${summary}`);
      }
      expect(hits).toEqual([]);
    });
  });
});
