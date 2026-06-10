import { assertSafeWebUrl } from '../../src/agents/apps/webTools/utils/webViewer';

describe('assertSafeWebUrl', () => {
  it('accepts http and https URLs', () => {
    expect(() => assertSafeWebUrl('http://example.com')).not.toThrow();
    expect(() => assertSafeWebUrl('https://example.com/page?q=1')).not.toThrow();
    // localhost is intentionally allowed (user-visible web viewer, local dev servers).
    expect(() => assertSafeWebUrl('http://localhost:3000')).not.toThrow();
  });

  it('rejects non-http(s) schemes', () => {
    expect(() => assertSafeWebUrl('file:///etc/passwd')).toThrow(/scheme/);
    expect(() => assertSafeWebUrl('ftp://example.com')).toThrow(/scheme/);
    expect(() => assertSafeWebUrl('data:text/html,<script>alert(1)</script>')).toThrow(/scheme/);
    expect(() => assertSafeWebUrl('javascript:alert(1)')).toThrow(/scheme/);
  });

  it('rejects malformed URLs', () => {
    expect(() => assertSafeWebUrl('not a url')).toThrow(/Invalid URL/);
    expect(() => assertSafeWebUrl('')).toThrow(/Invalid URL/);
  });
});
