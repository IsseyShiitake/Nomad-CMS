/**
 * Component tests for the repositories grid filtering.
 *
 * Pins the omit-HTML-less behavior: repositories the backend checked as
 * having no HTML files (hasHtml === false) never render as tiles, while
 * unknown (null/omitted) repositories stay listed.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { listDeployProjects, listRepositories, getSession } from '@/api';
import { AuthProvider } from '@/services/auth';
import { I18nProvider } from '@/i18n';
import { ThemeProvider } from '@/services/theme';
import { RepositoriesPage } from './RepositoriesPage';
import type { Repository } from '@cms/shared';

vi.mock('@/api', () => ({
  listRepositories: vi.fn(),
  listDeployProjects: vi.fn(),
  getSession: vi.fn(),
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

// jsdom cannot run the capture pipeline (IntersectionObserver, preflight
// fetch); the stub surfaces the repo name each tile would carry.
vi.mock('@/ui/components/RepoTile', () => ({
  RepoTile: ({ repo }: { repo: { name: string } }) => (
    <div data-testid="repo-tile">{repo.name}</div>
  ),
}));

const ADMIN_SESSION = {
  user: { id: 1, login: 'octocat', name: 'octocat', avatarUrl: null },
  kind: 'admin' as const,
  repoLock: null,
};

function makeRepo(overrides: Partial<Repository> & { name: string }): Repository {
  return {
    id: 1,
    owner: 'octocat',
    fullName: `octocat/${overrides.name}`,
    defaultBranch: 'main',
    description: null,
    isPrivate: false,
    homepage: null,
    htmlUrl: `https://github.com/octocat/${overrides.name}`,
    updatedAt: '2026-09-01T00:00:00Z',
    ...overrides,
  };
}

function renderPage() {
  return render(
    <MemoryRouter>
      <I18nProvider>
        <ThemeProvider>
          <AuthProvider>
            <Routes>
              <Route path="/" element={<RepositoriesPage />} />
            </Routes>
          </AuthProvider>
        </ThemeProvider>
      </I18nProvider>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
});

describe('RepositoriesPage', () => {
  it('omits repositories checked as HTML-less; unknown ones stay listed', async () => {
    vi.mocked(getSession).mockResolvedValue(ADMIN_SESSION);
    vi.mocked(listDeployProjects).mockResolvedValue([]);
    vi.mocked(listRepositories).mockResolvedValue([
      makeRepo({ id: 1, name: 'editable' }),
      makeRepo({ id: 2, name: 'docs-only', hasHtml: false }),
      makeRepo({ id: 3, name: 'unchecked', hasHtml: null }),
    ]);

    renderPage();

    await waitFor(() => {
      expect(screen.getAllByTestId('repo-tile').map((tile) => tile.textContent)).toEqual([
        'editable',
        'unchecked',
      ]);
    });
    expect(screen.queryByText('docs-only')).toBeNull();
  });
});
