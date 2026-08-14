export interface LiveDomSnapshot {
  html: string;
  url: string;
  title: string;
}

/**
 * JavaScript evaluated inside the Web Viewer page to serialize its rendered DOM.
 *
 * ## Why it does more than read `outerHTML`
 *
 * Defuddle drops CSS-hidden clutter by consulting `getComputedStyle`, but it
 * only does so when the document's `defaultView` *is* the global `window`. Both
 * of our transports hand it a `DOMParser` document (the page's live DOM lives in
 * another process and cannot cross the `executeJavaScript` boundary), so that
 * pass never runs and hidden menus, cookie banners and off-screen navigation
 * survive into the markdown.
 *
 * Defuddle does still honour an **inline** `display:none` / `visibility:hidden`
 * / `opacity:0`. So this script resolves computed styles where they exist — in
 * the page — and stamps the equivalent inline style onto a detached clone. The
 * live page is never mutated: the clone is taken first and every write lands on
 * it, so a failure here cannot disturb what the user is looking at.
 *
 * The parallel walk relies on `querySelectorAll('*')` returning the same
 * document order for a tree and its `cloneNode(true)` copy. The length check
 * makes that assumption falsifiable rather than silent — on mismatch the script
 * degrades to a plain serialization.
 */
export const LIVE_DOM_CAPTURE_SCRIPT = `(function () {
  var root = document.documentElement;
  var result = { html: '', url: location.href, title: document.title || '' };
  if (!root) { return result; }

  var clone = root.cloneNode(true);
  try {
    var live = root.querySelectorAll('*');
    var copies = clone.querySelectorAll('*');
    if (live.length === copies.length && live.length <= 40000) {
      for (var i = 0; i < live.length; i++) {
        var computed = window.getComputedStyle(live[i]);
        if (!computed) { continue; }
        var hidden = computed.display === 'none'
          ? 'display:none'
          : computed.visibility === 'hidden'
            ? 'visibility:hidden'
            : computed.opacity === '0' ? 'opacity:0' : '';
        if (!hidden) { continue; }
        var existing = copies[i].getAttribute('style');
        copies[i].setAttribute('style', existing ? existing + ';' + hidden : hidden);
      }
    }
  } catch (e) {
    // Style resolution failed; fall through and serialize the clone as-is.
  }

  result.html = clone.outerHTML;
  return result;
})()`;

/**
 * Narrow the untyped `executeJavaScript` result to a usable snapshot.
 *
 * The value crosses a process boundary, so it is validated rather than cast.
 */
export function toLiveDomSnapshot(value: unknown): LiveDomSnapshot | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const candidate = value as Partial<LiveDomSnapshot>;
  if (typeof candidate.html !== 'string' || !candidate.html.trim()) {
    return null;
  }

  return {
    html: candidate.html,
    url: typeof candidate.url === 'string' ? candidate.url : '',
    title: typeof candidate.title === 'string' ? candidate.title : '',
  };
}
