/**
 * Minimal KV-backed fixed-window rate limiting.
 *
 * Closes review-2026-09-25's accepted item "authorize endpoint allows
 * unauthenticated KV writes": GET /api/auth/authorize must stay reachable
 * without a session (it is how a session is obtained), and each call
 * wrote one KV state entry — so on the free plan's 1,000 KV writes/day a
 * trivial request loop could exhaust the day's write budget in minutes
 * and lock every user out of signing in. Limiting per IP converts that
 * cheap lever into KV reads (100,000/day budget) while a legitimate
 * signer-in pays one extra read plus one extra write.
 *
 * Properties, kept deliberately small:
 *  - fixed window keyed `ratelimit:<scope>:<ip>:<bucket-index>`; each key
 *    carries a TTL of one window, so buckets self-expire with no sweeper;
 *  - over-limit requests write NOTHING (reads only);
 *  - requests without CF-Connecting-IP (local dev, tests) share one
 *    "unknown" bucket — fail-safe (restrictive), never fail-open.
 *
 * Honest limits:
 *  - the counter is KV get-then-put, NOT an atomic increment: concurrent
 *    requests can all read the same count and all pass, exceeding the limit
 *    by roughly the burst's concurrency factor. Cloudflare KV has no atomic
 *    increment — this is an accepted tradeoff (the limiter raises attack
 *    cost; it is not a hard quota), and each over-limit request still
 *    writes nothing;
 *  - a botnet rotating source IPs spreads across buckets and still burns up
 *    to `limit` writes per IP per window;
 *  - requests without CF-Connecting-IP share one "unknown" bucket. That is
 *    fail-safe (restrictive) by design for local dev and tests — but it
 *    means a Worker reachable WITHOUT Cloudflare in front (custom domain
 *    with proxy off) shares one budget across ALL visitors. Deploy behind
 *    Cloudflare (the default for workers.dev and proxied custom domains).
 *
 * This raises the attack cost ~100× and defeats trivial loops; it does not
 * make a free-tier instance un-DoS-able (raw request volume remains a
 * platform-level concern).
 */

import type { Env } from '../env';

/** Max authorize calls per source IP per window. No human needs more. */
export const AUTHORIZE_RATE_LIMIT = 10;

/** Fixed-window size for the authorize limiter, in seconds. */
export const AUTHORIZE_RATE_WINDOW_SECONDS = 3600;

/** Max client-login attempts per source IP per window. Generous enough for
 * several clients behind one NAT (each including failed attempts); tight
 * enough to cap the unauthenticated PBKDF2 (100k iterations) burn that the
 * per-account lockout cannot enforce against parallel or multi-account
 * spraying. */
export const CLIENT_LOGIN_RATE_LIMIT = 20;

/** Fixed-window size for the client-login limiter, in seconds. */
export const CLIENT_LOGIN_RATE_WINDOW_SECONDS = 3600;

/** Best-effort client IP for rate limiting. The edge sets
 *  CF-Connecting-IP on workers.dev/custom domains; attackers cannot
 *  forge it past Cloudflare. */
export function clientIp(request: Request): string {
  return request.headers.get('CF-Connecting-IP')?.trim() || 'unknown';
}

export interface RateLimitVerdict {
  allowed: boolean;
  /** Seconds until the current window ends (Retry-After). */
  retryAfterSeconds: number;
}

/**
 * Counts one request for `scope`/`ip` in the current fixed window.
 * Returns allowed=false once the IP reaches `limit` in the window —
 * in that case nothing is written at all.
 */
export async function checkRateLimit(
  env: Pick<Env, 'SESSION_KV'>,
  scope: string,
  ip: string,
  limit: number,
  windowSeconds: number,
): Promise<RateLimitVerdict> {
  const windowMs = windowSeconds * 1000;
  const now = Date.now();
  const bucket = Math.floor(now / windowMs);
  const key = `ratelimit:${scope}:${ip}:${bucket}`;
  const stored = await env.SESSION_KV.get(key);
  const count = stored ? Number.parseInt(stored, 10) || 0 : 0;
  if (count >= limit) {
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil(((bucket + 1) * windowMs - now) / 1000)),
    };
  }
  // KV rejects writes to the same key faster than 1/second: a parallel burst
  // (e.g. scripted client-login attempts from one IP) turned this put into an
  // unhandled throw and the routes answered raw 500s (rig finding N2,
  // 2026-11-16). The limiter is a cost-raiser, not a hard quota — on a
  // rejected write, allow the request and let the read gate converge next
  // window (documented honest limit: limits are soft under concurrency).
  try {
    await env.SESSION_KV.put(key, String(count + 1), { expirationTtl: windowSeconds });
  } catch {
    // Undercounted for this window; nothing to surface — the per-account
    // lockout and the read gate above still apply.
  }
  return { allowed: true, retryAfterSeconds: 0 };
}
