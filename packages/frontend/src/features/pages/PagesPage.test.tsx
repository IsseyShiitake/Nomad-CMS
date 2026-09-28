/**
 * Component tests for the repository pages workspace.
 *
 * Pins the reorganized presentation: the Website Pages box uses the
 * capture miniature as its backdrop, the contents card lists only
 * non-HTML files beside the publish panel, and the search still filters
 * the page list.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { listPages, listContents, getDeployLinks, getSession } from '@/api';
import { AuthProvider } from '@/services/auth';
import { I18nProvider } from '@/i18n';
import { ThemeProvider } from '@/services/theme';
import { PagesPage } from './PagesPage';
vi.mock('@/api', () => ({
  listPages: vi.fn(),
  listContents: vi.fn(),
  getDeployLinks: vi.fn(),
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

// jsdom cannot run the real capture pipeline (IntersectionObserver,
// preflight fetch); the stub surfaces the repo name the hero is titled with.
vi.mock('@/ui/components/RepoTile', () => ({
  RepoTile: ({ repo }: { repo: { name: string } }) => (
    <div data-testid="pages-hero">{repo.name}</div>
  ),
}));

const ADMIN_SESSION = {
  user: { id: 1, login: 'octocat', name: 'octocat', avatarUrl: null },
  kind: 'admin' as const,
  repoLock: null,
};

const PAGES = [{ path: 'index.html' }, { path: 'about.html' }];

const CONTENTS = [
  { path: 'assets', name: 'assets', type: 'dir' as const, size: 0, sha: null },
  { path: 'index.html', name: 'index.html', type: 'file' as const, size: 900, sha: 'a' },
  { path: 'about.HTML', name: 'about.HTML', type: 'file' as const, size: 800, sha: 'b' },
  { path: 'style.css', name: 'style.css', type: 'file' as const, size: 700, sha: 'c' },
  { path: 'logo.png', name: 'logo.png', type: 'file' as const, size: 600, sha: 'd' },
];

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/repositories/octocat/site']}>
      <I18nProvider>
        <ThemeProvider>
          <AuthProvider>
            <Routes>
              <Route path="/repositories/:owner/:repo" element={<PagesPage />} />
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

describe('PagesPage', () => {
  it('combines the capture hero and the page list in the Website Pages box', async () => {
    vi.mocked(getSession).mockResolvedValue(ADMIN_SESSION);
    vi.mocked(listPages).mockResolvedValue(PAGES);
    vi.mocked(listContents).mockResolvedValue(CONTENTS);
    vi.mocked(getDeployLinks).mockResolvedValue([]);

    renderPage();

    // The capture backdrop renders the repo miniature; the head panel
    // carries the "Web Pages" title.
    await waitFor(() => {
      expect(screen.getByTestId('pages-hero').textContent).toBe('site');
    });
    expect(screen.getByRole('heading', { level: 3, name: 'Web Pages' })).not.toBeNull();
    expect(screen.getAllByRole('link').map((link) => link.getAttribute('href'))).toEqual(
      expect.arrayContaining([
        '/repositories/octocat/site/editor/index.html',
        '/repositories/octocat/site/editor/about.html',
      ]),
    );
    // Publishing sits in the side column (admin session, nothing linked).
    await screen.findByText('No hosting platform is linked to this repository yet.');
  });

  it('lists only non-HTML files in the repository contents card', async () => {
    vi.mocked(getSession).mockResolvedValue(ADMIN_SESSION);
    vi.mocked(listPages).mockResolvedValue(PAGES);
    vi.mocked(listContents).mockResolvedValue(CONTENTS);
    vi.mocked(getDeployLinks).mockResolvedValue([]);

    renderPage();

    const contentsCard = (await screen.findByText('Repository contents')).closest(
      '.pages-contents',
    );
    expect(contentsCard).not.toBeNull();
    const contents = within(contentsCard as HTMLElement);
    expect(contents.getByText('style.css')).not.toBeNull();
    expect(contents.getByText('logo.png')).not.toBeNull();
    expect(contents.getByRole('button', { name: '📁 assets' })).not.toBeNull();
    // HTML files (any casing) live in the Website Pages box, not here.
    expect(contents.queryByText('index.html')).toBeNull();
    expect(contents.queryByText('about.HTML')).toBeNull();
  });

  it('filters the page list by the search field', async () => {
    vi.mocked(getSession).mockResolvedValue(ADMIN_SESSION);
    vi.mocked(listPages).mockResolvedValue(PAGES);
    vi.mocked(listContents).mockResolvedValue(CONTENTS);
    vi.mocked(getDeployLinks).mockResolvedValue([]);

    renderPage();

    const search = await screen.findByRole('searchbox');

    // No page matches a stray query…
    fireEvent.change(search, { target: { value: 'zzz' } });
    await waitFor(() => {
      expect(screen.getByText('No pages match your search.')).not.toBeNull();
    });

    // …and a matching query narrows the list to the page it names.
    fireEvent.change(search, { target: { value: 'index' } });
    await waitFor(() => {
      expect(screen.getByText('index.html')).not.toBeNull();
    });
    expect(screen.queryByText('about.html')).toBeNull();
  });

  it('switches the page list to two columns only past three pages', async () => {
    vi.mocked(getSession).mockResolvedValue(ADMIN_SESSION);
    vi.mocked(listContents).mockResolvedValue(CONTENTS);
    vi.mocked(getDeployLinks).mockResolvedValue([]);

    vi.mocked(listPages).mockResolvedValue(PAGES);
    const { container } = renderPage();
    let list: HTMLElement | null = await waitFor(() => {
      const el = container.querySelector('.pages-webpages__list');
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    expect(list.classList.contains('pages-webpages__list--multi')).toBe(false);
    cleanup();

    const FOUR_PAGES = [...PAGES, { path: 'c.html' }, { path: 'd.html' }];
    vi.mocked(listPages).mockResolvedValue(FOUR_PAGES);
    renderPage();
    await waitFor(() => {
      list = document.querySelector('.pages-webpages__list');
      expect(list?.classList.contains('pages-webpages__list--multi')).toBe(true);
    });
  });
});
