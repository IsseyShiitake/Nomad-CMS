/**
 * Component tests for the OAuth callback page.
 *
 * Verifies that the callback forwards both the authorization code and
 * the `state` parameter to the backend exchange, that a missing state
 * is rejected before any exchange is attempted, and that a platform
 * connect started from the login screen resumes here — the browser is
 * handed to the platform's authorize URL instead of navigating to the
 * repositories.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { exchangeOAuthCode, getSession, startPlatformLogin } from '@/api';
import { AuthProvider } from '@/services/auth';
import { consumePendingPlatformLogin } from '@/services/auth/platformLoginIntent';
import { ThemeProvider } from '@/services/theme';
import { I18nProvider } from '@/i18n';
import { OAuthCallbackPage } from './OAuthCallbackPage';

vi.mock('@/api', () => ({
  getSession: vi.fn(),
  clientLogin: vi.fn(),
  logout: vi.fn(),
  setUnauthorizedHandler: vi.fn(),
  startOAuthLogin: vi.fn(),
  exchangeOAuthCode: vi.fn(),
  startPlatformLogin: vi.fn(),
}));

vi.mock('@/services/auth/platformLoginIntent', () => ({
  setPendingPlatformLogin: vi.fn(),
  clearPendingPlatformLogin: vi.fn(),
  consumePendingPlatformLogin: vi.fn(),
}));

// The greeting is mocked so tests stay hermetic; navigation happens
// immediately after the exchange and the overlay floats over the destination.
vi.mock('@/features/greeting', () => ({
  greet: vi.fn((r: { onDone?: () => void }) => r.onDone?.()),
}));

const ADMIN_SESSION = {
  user: { id: 1, login: 'octocat', name: 'Octocat', avatarUrl: null },
  kind: 'admin' as const,
  repoLock: null,
};

function renderCallback(search: string) {
  return render(
    <MemoryRouter initialEntries={[`/auth/callback${search}`]}>
      <I18nProvider>
        <ThemeProvider>
          <AuthProvider>
            <Routes>
              <Route path="/auth/callback" element={<OAuthCallbackPage />} />
              <Route path="/repositories" element={<div>repositories</div>} />
            </Routes>
          </AuthProvider>
        </ThemeProvider>
      </I18nProvider>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.mocked(getSession).mockReset();
  vi.mocked(exchangeOAuthCode).mockReset();
  vi.mocked(startPlatformLogin).mockReset();
  vi.mocked(consumePendingPlatformLogin).mockReset();
});

describe('OAuthCallbackPage', () => {
  it('forwards code and state to the exchange', async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    vi.mocked(consumePendingPlatformLogin).mockReturnValue(null);
    vi.mocked(exchangeOAuthCode).mockResolvedValue(ADMIN_SESSION);

    renderCallback('?code=fresh-code&state=server-state');

    await waitFor(() => {
      expect(exchangeOAuthCode).toHaveBeenCalledWith('fresh-code', 'server-state');
    });
  });

  it('shows the state-mismatch error when state is absent', async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    vi.mocked(consumePendingPlatformLogin).mockReturnValue(null);

    renderCallback('?code=no-state-code');

    await waitFor(() => {
      expect(
        screen.getByText('Sign-in verification failed (state mismatch). Please try again.'),
      ).not.toBeNull();
    });
    expect(exchangeOAuthCode).not.toHaveBeenCalled();
  });

  it('resumes a pending platform login instead of navigating to repositories', async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    vi.mocked(consumePendingPlatformLogin).mockReturnValue('cloudflare');
    vi.mocked(exchangeOAuthCode).mockResolvedValue(ADMIN_SESSION);
    vi.mocked(startPlatformLogin).mockResolvedValue({
      url: 'https://dash.cloudflare.com/oauth2/auth?state=2',
    });
    const locationStub = { href: 'http://localhost/' };
    vi.stubGlobal('location', locationStub);

    renderCallback('?code=fresh-code&state=server-state');

    await waitFor(() => {
      expect(startPlatformLogin).toHaveBeenCalledWith('cloudflare');
    });
    await waitFor(() => {
      expect(locationStub.href).toBe('https://dash.cloudflare.com/oauth2/auth?state=2');
    });
    // The normal repositories navigation never happened.
    expect(screen.queryByText('repositories')).toBeNull();
  });

  it('falls back to repositories when the platform authorize is unreachable', async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    vi.mocked(consumePendingPlatformLogin).mockReturnValue('cloudflare');
    vi.mocked(exchangeOAuthCode).mockResolvedValue(ADMIN_SESSION);
    vi.mocked(startPlatformLogin).mockRejectedValue(new Error('down'));

    renderCallback('?code=fresh-code&state=server-state');

    await waitFor(() => {
      expect(screen.getByText('repositories')).not.toBeNull();
    });
  });
});
