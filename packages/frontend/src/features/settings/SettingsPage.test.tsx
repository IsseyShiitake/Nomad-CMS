/**
 * Component tests for the review queue's failure handling.
 *
 * Audit 2026-11-15: a queue load failure used to collapse into the
 * "nothing to approve" empty state — pending client changes silently looked
 * nonexistent. It now shows a dedicated retry note instead of the empty
 * message.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  listClients,
  listRepositories,
  listReviewPullRequests,
  mergeReviewPullRequest,
} from '@/api';
import { I18nProvider } from '@/i18n';
import { SettingsPage } from './SettingsPage';
import type { ClientAccess, Repository, ReviewPullRequest } from '@cms/shared';

vi.mock('@/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api')>();
  return {
    ...actual,
    listClients: vi.fn(),
    listRepositories: vi.fn(),
    listReviewPullRequests: vi.fn(),
    mergeReviewPullRequest: vi.fn(),
  };
});

vi.mock('@/services/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/auth')>();
  return {
    ...actual,
    useAuth: () => ({
      isLoading: false,
      session: null,
      user: null,
      isAuthenticated: true,
      kind: 'admin',
      isAdmin: true,
      isClient: false,
      repoLock: null,
      login: vi.fn(),
      logout: vi.fn(),
      refresh: vi.fn(),
    }),
  };
});

const ACCESS: ClientAccess = {
  clientId: 'acme-corp',
  label: 'ACME Corp',
  repo: { owner: 'octocat', repo: 'site' },
  createdBy: 'octocat',
  createdAt: '2026-11-15T00:00:00Z',
  lastUsedAt: null,
  revoked: false,
};

const REPO: Repository = {
  id: 1,
  name: 'site',
  owner: 'octocat',
  fullName: 'octocat/site',
  defaultBranch: 'main',
  description: null,
  isPrivate: false,
  homepage: null,
  htmlUrl: 'https://github.com/octocat/site',
  updatedAt: '2026-11-15T00:00:00Z',
};

const PR: ReviewPullRequest = {
  owner: 'octocat',
  repo: 'site',
  number: 7,
  title: 'CMS changes from ACME Corp',
  url: 'https://github.com/octocat/site/pull/7',
  branch: 'cms/acme-corp',
  baseBranch: 'main',
  updatedAt: '2026-11-15T00:00:00Z',
  clientId: 'acme-corp',
  label: 'ACME Corp',
};

function renderPage() {
  return render(
    <I18nProvider>
      <SettingsPage />
    </I18nProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.mocked(listClients).mockReset();
  vi.mocked(listRepositories).mockReset();
  vi.mocked(listReviewPullRequests).mockReset();
  vi.mocked(mergeReviewPullRequest).mockReset();
});

function happyMocks() {
  vi.mocked(listClients).mockResolvedValue([ACCESS]);
  vi.mocked(listRepositories).mockResolvedValue([REPO]);
}

describe('SettingsPage review queue failure (audit 2026-11-15)', () => {
  it('shows a retry note instead of the empty state when the queue fails to load', async () => {
    happyMocks();
    vi.mocked(listReviewPullRequests).mockRejectedValue(new Error('queue down'));

    renderPage();

    await waitFor(() => {
      expect(screen.getByText(/Could not load the review queue/)).not.toBeNull();
    });
    // The failure must NOT read as "nothing to approve".
    expect(screen.queryByText('No changes waiting for review.')).toBeNull();
    expect(screen.getByRole('button', { name: 'Retry' })).not.toBeNull();
  });

  it('recovers on retry: the pending change appears', async () => {
    happyMocks();
    vi.mocked(listReviewPullRequests)
      .mockRejectedValueOnce(new Error('queue down'))
      .mockResolvedValue([PR]);

    renderPage();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Retry' })).not.toBeNull();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => {
      expect(screen.getByRole('link', { name: 'View on GitHub' })).not.toBeNull();
    });
    expect(screen.queryByText(/Could not load the review queue/)).toBeNull();
    expect(vi.mocked(listReviewPullRequests)).toHaveBeenCalledTimes(2);
  });

  it('keeps the plain empty state when the queue loads but is empty', async () => {
    happyMocks();
    vi.mocked(listReviewPullRequests).mockResolvedValue([]);

    renderPage();

    await waitFor(() => {
      expect(screen.getByText('No changes waiting for review.')).not.toBeNull();
    });
    expect(screen.queryByText(/Could not load the review queue/)).toBeNull();
  });
});
