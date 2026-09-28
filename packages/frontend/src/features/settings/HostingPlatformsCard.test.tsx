/**
 * Component tests for the hosting-platforms settings card.
 *
 * Verifies that the "Log in with …" button appears only for platforms
 * whose OAuth login the backend reports as available, that clicking it
 * fetches the server-built authorize URL and navigates the browser there,
 * and that an OAuth-sourced connection shows its auto-renewal note.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  connectPlatform,
  disconnectPlatform,
  getPlatformOAuthStatus,
  listDeployConnections,
  startPlatformLogin,
} from '@/api';
import { I18nProvider } from '@/i18n';
import { HostingPlatformsCard } from './HostingPlatformsCard';
import type { DeployConnection } from '@cms/shared';

vi.mock('@/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api')>();
  return {
    ...actual,
    listDeployConnections: vi.fn(),
    getPlatformOAuthStatus: vi.fn(),
    startPlatformLogin: vi.fn(),
    connectPlatform: vi.fn(),
    disconnectPlatform: vi.fn(),
  };
});

const OAUTH_CONNECTION: DeployConnection = {
  platform: 'cloudflare',
  accountName: 'Acme',
  accountId: 'acct-1',
  createdAt: '2026-09-11T00:00:00Z',
  lastUsedAt: null,
  tokenInvalid: false,
  source: 'oauth',
  tokenExpiresAt: '2026-09-11T01:00:00Z',
};

function renderCard() {
  return render(
    <I18nProvider>
      <HostingPlatformsCard />
    </I18nProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.mocked(listDeployConnections).mockReset();
  vi.mocked(getPlatformOAuthStatus).mockReset();
  vi.mocked(startPlatformLogin).mockReset();
  vi.mocked(connectPlatform).mockReset();
  vi.mocked(disconnectPlatform).mockReset();
});

describe('HostingPlatformsCard', () => {
  it('offers the platform login only for available platforms', async () => {
    vi.mocked(listDeployConnections).mockResolvedValue([]);
    vi.mocked(getPlatformOAuthStatus).mockResolvedValue([
      { platform: 'cloudflare', available: true },
      { platform: 'vercel', available: false },
    ]);

    renderCard();

    expect(await screen.findByText('Log in with Cloudflare Pages')).not.toBeNull();
    expect(screen.queryByText('Log in with Vercel')).toBeNull();
    // The token-paste fallback stays available for both platforms.
    expect(screen.getAllByPlaceholderText('API token')).toHaveLength(2);
  });

  it('starts the OAuth login and navigates to the authorize URL', async () => {
    vi.mocked(listDeployConnections).mockResolvedValue([]);
    vi.mocked(getPlatformOAuthStatus).mockResolvedValue([
      { platform: 'cloudflare', available: true },
      { platform: 'vercel', available: false },
    ]);
    vi.mocked(startPlatformLogin).mockResolvedValue({
      url: 'https://dash.example.com/oauth2/auth?state=1',
    });
    const locationStub = { href: 'http://localhost/' };
    vi.stubGlobal('location', locationStub);

    renderCard();

    fireEvent.click(await screen.findByText('Log in with Cloudflare Pages'));

    await waitFor(() => {
      expect(startPlatformLogin).toHaveBeenCalledWith('cloudflare');
    });
    await waitFor(() => {
      expect(locationStub.href).toBe('https://dash.example.com/oauth2/auth?state=1');
    });
  });

  it('shows the auto-renewal note for an OAuth-sourced connection', async () => {
    vi.mocked(listDeployConnections).mockResolvedValue([OAUTH_CONNECTION]);
    vi.mocked(getPlatformOAuthStatus).mockResolvedValue([
      { platform: 'cloudflare', available: true },
      { platform: 'vercel', available: false },
    ]);

    renderCard();

    expect(await screen.findByText('Connected as Acme')).not.toBeNull();
    expect(
      screen.getByText('Connected via OAuth — the token renews automatically'),
    ).not.toBeNull();
    // No login button once the platform is connected.
    expect(screen.queryByText('Log in with Cloudflare Pages')).toBeNull();
  });
});
