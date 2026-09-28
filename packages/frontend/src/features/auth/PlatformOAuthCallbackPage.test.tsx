/**
 * Component tests for the platform OAuth callback page.
 *
 * Verifies that the callback forwards platform, code, and state to the
 * backend exchange and routes to Settings on success; that a platform
 * error parameter short-circuits to the cancelled message; and that a
 * rejected exchange or an unsupported platform shows the retry hint
 * without leaving the page.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { exchangePlatformLogin } from '@/api';
import { I18nProvider } from '@/i18n';
import { ThemeProvider } from '@/services/theme';
import { PlatformOAuthCallbackPage } from './PlatformOAuthCallbackPage';
import type { DeployConnection } from '@cms/shared';

vi.mock('@/api', () => ({
  exchangePlatformLogin: vi.fn(),
}));

const OAUTH_CONNECTION: DeployConnection = {
  platform: 'cloudflare',
  accountName: 'admin@example.com',
  accountId: 'acct-1',
  createdAt: '2026-09-11T00:00:00Z',
  lastUsedAt: null,
  tokenInvalid: false,
  source: 'oauth',
  tokenExpiresAt: '2026-09-11T01:00:00Z',
};

function renderCallback(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <I18nProvider>
        <ThemeProvider>
          <Routes>
            <Route
              path="/auth/platform/:platform/callback"
              element={<PlatformOAuthCallbackPage />}
            />
            <Route path="/settings" element={<div>settings-page</div>} />
          </Routes>
        </ThemeProvider>
      </I18nProvider>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  vi.mocked(exchangePlatformLogin).mockReset();
});

describe('PlatformOAuthCallbackPage', () => {
  it('exchanges the code and routes to Settings on success', async () => {
    vi.mocked(exchangePlatformLogin).mockResolvedValue(OAUTH_CONNECTION);

    renderCallback('/auth/platform/cloudflare/callback?code=good-code&state=server-state');

    await waitFor(() => {
      expect(exchangePlatformLogin).toHaveBeenCalledWith('cloudflare', 'good-code', 'server-state');
    });
    await waitFor(() => {
      expect(screen.getByText('settings-page')).not.toBeNull();
    });
  });

  it('shows the cancelled message when the platform reports an error', async () => {
    renderCallback('/auth/platform/vercel/callback?error=access_denied');

    await waitFor(() => {
      expect(screen.getByText('The Vercel login was cancelled.')).not.toBeNull();
    });
    expect(exchangePlatformLogin).not.toHaveBeenCalled();
  });

  it('shows the retry hint when the exchange rejects', async () => {
    vi.mocked(exchangePlatformLogin).mockRejectedValue(new Error('expired state'));

    renderCallback('/auth/platform/cloudflare/callback?code=c&state=s');

    await waitFor(() => {
      expect(
        screen.getByText('The Cloudflare Pages login failed. Please try again from Settings.'),
      ).not.toBeNull();
    });
    expect(screen.getByText('Back to Settings')).not.toBeNull();
  });

  it('rejects an unsupported platform without exchanging', async () => {
    renderCallback('/auth/platform/gitlab/callback?code=c&state=s');

    await waitFor(() => {
      expect(
        screen.getByText('The gitlab login failed. Please try again from Settings.'),
      ).not.toBeNull();
    });
    expect(exchangePlatformLogin).not.toHaveBeenCalled();
  });
});
