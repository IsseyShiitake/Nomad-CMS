import { useCallback, useEffect, useState, type FormEvent, type JSX } from 'react';
import {
  ApiClientError,
  connectPlatform,
  disconnectPlatform,
  getPlatformOAuthStatus,
  listDeployConnections,
  startPlatformLogin,
} from '@/api';
import type { DeployConnection, DeployPlatform } from '@cms/shared';
import { fmt, useI18n } from '@/i18n';
import { ErrorBanner } from '@/ui/components/ErrorBanner';
import { Card } from '@/ui/components/Card';

/**
 * Hosting-platform connections card (Settings, admin only).
 *
 * Lets the administrator connect Cloudflare Pages and Vercel accounts two
 * ways: "Log in with …" (platform OAuth — offered when the Worker holds
 * that platform's client credentials; tokens are stored server-side and
 * refresh automatically) or by pasting an API token (+ account id for
 * Cloudflare). Tokens are sent to the backend once and never rendered
 * back; the card only shows connected state and the account display name.
 */
export function HostingPlatformsCard() {
  const { m } = useI18n();

  const [connections, setConnections] = useState<DeployConnection[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Which platform OAuth logins the backend is configured for (empty when
  // the status call fails — the token-paste path keeps working).
  const [oauthAvailable, setOauthAvailable] = useState<Record<DeployPlatform, boolean>>({
    cloudflare: false,
    vercel: false,
  });

  // Per-platform form state: token (+ account id for Cloudflare).
  const [tokens, setTokens] = useState<Record<DeployPlatform, string>>({
    cloudflare: '',
    vercel: '',
  });
  const [accountIds, setAccountIds] = useState<Record<DeployPlatform, string>>({
    cloudflare: '',
    vercel: '',
  });
  const [connecting, setConnecting] = useState<DeployPlatform | null>(null);

  const load = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      // KV-only listing: any failure here is a load failure (there is no
      // platform call, so no platform_token_invalid path).
      setConnections(await listDeployConnections());
    } catch {
      setError(m.deploy.connectFailed);
    } finally {
      setIsLoading(false);
    }
  }, [m]);

  useEffect(() => {
    void load();
  }, [load]);

  // Platform-login availability drives the "Log in with …" buttons. A
  // failed lookup degrades to token-paste only, so it never blocks the card.
  useEffect(() => {
    let cancelled = false;
    getPlatformOAuthStatus()
      .then((statuses) => {
        if (cancelled) return;
        setOauthAvailable({
          cloudflare: statuses.find((s) => s.platform === 'cloudflare')?.available ?? false,
          vercel: statuses.find((s) => s.platform === 'vercel')?.available ?? false,
        });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  /** Connects one platform from the form values. */
  const handleConnect = async (platform: DeployPlatform, event: FormEvent) => {
    event.preventDefault();
    const token = tokens[platform].trim();
    const accountId = accountIds[platform].trim() || null;
    if (!token || (platform === 'cloudflare' && !accountId)) return;

    setConnecting(platform);
    setError(null);
    try {
      await connectPlatform(platform, token, accountId);
      setTokens((t) => ({ ...t, [platform]: '' }));
      await load();
    } catch (err) {
      setError(
        err instanceof ApiClientError && err.code === 'platform_token_invalid'
          ? m.deploy.invalidToken
          : m.deploy.connectFailed,
      );
    } finally {
      setConnecting(null);
    }
  };

  /** Starts the platform OAuth login (browser leaves for the authorize URL). */
  const handlePlatformLogin = async (platform: DeployPlatform) => {
    setConnecting(platform);
    setError(null);
    try {
      const { url } = await startPlatformLogin(platform);
      window.location.href = url;
      // No state reset on success — the browser is navigating away.
    } catch {
      setError(m.deploy.connectFailed);
      setConnecting(null);
    }
  };

  /** Disconnects one platform. */
  const handleDisconnect = async (platform: DeployPlatform) => {
    setError(null);
    try {
      await disconnectPlatform(platform);
      await load();
    } catch {
      setError(m.deploy.connectFailed);
    }
  };

  /** The connection record for one platform, when present. */
  const connectionFor = (platform: DeployPlatform): DeployConnection | null =>
    connections.find((c) => c.platform === platform) ?? null;

  /** Renders one platform's connect form or connected state. */
  const platformRow = (platform: DeployPlatform): JSX.Element => {
    const label =
      platform === 'cloudflare' ? m.deploy.platformCloudflare : m.deploy.platformVercel;
    const connection = connectionFor(platform);
    const isConnecting = connecting === platform;

    return (
      <div className="hosting-row" key={platform}>
        <span className="hosting-row__platform">{label}</span>
        {connection ? (
          <div className="hosting-row__state">
            <span className={`hosting-badge${connection.tokenInvalid ? ' hosting-badge--invalid' : ''}`}>
              {connection.tokenInvalid
                ? m.deploy.invalidToken
                : fmt(m.deploy.connectedAs, { name: connection.accountName ?? connection.accountId ?? '' })}
            </span>
            {connection.source === 'oauth' && (
              <span className="hosting-row__note">{m.deploy.sourceOauth}</span>
            )}
            <button type="button" className="btn" onClick={() => void handleDisconnect(platform)}>
              {m.deploy.disconnect}
            </button>
          </div>
        ) : (
          <div className="hosting-row__options">
            {oauthAvailable[platform] && (
              <div className="hosting-row__login">
                <button
                  type="button"
                  className="btn btn--primary"
                  disabled={isConnecting}
                  onClick={() => void handlePlatformLogin(platform)}
                >
                  {isConnecting ? m.deploy.connecting : fmt(m.deploy.loginWith, { name: label })}
                </button>
                <span className="hosting-row__alt">{m.deploy.orPasteToken}</span>
              </div>
            )}
            <form
              className="hosting-row__form"
              onSubmit={(event) => void handleConnect(platform, event)}
            >
              <input
                type="password"
                className="hosting-input hosting-input--token"
                placeholder={m.deploy.tokenLabel}
                value={tokens[platform]}
                autoComplete="off"
                onChange={(event) =>
                  setTokens((t) => ({ ...t, [platform]: event.target.value }))
                }
              />
              {platform === 'cloudflare' && (
                <input
                  type="text"
                  className="hosting-input hosting-input--account"
                  placeholder={m.deploy.accountIdLabel}
                  value={accountIds[platform]}
                  autoComplete="off"
                  onChange={(event) =>
                    setAccountIds((a) => ({ ...a, [platform]: event.target.value }))
                  }
                />
              )}
              <button
                type="submit"
                className={oauthAvailable[platform] ? 'btn' : 'btn btn--primary'}
                disabled={isConnecting || !tokens[platform].trim()}
              >
                {isConnecting ? m.deploy.connecting : m.deploy.connect}
              </button>
            </form>
          </div>
        )}
      </div>
    );
  };

  return (
    <Card className="settings-card hosting-card">
      <h4>{m.deploy.settingsHeading}</h4>
      <p className="page-status">{m.deploy.settingsIntro}</p>
      {error && <ErrorBanner onDismiss={() => setError(null)}>{error}</ErrorBanner>}
      {isLoading ? (
        <p className="page-status">{m.common.loading}</p>
      ) : (
        <div className="hosting-list">
          {platformRow('cloudflare')}
          {platformRow('vercel')}
        </div>
      )}
    </Card>
  );
}
