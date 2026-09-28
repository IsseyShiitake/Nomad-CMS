/**
 * Component tests for the client workspace page.
 *
 * Verifies the hero → banner + drawer flow for the single repository
 * the client session is locked to, and that a dead backing GitHub
 * token (backing_token_invalid) keeps the client signed in and renders
 * a clear, actionable message instead of the generic load failure.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { listPages, getSession, ApiClientError } from '@/api';
import { AuthProvider } from '@/services/auth';
import { I18nProvider } from '@/i18n';
import { ThemeProvider } from '@/services/theme';
import { ClientPagesPage } from './ClientPagesPage';
vi.mock('@/api', () => ({
  listPages: vi.fn(),
  getSession: vi.fn(),
  clientLogin: vi.fn(),
  logout: vi.fn(),
  setUnauthorizedHandler: vi.fn(),
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

// Avoid iframe/jsdom noise from the real miniature-capture tile.
vi.mock('@/ui/components/RepoTile', () => ({
  RepoTile: ({ repo, onSelect }: any) => (
    <button type="button" onClick={onSelect}>
      {repo.name}
    </button>
  ),
}));

const CLIENT_SESSION = {
  user: { id: 0, login: 'acme', name: 'acme', avatarUrl: null },
  kind: 'client' as const,
  repoLock: { owner: 'octocat', repo: 'site' },
};

const PAGES = [{ path: 'index.html' }, { path: 'about.html' }];

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/client']}>
      <I18nProvider>
        <ThemeProvider>
          <AuthProvider>
            <ClientPagesPage />
          </AuthProvider>
        </ThemeProvider>
      </I18nProvider>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
});

describe('ClientPagesPage', () => {
  it('welcomes the client and shows the locked repo as a hero tile', async () => {
    vi.mocked(getSession).mockResolvedValue(CLIENT_SESSION);
    vi.mocked(listPages).mockResolvedValue(PAGES);

    renderPage();

    await waitFor(() => {
      expect(screen.getByText('Welcome, acme')).not.toBeNull();
    });
    expect(screen.getByText('Your pages are loading — pick one to edit')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'site' })).not.toBeNull();
    // The page list stays hidden until the hero tile is selected.
    expect(screen.queryAllByRole('link')).toHaveLength(0);
  });

  it('expands the hero tile into a banner and reveals the page list', async () => {
    vi.mocked(getSession).mockResolvedValue(CLIENT_SESSION);
    vi.mocked(listPages).mockResolvedValue(PAGES);

    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'site' }));

    await waitFor(() => {
      expect(screen.getAllByRole('link').map((link) => link.getAttribute('href'))).toEqual([
        '/client/editor/index.html',
        '/client/editor/about.html',
      ]);
    });
    expect(screen.getByText('Select a page to start editing')).not.toBeNull();
    expect(screen.getByText('index.html')).not.toBeNull();

    // Collapsing hides the drawer again and restores the hero tile.
    fireEvent.click(screen.getByRole('button', { name: 'Back to pages' }));
    expect(screen.queryAllByRole('link')).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'site' })).not.toBeNull();
  });

  it('explains a dead backing token instead of the generic failure', async () => {
    vi.mocked(getSession).mockResolvedValue(CLIENT_SESSION);
    vi.mocked(listPages).mockRejectedValue(
      new ApiClientError(403, 'backing_token_invalid', 'nope'),
    );

    renderPage();

    await waitFor(() => {
      expect(
        screen.getByText(
          'There is a problem with this access — the GitHub connection behind it has expired or been revoked. Please ask the administrator to recreate your access.',
        ),
      ).not.toBeNull();
    });
  });

  it('shows the generic failure for other errors', async () => {
    vi.mocked(getSession).mockResolvedValue(CLIENT_SESSION);
    vi.mocked(listPages).mockRejectedValue(
      new ApiClientError(502, 'github_error', 'boom'),
    );

    renderPage();

    await waitFor(() => {
      expect(screen.getByText('Failed to discover HTML files.')).not.toBeNull();
    });
  });
});
