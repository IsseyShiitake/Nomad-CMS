import { buildUniqueSelector } from '@/services/htmlParser';

/**
 * Builds a sandboxed preview document (shared by the editor preview and
 * the repository miniature tiles):
 * - strips `<script>` elements, inline event handlers, and
 *   `<meta http-equiv="refresh">` (the sandboxed preview never runs site
 *   JavaScript, and a meta refresh must not navigate the frame away);
 * - removes `href` from every anchor so clicks can never navigate the
 *   sandboxed iframe (scripts stay stripped and `allow-scripts` stays
 *   off, so no JS interception is needed — links are simply inert);
 * - injects `<base href>` (the same-origin backend asset proxy) so
 *   relative assets resolve with correct MIME types, unless the page
 *   already declares a `<base>` tag;
 * - when `elementSelector` is given (editor mode), stamps each editable
 *   element with the exact id its panel row uses and appends the
 *   highlight style for the active element mode; pass `null` to get a
 *   plain sanitized render (miniature tiles).
 */
export function buildSrcDoc(html: string, baseHref: string, elementSelector: string | null): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script').forEach((el) => el.remove());
  // A meta refresh would navigate the sandboxed iframe away from the
  // preview to an arbitrary URL — strip it like the script tags.
  doc.querySelectorAll('meta[http-equiv="refresh" i]').forEach((el) => el.remove());
  for (const el of doc.querySelectorAll('*')) {
    for (const attr of Array.from(el.attributes)) {
      if (/^on/i.test(attr.name)) el.removeAttribute(attr.name);
    }
  }
  // Links are inert in the preview: dropping href means no click can
  // navigate the sandboxed iframe (anchor styling still applies since
  // sites select on `a`; the cursor becomes default, signalling it).
  doc.querySelectorAll('a[href]').forEach((a) => a.removeAttribute('href'));
  if (baseHref && !doc.querySelector('base')) {
    const base = doc.createElement('base');
    base.setAttribute('href', baseHref);
    doc.head.insertBefore(base, doc.head.firstChild);
  }
  if (elementSelector) {
    // Stamp each editable element with the exact id its panel row uses.
    // The parser builds ids as `el--${buildUniqueSelector(el)}` over the
    // same serialized HTML, so recomputing here yields identical ids
    // (script removal and on*-stripping never change the element tree
    // structure these :nth-of-type selectors depend on).
    for (const el of doc.querySelectorAll(elementSelector)) {
      el.setAttribute('data-cms-element-id', `el--${buildUniqueSelector(el)}`);
    }
    const style = doc.createElement('style');
    style.textContent =
      `${elementSelector}{outline:2px dashed rgba(37,99,235,.65);outline-offset:2px;cursor:pointer;transition:background .15s ease,outline .15s ease;}` +
      `${elementSelector}:hover{background:rgba(37,99,235,.12);outline-style:solid;}`;
    doc.head.appendChild(style);
  }

  // Preview fallback for JS-dependent reveal patterns. Sites using
  // scroll-reveal animations (opacity:0 + transform) hide content until
  // JavaScript adds a class to reveal it. Since we strip scripts for
  // security, we force visibility for common reveal patterns.
  // Covers: Kalon (.reveal), Othisi (.fu, .page-sec), and common naming
  // conventions. Extend the selector list to cover future sites.
  const revealFallback = doc.createElement('style');
  revealFallback.textContent =
    '.reveal,.fu,.page-sec' +
    '{opacity:1 !important;transform:none !important;}' +
    '[class*="reveal"],[class*="fade-up"],[class*="fade-in"],' +
    '[class*="scroll-part"]' +
    '{opacity:1 !important;transform:none !important;}';
  doc.head.appendChild(revealFallback);
  const doctype = doc.doctype ? `<!doctype ${doc.doctype.name}>` : '';
  return doctype + doc.documentElement.outerHTML;
}
