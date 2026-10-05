/**
 * Embedded-asset serving for the single-file build (implements.md §5a).
 *
 * In the monorepo deployment, Workers Static Assets serves the built
 * frontend from the ASSETS binding, applies the `_headers` rules, and
 * falls back to index.html for unmatched paths (SPA routing). The
 * single-file bundle ships no assets directory: scripts/build-single.mjs
 * embeds every frontend dist file (base64 body, MIME type, MD5 ETag,
 * cache policy) plus the `_headers` "/*" security-header rule into a
 * virtual module, and this module reproduces the observable behavior:
 *
 *  - GET/HEAD of a known path → 200 with its content type, ETag, and
 *    cache policy (hashed /assets/* files are immutable; everything else
 *    revalidates), honoring If-None-Match with a 304;
 *  - unmatched paths → the embedded index.html, 200 (SPA fallback — the
 *    same response for /settings and for a missing /assets/*.js);
 *  - any other method → 405 with an empty body that still carries the
 *    security headers.
 */

export interface EmbeddedFile {
  /** File body, base64-encoded. */
  body: string;
  /** Response Content-Type, no parameters (matches the assets serving). */
  contentType: string;
  /** Strong ETag in quoted form, e.g. "\"679b77…\"". */
  etag: string;
  /** Cache-Control value served for this file. */
  cacheControl: string;
}

export interface EmbeddedAssets {
  /** Request path → file, e.g. "/index.html", "/assets/index-Ab12Cd.js". */
  files: Record<string, EmbeddedFile>;
  /**
   * The `_headers` "/*" rule — security headers applied to every response
   * this module produces, including the 405 and the SPA fallback.
   */
  securityHeaders: Record<string, string>;
}

/** Decodes a base64 body into response bytes. */
function decodeBody(file: EmbeddedFile): Uint8Array {
  const binary = atob(file.body);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Serves one non-/api request from the embedded assets. */
export function serveEmbedded(request: Request, assets: EmbeddedAssets): Response {
  const { pathname } = new URL(request.url);
  const method = request.method.toUpperCase();

  if (method !== 'GET' && method !== 'HEAD') {
    return new Response(null, { status: 405, headers: assets.securityHeaders });
  }

  // SPA fallback: any unmatched path serves the embedded index.html,
  // exactly like not_found_handling = "single-page-application".
  const file = assets.files[pathname] ?? assets.files['/index.html'];
  if (!file) {
    // Unreachable with a real build output (index.html always exists);
    // kept explicit so a broken bundle fails loudly instead of serving
    // an empty 200.
    return new Response('bundle is missing its embedded index.html', {
      status: 500,
      headers: assets.securityHeaders,
    });
  }

  const headers = new Headers(assets.securityHeaders);
  headers.set('ETag', file.etag);
  headers.set('Cache-Control', file.cacheControl);
  if (request.headers.get('If-None-Match') === file.etag) {
    return new Response(null, { status: 304, headers });
  }
  headers.set('Content-Type', file.contentType);
  return new Response(method === 'HEAD' ? null : decodeBody(file), { status: 200, headers });
}
