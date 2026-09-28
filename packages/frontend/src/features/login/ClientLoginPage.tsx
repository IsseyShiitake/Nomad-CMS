import { useEffect, useRef, useState } from 'react';
import type {
  FocusEvent as ReactFocusEvent,
  FormEvent,
  KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { ApiClientError } from '@/api';
import { useAuth, setPendingPlatformLogin, clearPendingPlatformLogin } from '@/services/auth';
import { fmt, useI18n } from '@/i18n';
import type { DeployPlatform } from '@cms/shared';
import { config } from '@/config';
import { greet } from '@/features/greeting';
import { FloatingControls } from '@/ui/components/FloatingControls';
import { ErrorBanner } from '@/ui/components/ErrorBanner';
import './LoginPage.css';

/* CONCEPT A "LUMEN" — the logic in this file is the shipped component
   verbatim. The only change is one decorative `.split-login__veil` span
   per half (aria-hidden, pointer-events none), which CSS brightens on
   hover so the affordance lands before the flex bias finishes moving.
   Every class name, role, aria-label and field label the component tests
   assert on is unchanged. */

/** Which half of the split screen is hovered / expanded. */
type Half = 'client' | 'developer';

/** Platform connect buttons offered on the developer half (login screen). */
const LOGIN_PLATFORMS: readonly DeployPlatform[] = ['cloudflare', 'vercel'];

/** Builds the half's class list from the expand/hover state. */
function halfClass(half: Half, expanded: Half | null): string {
  let cls = 'split-login__half split-login__half--' + half;
  if (expanded === half) cls += ' split-login__half--expanded';
  else if (expanded) cls += ' split-login__half--collapsed';
  return cls;
}

/**
 * Split-screen login page.
 *
 * Full-viewport screen divided into a Client half (access ID + password)
 * and a Developer half (GitHub OAuth). Hovering or keyboard-focusing a
 * half nudges it wider and lights it; clicking it (or pressing Enter/Space)
 * expands it to full screen and fades in its sign-in card. `?role=client`
 * or `?role=developer` starts already expanded on that half.
 *
 * On a successful client login a greeting is queued exactly once and
 * navigation to /client happens immediately (the greeting floats over the
 * destination). The access's stored language (if any) is applied by the
 * auth context from the session response.
 */
export function ClientLoginPage() {
  const { m, locale } = useI18n();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { user, isAdmin, isClient, isLoading, login, loginClient } = useAuth();

  // Deep link: ?role=client|developer starts already expanded.
  const [expanded, setExpanded] = useState<Half | null>(() => {
    const role = searchParams.get('role');
    return role === 'client' || role === 'developer' ? role : null;
  });
  const [hovered, setHovered] = useState<Half | null>(null);

  // Client form state.
  const [clientId, setClientId] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isGithubLoading, setIsGithubLoading] = useState(false);
  const [githubError, setGithubError] = useState<string | null>(null);
  // Platform connect buttons always render (they defer through GitHub
  // sign-in, which works regardless); a platform whose OAuth app is not
  // registered yet simply falls through to the signed-in repositories
  // view after the GitHub hop.
  const [startingPlatform, setStartingPlatform] = useState<DeployPlatform | null>(null);
  const [pendingGreet, setPendingGreet] = useState<{ id: string } | null>(null);
  const greetedRef = useRef(false);
  // Pointer left the window (or the window lost focus): back to 50/50.
  useEffect(() => {
    const clear = () => setHovered(null);
    document.addEventListener('mouseleave', clear);
    window.addEventListener('blur', clear);
    return () => {
      document.removeEventListener('mouseleave', clear);
      window.removeEventListener('blur', clear);
    };
  }, []);

  // Escape collapses an expanded half back to the 50/50 split.
  useEffect(() => {
    if (!expanded) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setExpanded(null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [expanded]);

  // Already signed in: route to the matching workspace. When a client
  // login just succeeded, navigate immediately and queue exactly one
  // greeting — it floats over the destination instead of delaying it.
  useEffect(() => {
    if (isLoading) return;
    if (isAdmin) {
      navigate('/repositories', { replace: true });
      return;
    }
    if (!isClient) return;
    navigate('/client', { replace: true });
    if (pendingGreet && !greetedRef.current) {
      greetedRef.current = true;
      greet({
        name: user?.login ?? pendingGreet.id,
        // The CURRENT locale: adoptSession already applied the access's
        // stored language in the same commit, so the greeting matches the
        // UI language the client sees (not the pre-login browser locale).
        locale,
      });
    }
  }, [isLoading, isAdmin, isClient, navigate, user, pendingGreet, locale]);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (isSubmitting) return;
    const trimmedId = clientId.trim();
    setIsSubmitting(true);
    setError(null);
    try {
      await loginClient(trimmedId, password);
      // The stored language preference (if any) is applied by the auth
      // context from the session response — the browser locale does not
      // overwrite it.
      setPendingGreet({ id: trimmedId });
    } catch (err) {
      // A network-level failure (backend unreachable) is NOT bad
      // credentials — say so instead of blaming the ID/password.
      if (err instanceof TypeError) {
        setError(m.login.serverUnreachable);
      } else if (err instanceof ApiClientError) {
        if (err.code === 'revoked') setError(m.login.revoked);
        else setError(m.login.invalid);
      } else {
        setError(m.login.invalid);
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  /** GitHub OAuth: never silent — surface a reachable error state. */
  const handleGithubLogin = async () => {
    if (isGithubLoading) return;
    setIsGithubLoading(true);
    setGithubError(null);
    try {
      await login();
    } catch {
      setIsGithubLoading(false);
      setGithubError(m.login.serverUnreachable);
    }
  };

  /**
   * Platform connect from the login screen. The exchange needs an admin
   * session, so the flow defers: remember the chosen platform, sign in
   * with GitHub (same redirect as the plain login button), and let the
   * GitHub callback continue to the platform's authorize once the
   * session exists.
   */
  const handlePlatformLogin = async (platform: DeployPlatform) => {
    if (startingPlatform || isGithubLoading) return;
    setStartingPlatform(platform);
    setGithubError(null);
    setPendingPlatformLogin(platform);
    try {
      await login();
    } catch {
      clearPendingPlatformLogin();
      setStartingPlatform(null);
      setGithubError(m.login.serverUnreachable);
    }
  };

  // Shared pointer/keyboard wiring for both halves: click or Enter/Space
  // expands, hover and focus bias the flex split toward the half.
  const halfInteractions = (half: Half) => ({
    onClick: () => {
      if (!expanded) setExpanded(half);
    },
    onKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (expanded) return;
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        setExpanded(half);
      }
    },
    onMouseEnter: () => setHovered(half),
    onMouseLeave: () => setHovered((current) => (current === half ? null : current)),
    onFocus: () => setHovered(half),
    onBlur: (event: ReactFocusEvent<HTMLDivElement>) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
        setHovered(null);
      }
    },
  });

  return (
    <section
      className={
        'split-login' + (expanded ? ' split-login--expanded' : '') + (hovered && !expanded ? ` split-login--hover-${hovered}` : '')
      }
    >
      <FloatingControls />

      <div className="split-login__brand">
        <span className="split-login__brand-name">{config.appName || m.app.name}</span>
        <span className="split-login__brand-kicker">content management system</span>
      </div>

      <div className="split-login__halves" role="group" aria-label={m.login.chooseHalfAria}>
        {/* Client half — access ID + password */}
        <div
          className={halfClass('client', expanded)}
          role={expanded === 'client' ? 'region' : 'button'}
          aria-label={m.login.clientTitle}
          tabIndex={expanded === 'client' ? undefined : 0}
          {...halfInteractions('client')}
        >
          <span className="split-login__veil" aria-hidden="true" />

          <div className="split-login__hero">
            <span className="split-login__label">{m.login.clientTitle}</span>
            <span className="split-login__kicker">{m.login.clientTagline}</span>
          </div>

          <div className="split-login__panel">
            <button type="button" className="btn split-login__back" onClick={() => setExpanded(null)}>
              {m.login.backToHalves}
            </button>

            <form className="auth-card login-card" onSubmit={(event) => void handleSubmit(event)}>
              <h2>{m.login.title}</h2>
              <p className="login-card__subtitle">{m.login.subtitle}</p>

              {error && <ErrorBanner>{error}</ErrorBanner>}

              <label className="login-card__field">
                <span>{m.login.idLabel}</span>
                <input
                  type="text"
                  autoComplete="username"
                  value={clientId}
                  onChange={(event) => setClientId(event.target.value)}
                  required
                />
              </label>

              <label className="login-card__field">
                <span>{m.login.passwordLabel}</span>
                <input
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  required
                />
              </label>

              <button type="submit" className="btn btn--primary" disabled={isSubmitting}>
                {isSubmitting ? m.login.submitting : m.login.submit}
              </button>
            </form>
          </div>
        </div>

        {/* Developer half — GitHub OAuth */}
        <div
          className={halfClass('developer', expanded)}
          role={expanded === 'developer' ? 'region' : 'button'}
          aria-label={m.login.developerTitle}
          tabIndex={expanded === 'developer' ? undefined : 0}
          {...halfInteractions('developer')}
        >
          <span className="split-login__veil" aria-hidden="true" />

          <div className="split-login__hero">
            <span className="split-login__label">{m.login.developerTitle}</span>
            <span className="split-login__kicker">{m.login.developerTagline}</span>
          </div>

          <div className="split-login__panel">
            <button type="button" className="btn split-login__back" onClick={() => setExpanded(null)}>
              {m.login.backToHalves}
            </button>
            <div className="auth-card login-card">
              <h2>{m.login.developerTitle}</h2>
              <p className="login-card__subtitle">{m.login.developerIntro}</p>

              {githubError && <ErrorBanner>{githubError}</ErrorBanner>}

              <button type="button" className="btn btn--primary" disabled={isGithubLoading} onClick={() => void handleGithubLogin()}>
                {isGithubLoading ? m.common.loading : m.header.signInGithub}
              </button>

              <div className="login-card__platforms">
                <span className="login-card__platform-label">{m.login.platformLoginsLabel}</span>
                {LOGIN_PLATFORMS.map((platform) => (
                  <button
                    key={platform}
                    type="button"
                    className="btn"
                    disabled={startingPlatform !== null || isGithubLoading}
                    onClick={() => void handlePlatformLogin(platform)}
                  >
                    {startingPlatform === platform
                      ? m.common.loading
                      : fmt(m.login.continueWith, {
                          name:
                            platform === 'cloudflare'
                              ? m.deploy.platformCloudflare
                              : m.deploy.platformVercel,
                        })}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
