/**
 * Regression tests: the webTools capture boundary confines the caller-supplied
 * outputPath to the vault. `resolveUniqueFilePath` is the shared chokepoint for
 * capturePagePdf / capturePagePng / captureToMarkdown.
 * See docs/plans/vault-path-confinement-plan.md.
 */

import { resolveUniqueFilePath, resolveUniqueMarkdownPath } from '@/agents/apps/webTools/utils/webViewer';

const ESCAPING = ['../../../../tmp/ESCAPE', '/tmp/ESCAPE', '~/ESCAPE'];

function makeVault(): any {
  return { getAbstractFileByPath: jest.fn().mockReturnValue(null) };
}

describe('resolveUniqueFilePath confinement', () => {
  it.each(ESCAPING)('throws for escaping outputPath %s', (outputPath) => {
    expect(() => resolveUniqueFilePath(makeVault(), outputPath, 'pdf')).toThrow();
  });

  it('returns a confined path for a normal outputPath', () => {
    expect(resolveUniqueFilePath(makeVault(), 'captures/page', 'pdf')).toBe('captures/page.pdf');
  });

  it('markdown variant is also confined', () => {
    expect(() => resolveUniqueMarkdownPath(makeVault(), '../../ESCAPE')).toThrow();
    expect(resolveUniqueMarkdownPath(makeVault(), 'captures/page')).toBe('captures/page.md');
  });
});
