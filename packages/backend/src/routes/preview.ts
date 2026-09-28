/**
 * Preview proxy route.
 *
 * GET /api/preview?url=<live site URL>
 *
 * Serves a repository's live site through this Worker so the frontend can
 * frame it as a static miniature:
 *
 *  - Session-gated (any kind) so the Worker is not an open proxy.
 *  - Only https URLs on known static-hosting suffixes are accepted:
 *    GitHub Pages (`.github.io`), Cloudflare Pages (`.pages.dev`), and
 *    Vercel (`.vercel.app`). Bounding the host set keeps the proxy closed
 *    (no arbitrary SSRF, no API call needed).
 *  - A `Content-Security-Policy: sandbox` header is set on the response so
 *    the re-served document can never execute scripts on the CMS origin —
 *    a same-origin script would carry the session cookie on its requests
 *    (the CSRF defense only checks header presence). The RepoTile iframe
 *    is unaffected: it renders through its own sandbox attribute.
 *  - Redirects are re-validated: the initial host allowlist must also hold
 *    for the FINAL URL after `redirect: 'follow'`, so an allowlisted host
 *    cannot bounce the fetch to an arbitrary origin.
 *
 * NOTE: unlike every other route, this handler's response is NOT passed
 * through finalizeResponse — the shared SECURITY_HEADERS carry
 * `X-Frame-Options: DENY` + a `frame-ancestors 'none'` CSP, which would
 * forbid the very iframe this endpoint exists for. The response therefore
 * sets its own framing-compatible security headers (sandbox CSP, nosniff).
 */

import { jsonError, readSessionToken } from '../core/http';
import { SessionManager, resolveEncryptionKey } from '../services/auth';
import type { RouteContext } from './index';

/** Host suffixes whose sites the proxy may frame. */
const FRAMEABLE_SUFFIXES = ['.github.io', '.pages.dev', '.vercel.app'];

/** Upper bound on the upstream fetch before the proxy gives up. */
const PREVIEW_TIMEOUT_MS = 15_000;

/** Largest preview document the proxy will buffer and re-serve (5 MiB). */
const PREVIEW_MAX_BYTES = 5 * 1024 * 1024;

/** True when the hostname belongs to a known static-hosting platform. */
function isFrameableHost(hostname: string): boolean {
  return FRAMEABLE_SUFFIXES.some((suffix) => hostname.endsWith(suffix));
}

/**
 * Injects `<base href>` right after <head> (creating a head when absent)
 * so the framed document's relative asset URLs keep working. A <base> the
 * site itself ships is respected.
 */
function withBaseTag(html: string, baseUrl: string): string {
  if (/<base\s/i.test(html)) return html;
  // Escape quotes so a crafted URL cannot break out of the attribute.
  const tag = `<base href="${baseUrl.replace(/"/g, '&quot;')}">`;
  const head = /<head[^>]*>/i.exec(html);
  if (head) {
    const at = head.index + head[0].length;
    return `${html.slice(0, at)}${tag}${html.slice(at)}`;
  }
  const htmlOpen = /<html[^>]*>/i.exec(html);
  if (htmlOpen) {
    const at = htmlOpen.index + htmlOpen[0].length;
    return `${html.slice(0, at)}<head>${tag}</head>${html.slice(at)}`;
  }
  return `${tag}${html}`;
}

/** Route handler for /api/preview. */
export const previewRoutes = {
  async handle(path: string, request: Request, ctx: RouteContext): Promise<Response> {
    if (path !== '' && path !== '/') {
      return jsonError('not_found', 'Preview route not found', 404);
    }
    if (request.method !== 'GET') {
      return jsonError('method_not_allowed', 'Preview supports GET only', 405);
    }

    // Any live session (admin or client) may read a public Pages miniature.
    const token = readSessionToken(request);
    if (!token) return jsonError('unauthorized', 'Not authenticated', 401);
    const session = await new SessionManager(
      ctx.env.SESSION_KV,
      await resolveEncryptionKey(ctx.env),
    ).getSession(token);
    if (!session) return jsonError('unauthorized', 'Not authenticated', 401);

    const raw = new URL(request.url).searchParams.get('url');
    if (!raw) return jsonError('invalid_url', 'Missing url parameter', 400);
    let target: URL;
    try {
      target = new URL(raw);
    } catch {
      return jsonError('invalid_url', 'Malformed url parameter', 400);
    }
    if (target.protocol !== 'https:' || !isFrameableHost(target.hostname)) {
      return jsonError(
        'forbidden_url',
        'Only GitHub Pages, Cloudflare Pages, and Vercel sites can be previewed',
        403,
      );
    }

    let upstream: Response;
    try {
      upstream = await fetch(target, {
        redirect: 'follow',
        signal: AbortSignal.timeout(PREVIEW_TIMEOUT_MS),
      });
    } catch {
      return jsonError('preview_unreachable', 'Preview site unreachable', 404);
    }

    // Redirects are followed, so the allowlist must hold for the FINAL url
    // too — an allowlisted host cannot bounce the fetch to an arbitrary
    // origin that would then be re-served from this Worker.
    if (upstream.url && upstream.url !== '') {
      let finalHost: string;
      try {
        finalHost = new URL(upstream.url).hostname;
      } catch {
        return jsonError('preview_unavailable', 'No live site found at this address', 404);
      }
      if (!isFrameableHost(finalHost)) {
        return jsonError('preview_unavailable', 'No live site found at this address', 404);
      }
    }

    // GitHub Pages answers 404 for sites that were never published — treat
    // any non-HTML success as "no live site" so the tile falls back to its
    // monogram instead of screenshotting an error page.
    const contentType = (upstream.headers.get('Content-Type') ?? '').toLowerCase();
    if (upstream.status !== 200 || !contentType.includes('text/html')) {
      return jsonError('preview_unavailable', 'No live site found at this address', 404);
    }
    // Bound the buffered document (declared length first, actual length as
    // the authority) so the proxy cannot be turned into a memory sink.
    const declaredLength = Number.parseInt(upstream.headers.get('Content-Length') ?? '', 10);
    if (Number.isFinite(declaredLength) && declaredLength > PREVIEW_MAX_BYTES) {
      return jsonError('preview_unavailable', 'No live site found at this address', 404);
    }
    const bodyText = await upstream.text();
    if (bodyText.length > PREVIEW_MAX_BYTES) {
      return jsonError('preview_unavailable', 'No live site found at this address', 404);
    }

    // Serve from THIS origin with deliberate headers only: a fresh Response
    // drops the upstream framing guards, and <base href> (anchored at the
    // FINAL url after redirects) keeps relative assets pointed at the site.
    // The CSP `sandbox` directive (without allow-scripts) means a navigated-
    // to preview document can never run scripts on this origin; the CMS's
    // own iframe consumers already render script-free via their sandbox
    // attributes. `private` keeps the session-gated document out of any
    // shared cache.
    const baseUrl = upstream.url && upstream.url !== '' ? upstream.url : target.href;
    const html = withBaseTag(bodyText, baseUrl);
    return new Response(html, {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'private, max-age=600',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': 'sandbox',
      },
    });
  },
};
