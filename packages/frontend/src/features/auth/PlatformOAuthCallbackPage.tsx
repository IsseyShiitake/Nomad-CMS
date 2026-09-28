import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { exchangePlatformLogin } from '@/api';
import { fmt, useI18n } from '@/i18n';
import { FloatingControls } from '@/ui/components/FloatingControls';
import { Spinner } from '@/ui/components/Spinner';
import type { DeployConnection, DeployPlatform } from '@cms/shared';

/**
 * Platform OAuth callback page (/auth/platform/:platform/callback).
 *
 * Cloudflare or Vercel redirects here after the admin authorizes the CMS
 * from the Settings hosting card. The page forwards code + state to the
 * backend, which validates the KV-bound state (PKCE verifier + initiating
 * admin), exchanges the code, and stores the connection — the admin's
 * session cookie identifies whose connection record it becomes. Success
 * lands back in Settings, where the hosting card shows the connection.
 *
 * Platform authorization codes are single-use, and React StrictMode
 * (development) remounts this page — so, like the GitHub callback, the
 * exchange is deduplicated across effect re-runs and remounts by exactly
 * one in-flight request per platform+code at module scope.
 */
const inFlightExchanges = new Map<string, Promise<DeployConnection>>();

/** Runs the exchange at most once per platform+code; remounts join it. */
function exchangePlatformCodeOnce(
  platform: DeployPlatform,
  code: string,
  state: string,
): Promise<DeployConnection> {
  const key = `${platform}:${code}`;
  let exchange = inFlightExchanges.get(key);
  if (!exchange) {
    exchange = exchangePlatformLogin(platform, code, state);
    inFlightExchanges.set(key, exchange);
  }
  return exchange;
}

/** True when the route's :platform segment names a supported platform. */
function isPlatform(value: string | undefined): value is DeployPlatform {
  return value === 'cloudflare' || value === 'vercel';
}

export function PlatformOAuthCallbackPage() {
  const { m } = useI18n();
  const { platform: platformParam } = useParams();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const [failed, setFailed] = useState<string | null>(null);

  const platform = isPlatform(platformParam) ? platformParam : null;
  const code = searchParams.get('code');
  const stateParam = searchParams.get('state');
  const errorParam = searchParams.get('error');

  const platformName =
    platform === 'cloudflare'
      ? m.deploy.platformCloudflare
      : platform === 'vercel'
        ? m.deploy.platformVercel
        : (platformParam ?? '');

  useEffect(() => {
    if (errorParam) {
      setFailed(fmt(m.oauth.platformCancelled, { name: platformName }));
      return;
    }
    if (!platform || !code || !stateParam) {
      setFailed(fmt(m.oauth.platformFailed, { name: platformName }));
      return;
    }

    let cancelled = false;
    exchangePlatformCodeOnce(platform, code, stateParam)
      .then(() => {
        if (!cancelled) navigate('/settings', { replace: true });
      })
      .catch(() => {
        // The state expired, the platform rejected the code, or the admin
        // session died mid-flow — all surface as the same retry hint.
        if (!cancelled) setFailed(fmt(m.oauth.platformFailed, { name: platformName }));
      });
    return () => {
      cancelled = true;
    };
  }, [platform, code, stateParam, errorParam, platformName, navigate, m]);

  return (
    <section className="login-page">
      <FloatingControls />
      {failed ? (
        <section className="auth-card">
          <h2>{m.oauth.failedTitle}</h2>
          <p>{failed}</p>
          <Link className="btn btn--primary" to="/settings">
            {m.oauth.backToSettings}
          </Link>
        </section>
      ) : (
        <section className="auth-card">
          <h2>{fmt(m.oauth.platformConnecting, { name: platformName })}</h2>
          <Spinner label={m.deploy.connecting} />
        </section>
      )}
    </section>
  );
}
