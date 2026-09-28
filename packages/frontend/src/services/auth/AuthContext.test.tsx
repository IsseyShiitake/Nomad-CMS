/**
 * Component tests for the auth context's GitHub login redirect.
 *
 * Verifies that `login` fetches the server-issued OAuth authorization
 * URL and sends the browser to it (the state nonce is created and
 * validated server-side; the frontend only follows the returned URL).
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getSession, setUnauthorizedHandler, startOAuthLogin } from '@/api';
import { I18nProvider, STORAGE_KEY, useI18n } from '@/i18n';
import { AuthProvider, useAuth } from './AuthContext';

vi.mock('@/api', () => ({
  getSession: vi.fn(),
  clientLogin: vi.fn(),
  logout: vi.fn(),
  setUnauthorizedHandler: vi.fn(),
  startOAuthLogin: vi.fn(),
}));

const AUTHORIZE_URL = 'https://github.com/login/oauth/authorize?client_id=cms&state=abc123';

/** Renders a button that triggers the context's login redirect. */
function LoginProbe() {
  const { login } = useAuth();
  return <button onClick={() => void login()}>start login</button>;
}

afterEach(() => {
  cleanup();
  vi.mocked(getSession).mockReset();
  vi.mocked(startOAuthLogin).mockReset();
});

describe('AuthProvider login', () => {
  it('redirects to the server-issued authorize URL', async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    vi.mocked(startOAuthLogin).mockResolvedValue({ url: AUTHORIZE_URL });

    // jsdom cannot navigate; swap `location` for a stub so the href
    // assignment can be observed.
    const originalLocation = window.location;
    const location = { href: '' };
    delete (window as { location?: Location }).location;
    (window as unknown as { location: unknown }).location = location;

    try {
      render(
        <I18nProvider>
          <AuthProvider>
            <LoginProbe />
          </AuthProvider>
        </I18nProvider>,
      );

      fireEvent.click(screen.getByRole('button', { name: 'start login' }));

      await waitFor(() => {
        expect(startOAuthLogin).toHaveBeenCalledTimes(1);
        expect(location.href).toBe(AUTHORIZE_URL);
      });
    } finally {
      (window as unknown as { location: unknown }).location = originalLocation;
    }
  });
});

describe('AuthProvider unauthorized handling', () => {
  it('drops the session through the handler instead of reloading', async () => {
    vi.mocked(getSession).mockResolvedValue({
      user: { id: 1, login: 'octocat', name: null, avatarUrl: null },
      kind: 'admin',
      repoLock: null,
    });

    // Capture the handler the provider registers with the API layer.
    const registered: { current: (() => void) | null } = { current: null };
    vi.mocked(setUnauthorizedHandler).mockImplementation((handler) => {
      registered.current = handler;
    });

    /** Renders the session state so a drop is observable. */
    function SessionProbe() {
      const { isAuthenticated } = useAuth();
      return <span>{isAuthenticated ? 'signed-in' : 'signed-out'}</span>;
    }

    render(
      <I18nProvider>
        <AuthProvider>
          <SessionProbe />
        </AuthProvider>
      </I18nProvider>,
    );
    await waitFor(() => {
      expect(screen.getByText('signed-in')).not.toBeNull();
    });

    // A 401 from any non-auth endpoint fires the registered handler; the
    // session drops without touching window.location (no hard reload that
    // would bypass the editor's unsaved-changes guard).
    registered.current?.();
    await waitFor(() => {
      expect(screen.getByText('signed-out')).not.toBeNull();
    });
  });
});

describe('AuthProvider language application', () => {
  /** Renders the active locale so a switch is observable. */
  function LocaleProbe() {
    const { locale } = useI18n();
    return <span>locale:{locale}</span>;
  }

  afterEach(() => {
    cleanup();
    vi.mocked(getSession).mockReset();
    // The client-language test persists its locale; without this reset
    // the next test's provider inherits it wherever jsdom HAS localStorage
    // (CI) and renders the stored locale instead of the default.
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* no storage in this harness */
    }
  });

  it('applies a client session stored language on restore', async () => {
    vi.mocked(getSession).mockResolvedValue({
      user: { id: 0, login: 'acme', name: 'acme', avatarUrl: null },
      kind: 'client',
      repoLock: { owner: 'octocat', repo: 'site' },
      language: 'fr',
    });

    render(
      <I18nProvider>
        <AuthProvider>
          <LocaleProbe />
        </AuthProvider>
      </I18nProvider>,
    );

    // The provider defaults to the browser locale (en in jsdom); the stored
    // French preference wins once the session restores.
    await waitFor(() => {
      expect(screen.getByText('locale:fr')).not.toBeNull();
    });
  });

  it('never applies a language for admin sessions', async () => {
    vi.mocked(getSession).mockResolvedValue({
      user: { id: 1, login: 'octocat', name: null, avatarUrl: null },
      kind: 'admin',
      repoLock: null,
    });

    render(
      <I18nProvider>
        <AuthProvider>
          <LocaleProbe />
        </AuthProvider>
      </I18nProvider>,
    );

    await waitFor(() => {
      expect(screen.getByText('locale:en')).not.toBeNull();
    });
  });
});
