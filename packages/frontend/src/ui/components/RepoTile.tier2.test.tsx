/**
 * Component tests for the RepoTile tier-2 "repo render" fallback.
 *
 * When no live candidate URL answers the preflight, the tile must fetch
 * the repository's own HTML (preferring a root index.html) and render it
 * through the shared buildSrcDoc sanitizer as an srcDoc iframe; a repo
 * with no HTML pages at all, or a failing page fetch, must land on the
 * pastel monogram without a retry loop.
 */
import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Repository } from '@cms/shared';
import { getPage, listPages } from '@/api';
import { I18nProvider } from '@/i18n';
import { RepoTile } from './RepoTile';

vi.mock('@/api', () => ({
  getPage: vi.fn(),
  listPages: vi.fn(),
}));

// No live site answers the tier-1 preflight, forcing the tier-2 path.
vi.stubGlobal(
  'fetch',
  vi.fn(() => Promise.resolve(new Response(null, { status: 404 }))),
);

function repo(overrides: Partial<Repository> = {}): Repository {
  return {
    id: 1,
    name: 'site',
    owner: 'octocat',
    fullName: 'octocat/site',
    defaultBranch: 'main',
    description: null,
    isPrivate: false,
    htmlUrl: 'https://github.com/octocat/site',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

const PAGES = [{ path: 'about.html' }, { path: 'index.html' }];

const PAGE = {
  path: 'index.html',
  content:
    '<!doctype html><html><head><title>Home</title></head><body>' +
    '<script>alert(1)</script><h1>Hello site</h1></body></html>',
  sha: null,
  updatedAt: null,
};

function renderTile(aRepo: Repository) {
  return render(
    <I18nProvider>
      <RepoTile repo={aRepo} />
    </I18nProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('RepoTile tier-2 repo render', () => {
  it('renders the repo HTML as a sanitized srcDoc when no live URL answers', async () => {
    vi.mocked(listPages).mockResolvedValue(PAGES);
    vi.mocked(getPage).mockResolvedValue(PAGE);

    renderTile(repo());

    const iframe = await waitFor(() => {
      const el = document.querySelector('iframe.repo-thumb__iframe');
      expect(el).not.toBeNull();
      return el as HTMLIFrameElement;
    });
    // The page pick prefers the root index.html over other root pages.
    expect(vi.mocked(getPage)).toHaveBeenCalledWith('octocat', 'site', 'index.html');
    const srcdoc = iframe.getAttribute('srcdoc') ?? '';
    // Sanitized: scripts stripped, same-origin asset base injected.
    expect(srcdoc).not.toContain('<script');
    expect(srcdoc).toContain('Hello site');
    expect(srcdoc).toContain('/api/repositories/octocat/site/raw/');
  });

  it('falls back to the monogram when the repo has no HTML pages', async () => {
    vi.mocked(listPages).mockResolvedValue([]);

    renderTile(repo());

    // failed=true unmounts the capture frame; only the monogram remains.
    // (The monogram div alone proves nothing — it is visible under the
    // capture until the first load fades in.)
    await waitFor(() => {
      expect(document.querySelector('.repo-thumb__frame')).toBeNull();
    });
    expect(document.querySelector('.repo-thumb__fallback')).not.toBeNull();
    expect(document.querySelector('iframe.repo-thumb__iframe')).toBeNull();
    expect(vi.mocked(getPage)).not.toHaveBeenCalled();
  });

  it('falls back to the monogram when the page fetch fails — no retry loop', async () => {
    vi.mocked(listPages).mockResolvedValue(PAGES);
    vi.mocked(getPage).mockRejectedValue(new Error('github down'));

    renderTile(repo());

    await waitFor(() => {
      expect(document.querySelector('.repo-thumb__frame')).toBeNull();
    });
    expect(document.querySelector('.repo-thumb__fallback')).not.toBeNull();
    expect(document.querySelector('iframe.repo-thumb__iframe')).toBeNull();
    // One attempt only: a single tier-2 page fetch, no retries.
    expect(vi.mocked(getPage)).toHaveBeenCalledTimes(1);
  });

  it('strips meta refresh tags from the sanitized srcDoc', async () => {
    vi.mocked(listPages).mockResolvedValue(PAGES);
    vi.mocked(getPage).mockResolvedValue({
      ...PAGE,
      content:
        '<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=https://evil.example/"></head><body><h1>Redirect page</h1></body></html>',
    });

    renderTile(repo());

    const iframe = await waitFor(() => {
      const el = document.querySelector('iframe.repo-thumb__iframe');
      expect(el).not.toBeNull();
      return el as HTMLIFrameElement;
    });
    const srcdoc = iframe.getAttribute('srcdoc') ?? '';
    // A meta refresh must not survive: it would navigate the sandboxed
    // frame away from the preview.
    expect(srcdoc).not.toContain('http-equiv="refresh"');
    expect(srcdoc).toContain('Redirect page');
  });
});
