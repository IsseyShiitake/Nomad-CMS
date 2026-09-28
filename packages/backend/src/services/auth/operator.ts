/**
 * Operator pinning (implements.md §4, Phase 2).
 *
 * Closes the "any GitHub login becomes admin" door: exactly one GitHub
 * login may exchange for an admin session on this instance.
 *
 *  - KV key `operator:login` holds the claim. On the first GitHub exchange
 *    the signing-in login claims it (write-once). A later, different login
 *    is rejected with 403 instance_locked.
 *  - The `OPERATOR_LOGIN` env var (public, set by the setup script or the
 *    operator) pins the operator explicitly — no first-login race. It is
 *    still mirrored to KV on the first matching login so the KV read path
 *    alone stays authoritative once bootstrapped.
 *  - Client (password) sessions are unaffected: they are a separate kind
 *    the operator hands out. Existing admin sessions keep working — the
 *    check runs at exchange time only.
 */

import type { Env } from '../../env';

/** KV key holding the operator's GitHub login (write-once claim). */
const OPERATOR_KEY = 'operator:login';

/**
 * True when the login may hold the admin role on this instance.
 *
 * GitHub logins are case-insensitive, so claims compare lowercased.
 */
export async function isOperatorLogin(env: Env, login: string): Promise<boolean> {
  const override = env.OPERATOR_LOGIN?.trim();
  if (override) {
    if (override.toLowerCase() !== login.toLowerCase()) return false;
    // Mirror the pinned operator into KV. A stale claim from a previous
    // first-login (before the override was configured) is overwritten —
    // the env var is authoritative, and leaving the stale claim would trap
    // the instance if the var were ever removed again.
    const stored = await env.SESSION_KV.get(OPERATOR_KEY);
    if (!stored || stored.toLowerCase() !== override.toLowerCase()) {
      await env.SESSION_KV.put(OPERATOR_KEY, login);
    }
    return true;
  }
  const stored = await env.SESSION_KV.get(OPERATOR_KEY);
  if (stored) {
    return stored.toLowerCase() === login.toLowerCase();
  }
  // No claim yet: this first login claims the operator slot. Two concurrent
  // first logins race on the KV write (last write wins); deployments that
  // care set OPERATOR_LOGIN, which removes the race entirely.
  await env.SESSION_KV.put(OPERATOR_KEY, login);
  return true;
}
