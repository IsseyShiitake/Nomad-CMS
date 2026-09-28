/**
 * Deferred platform-login intent.
 *
 * The split login screen offers "Continue with Cloudflare/Vercel" to
 * signed-out visitors, but a platform login CONNECTS the platform to the
 * signed-in admin's connection record — so the flow must sign in with
 * GitHub first and only then start the platform authorize (the exchange
 * requires the admin session). The pending intent bridges those two
 * redirects: it is written when the visitor picks a platform on the login
 * screen and consumed by the GitHub callback page once the session exists.
 *
 * The ten-minute TTL mirrors the server's OAuth state lifetime: a stale
 * intent (e.g. the visitor abandoned GitHub's authorize page and signs in
 * tomorrow) is ignored and dropped instead of surprise-connecting.
 */
import type { DeployPlatform } from '@cms/shared';

const STORAGE_KEY = 'cms.pending-platform-login';
const MAX_AGE_MS = 10 * 60 * 1000;

interface PendingIntent {
  platform: DeployPlatform;
  at: number;
}

/** Remembers the platform the visitor wants to connect after sign-in. */
export function setPendingPlatformLogin(platform: DeployPlatform): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ platform, at: Date.now() }));
  } catch {
    /* storage unavailable — the intent simply won't survive the redirect */
  }
}

/** Drops a pending intent (e.g. the login redirect itself failed). */
export function clearPendingPlatformLogin(): void {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    /* nothing to clear */
  }
}

/**
 * Returns and clears the pending platform intent when it is fresh enough
 * to act on; null when there is none, it expired, or storage is unreadable.
 */
export function consumePendingPlatformLogin(): DeployPlatform | null {
  let raw: string | null = null;
  try {
    raw = sessionStorage.getItem(STORAGE_KEY);
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<PendingIntent>;
    if (parsed.platform !== 'cloudflare' && parsed.platform !== 'vercel') return null;
    if (typeof parsed.at !== 'number' || Date.now() - parsed.at > MAX_AGE_MS) return null;
    return parsed.platform;
  } catch {
    return null;
  }
}
