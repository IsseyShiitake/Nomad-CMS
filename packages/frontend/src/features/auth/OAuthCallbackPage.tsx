import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { ApiClientError, exchangeOAuthCode, startPlatformLogin } from '@/api';
import { useAuth, consumePendingPlatformLogin } from '@/services/auth';
import { useI18n } from '@/i18n';
import { FloatingControls } from '@/ui/components/FloatingControls';
import { Spinner } from '@/ui/components/Spinner';
import { greet } from '@/features/greeting';
import type { SessionInfo } from '@cms/shared';

/**
 * OAuth callback page.
 *
 * GitHub redirects here after the user authorizes the app. The
 * authorization code is exchanged for a session token through the
 * backend, then the user is routed to the repositories page.
 *
 * A platform connect started from the login screen ("Continue with
 * Cloudflare/Vercel") resumes here: once the session exists, the page
 * redirects the browser on to the platform's authorize URL instead of
 * navigating to repositories.
 *
 * GitHub authorization codes are single-use: reusing a code makes GitHub
 * return `bad_verification_code` AND revokes the token granted to the
 * first exchange. React StrictMode (development) mounts, unmounts, and
 * remounts this page, so the exchange is deduplicated across effect
 * re-runs AND remounts by keeping exactly one in-flight exchange per
 * `code` at module scope. A `useRef` flag is not sufficient — refs are
 * re-initialized when the component remounts.
 */
const inFlightExchanges = new Map<string, Promise<SessionInfo>>();

/**
 * Runs the code exchange at most once per authorization code. Every
 * caller for the same code joins the same in-flight request instead of
 * issuing a second POST /api/auth/exchange. Entries are retained after
 * completion so remounts with a consumed code reuse the result rather
 * than re-requesting it.
 */
function exchangeCodeOnce(code: string, state: string): Promise<SessionInfo> {
  let exchange = inFlightExchanges.get(code);
  if (!exchange) {
    exchange = exchangeOAuthCode(code, state);
    inFlightExchanges.set(code, exchange);
  }
  return exchange;
}

export function OAuthCallbackPage() {
  const { m, locale } = useI18n();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { applySession, isAuthenticated, login } = useAuth();
  const [error, setError] = useState<string | null>(null);

  // Set once this mount's own exchange has produced a session, so the
  // `isAuthenticated` redirect below doesn't double-navigate right after
  // this mount navigated. Navigation happens immediately once the session
  // applies — the greeting floats over the destination. A page revisited
  // while already authenticated never sets the ref and navigates directly
  // (no greeting).
  const appliedOwnSession = useRef(false);

  const code = searchParams.get('code');
  const stateParam = searchParams.get('state');
  const errorParam = searchParams.get('error');

  useEffect(() => {
    if (isAuthenticated) {
      if (!appliedOwnSession.current) {
        navigate('/repositories', { replace: true });
      }
      return;
    }

    if (errorParam) {
      setError(m.oauth.cancelled);
      return;
    }
    if (!code) {
      setError(m.oauth.noCode);
      return;
    }

    if (!stateParam) {
      setError(m.oauth.stateMismatch);
      return;
    }

    let cancelled = false;

    async function exchange(authCode: string, authState: string) {
      try {
        const info = await exchangeCodeOnce(authCode, authState);
        if (cancelled) {
          // StrictMode remount: the surviving mount will reuse the cached
          // exchange result, so this cancelled copy can safely stop here.
          return;
        }
        appliedOwnSession.current = true;
        applySession(info);
        // A platform connect started from the login screen ("Continue
        // with Cloudflare/Vercel") continues here: the session cookie now
        // exists, so hand the browser to the platform's authorize URL —
        // the platform callback then finishes in Settings. Any failure
        // falls through to the normal repositories navigation (the admin
        // can connect from Settings instead).
        const pendingPlatform = consumePendingPlatformLogin();
        if (pendingPlatform) {
          try {
            const { url } = await startPlatformLogin(pendingPlatform);
            window.location.href = url;
            return;
          } catch {
            // Platform authorize unreachable — continue signed-in below.
          }
        }
        // Navigate first; the non-interactive greeting overlay plays over
        // the destination instead of gating the route change.
        navigate('/repositories', { replace: true });
        greet({
          name: info.user.login,
          locale,
        });
      } catch (err) {
        if (!cancelled) {
          // Operator pinning: a different GitHub login signed in to an
          // instance that already has its operator — needs its own message,
          // not the generic retry hint.
          setError(
            err instanceof ApiClientError && err.code === 'instance_locked'
              ? m.oauth.instanceLocked
              : m.oauth.failed,
          );
        }
      }
    }

    void exchange(code, stateParam);
    return () => {
      cancelled = true;
    };
  }, [code, stateParam, errorParam, isAuthenticated, applySession, navigate, m, locale]);

  return (
    <section className="login-page">
      <FloatingControls />
      {error ? (
        <section className="auth-card">
          <h2>{m.oauth.failedTitle}</h2>
          <p>{error}</p>
          <button type="button" className="btn btn--primary" onClick={login}>
            {m.header.signInGithub}
          </button>
          <a href="/repositories">{m.oauth.backToRepositories}</a>
        </section>
      ) : (
        <section className="auth-card">
          <h2>{m.oauth.signingIn}</h2>
          <Spinner label={m.oauth.exchanging} />
        </section>
      )}
    </section>
  );
}
