/**
 * Component tests for the split-screen login page.
 *
 * Verifies the error mapping (invalid credentials message), that a
 * successful login queues exactly one greeting and navigates to the
 * client workspace, and that the developer half always offers both
 * "Continue with …" platform buttons (they defer the connect through
 * GitHub sign-in; a platform not configured server-side falls through
 * to the signed-in repositories view). The greeting and platform-intent
 * modules are mocked so tests stay hermetic.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clientLogin, getSession, startOAuthLogin } from '@/api';
import { ApiClientError } from '@/api';
import { AuthProvider } from '@/services/auth';
import { setPendingPlatformLogin } from '@/services/auth/platformLoginIntent';
import { I18nProvider } from '@/i18n';
import { ThemeProvider } from '@/services/theme';
import { greet } from '@/features/greeting';
import { ClientLoginPage } from './ClientLoginPage';

vi.mock('@/api', () => ({
  getSession: vi.fn(),
  clientLogin: vi.fn(),
  logout: vi.fn(),
  setUnauthorizedHandler: vi.fn(),
  getPlatformOAuthStatus: vi.fn(),
  startOAuthLogin: vi.fn(),
  ApiClientError: class ApiClientError extends Error {
    constructor(
      public readonly status: number,
      public readonly code: string,
      message: string,
    ) {
      super(message);
    }
  },
}));

vi.mock('@/features/greeting', () => ({
  greet: vi.fn((r: { onDone?: () => void }) => r.onDone?.()),
}));

vi.mock('@/services/auth/platformLoginIntent', () => ({
  setPendingPlatformLogin: vi.fn(),
  clearPendingPlatformLogin: vi.fn(),
  consumePendingPlatformLogin: vi.fn(),
}));

const CLIENT_SESSION = {
  user: { id: 0, login: 'acme', name: 'acme', avatarUrl: null },
  kind: 'client' as const,
  repoLock: { owner: 'octocat', repo: 'site' },
};

function renderPage(initialEntries: string[] = ['/login']) {
  return render(
    <MemoryRouter initialEntries={initialEntries}>
      <I18nProvider>
        <ThemeProvider>
          <AuthProvider>
            <Routes>
              <Route path="/login" element={<ClientLoginPage />} />
              <Route path="/client" element={<div>client workspace</div>} />
            </Routes>
          </AuthProvider>
        </ThemeProvider>
      </I18nProvider>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  vi.mocked(greet).mockClear();
  vi.mocked(startOAuthLogin).mockReset();
  vi.mocked(setPendingPlatformLogin).mockClear();
  vi.unstubAllGlobals();
});

describe('ClientLoginPage', () => {
  it('shows the invalid message on wrong credentials', async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    vi.mocked(clientLogin).mockRejectedValue(new ApiClientError(401, 'invalid_credentials', 'nope'));

    renderPage();

    // Expand the Client half of the split screen first.
    fireEvent.click(screen.getByRole('button', { name: /client/i }));

    fireEvent.change(await screen.findByLabelText('Access ID'), {
      target: { value: 'acme-x1y2' },
    });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'wrong' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => {
      expect(screen.getByText('Invalid access ID or password.')).not.toBeNull();
    });
  });

  it('navigates to the client workspace on success, greeting exactly once', async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    vi.mocked(clientLogin).mockResolvedValue(CLIENT_SESSION);

    renderPage();

    fireEvent.click(screen.getByRole('button', { name: /client/i }));

    fireEvent.change(await screen.findByLabelText('Access ID'), {
      target: { value: 'acme-x1y2' },
    });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'secret' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => {
      expect(screen.getByText('client workspace')).not.toBeNull();
    });

    expect(vi.mocked(greet)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(greet)).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'acme', locale: 'en' }),
    );
  });

  it('starts expanded on the developer half via ?role=developer', async () => {
    vi.mocked(getSession).mockResolvedValue(null);

    renderPage(['/login?role=developer']);

    await screen.findByRole('group', { name: 'Choose how to sign in' });
    const half = document.querySelector('.split-login__half--developer');
    expect(half?.className).toContain('split-login__half--expanded');
    expect(screen.getByRole('button', { name: 'Sign in with GitHub' })).not.toBeNull();
  });

  it('always offers both platform logins on the developer half', async () => {
    vi.mocked(getSession).mockResolvedValue(null);

    renderPage(['/login?role=developer']);

    expect(await screen.findByText('Continue with Cloudflare Pages')).not.toBeNull();
    expect(screen.getByText('Continue with Vercel')).not.toBeNull();
  });

  it('defers a platform login through GitHub sign-in', async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    vi.mocked(startOAuthLogin).mockResolvedValue({
      url: 'https://github.com/login/oauth/authorize?state=1',
    });
    const locationStub = { href: 'http://localhost/' };
    vi.stubGlobal('location', locationStub);

    renderPage(['/login?role=developer']);

    fireEvent.click(await screen.findByText('Continue with Cloudflare Pages'));

    // The intent is recorded BEFORE the browser leaves for GitHub.
    await waitFor(() => {
      expect(setPendingPlatformLogin).toHaveBeenCalledWith('cloudflare');
    });
    await waitFor(() => {
      expect(locationStub.href).toBe('https://github.com/login/oauth/authorize?state=1');
    });
  });
});
