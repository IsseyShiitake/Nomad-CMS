/**
 * Component tests for the editor page.
 *
 * Invariants:
 * 1. The route param arrives already decoded by react-router (including
 *    %2F → /); the page must pass it through untouched. A second
 *    decodeURIComponent would throw on filenames containing a literal "%"
 *    and would corrupt filenames containing a literal "%2F".
 * 2. The live preview iframe must be sandboxed without `allow-scripts`: the
 *    previewed HTML is arbitrary repository content and its JavaScript must
 *    never run inside the CMS origin (a script could otherwise issue
 *    credentialed API calls with the user's session cookie). The preview
 *    uses `allow-same-origin` so same-origin asset requests carry the
 *    session cookie; the highlight overlay stays CSS-only.
 * 3. Unsaved edits survive a locale switch (the load effect must not
 *    re-run for the i18n messages object) and are guarded on navigation
 *    (a data-router blocker asks for confirmation).
 */
import { fireEvent, render, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getPage, getSession, savePage } from '@/api';
import { AuthProvider } from '@/services/auth';
import { I18nProvider, useI18n } from '@/i18n';
import { EditorPage } from './EditorPage';

vi.mock('@/api', () => ({
  getPage: vi.fn(),
  savePage: vi.fn(),
  getSession: vi.fn(),
  getRepository: vi.fn().mockRejectedValue(new Error('not available in tests')),
  logout: vi.fn(),
  setUnauthorizedHandler: vi.fn(),
}));

const FIXTURE = `<!doctype html>
<html><head><title>T</title></head><body><h1>Hello</h1></body></html>`;

/** Admin session as returned by GET /api/auth/session. */
const ADMIN_SESSION = {
  user: { id: 1, login: 'octocat', name: null, avatarUrl: null },
  kind: 'admin' as const,
  repoLock: null,
};

/** A page carrying one editable paragraph. */
const EDITABLE_FIXTURE = `<!doctype html>
<html><head><title>T</title></head><body><p data-editable>Hi</p></body></html>`;

/** Renders the editor at a route through a data router (useBlocker needs one). */
function renderEditor(entry: string) {
  const router = createMemoryRouter(
    [
      {
        path: '/repositories/:owner/:repo/editor/:path',
        element: (
          <I18nProvider>
            <AuthProvider>
              <EditorPage />
            </AuthProvider>
          </I18nProvider>
        ),
      },
      { path: '/pages', element: <div>pages</div> },
    ],
    { initialEntries: [entry] },
  );
  return render(<RouterProvider router={router} />);
}

afterEach(() => {
  vi.mocked(getSession).mockReset();
  vi.mocked(getPage).mockReset();
  vi.mocked(savePage).mockReset();
  vi.restoreAllMocks();
});

describe('EditorPage', () => {
  it('passes the already-decoded route path through untouched', async () => {
    vi.mocked(getSession).mockResolvedValue(ADMIN_SESSION);
    vi.mocked(getPage).mockResolvedValue({
      path: 'src/pages/index.html',
      content: FIXTURE,
      sha: 'sha-1',
      updatedAt: null,
    });

    renderEditor('/repositories/octocat/site/editor/src%2Fpages%2Findex.html');

    // The nested path must reach getPage decoded exactly once.
    await waitFor(() => {
      expect(vi.mocked(getPage)).toHaveBeenCalledWith(
        'octocat',
        'site',
        'src/pages/index.html',
      );
    });
  });

  it('does not re-decode filenames containing a literal percent', async () => {
    vi.mocked(getSession).mockResolvedValue(ADMIN_SESSION);
    vi.mocked(getPage).mockResolvedValue({
      path: '50%off.html',
      content: FIXTURE,
      sha: 'sha-1',
      updatedAt: null,
    });

    // %25 decodes to a literal "%"; the param is "50%off.html". A second
    // decodeURIComponent would throw URIError and the page would never load.
    renderEditor('/repositories/octocat/site/editor/50%25off.html');

    await waitFor(() => {
      expect(vi.mocked(getPage)).toHaveBeenCalledWith('octocat', 'site', '50%off.html');
    });
  });

  it('sandboxes the live preview iframe (highlight overlay must not relax it)', async () => {
    vi.mocked(getSession).mockResolvedValue(ADMIN_SESSION);
    vi.mocked(getPage).mockResolvedValue({
      path: 'index.html',
      content: FIXTURE,
      sha: 'sha-1',
      updatedAt: null,
    });

    const { container } = renderEditor('/repositories/octocat/site/editor/index.html');

    await waitFor(() => {
      const iframe = container.querySelector('iframe');
      expect(iframe).not.toBeNull();
      // The invariant is "no site JavaScript": allow-scripts must never be
      // granted, whatever else the sandbox allows (allow-same-origin is
      // required so preview asset requests carry the session cookie).
      expect(iframe?.getAttribute('sandbox')).not.toContain('allow-scripts');
    });
  });

  it('neutralizes links and stamps editable ids in the preview srcdoc', async () => {
    vi.mocked(getSession).mockResolvedValue(ADMIN_SESSION);
    vi.mocked(getPage).mockResolvedValue({
      path: 'index.html',
      content:
        '<!doctype html><html><head><title>T</title></head><body><p data-editable>Hi</p><a href="https://example.com/page">go</a></body></html>',
      sha: 'sha-1',
      updatedAt: null,
    });

    const { container } = renderEditor('/repositories/octocat/site/editor/index.html');

    // The preview reload is debounced (~250 ms) — wait for the stamped id,
    // which only exists once the real page content reached the iframe.
    await waitFor(() => {
      expect(container.querySelector('iframe')?.getAttribute('srcdoc')).toContain(
        'data-cms-element-id',
      );
    });

    const srcdoc = container.querySelector('iframe')?.getAttribute('srcdoc') ?? '';
    const parsed = new DOMParser().parseFromString(srcdoc, 'text/html');
    // Links survive as styled anchors but can no longer navigate…
    const anchor = parsed.querySelector('a');
    expect(anchor).not.toBeNull();
    expect(anchor?.hasAttribute('href')).toBe(false);
    // …and the editable block carries the exact id its panel row uses
    // (only <p> among its siblings → no :nth-of-type qualification).
    expect(parsed.querySelector('p')?.getAttribute('data-cms-element-id')).toBe(
      'el--html > body > p',
    );
  });

  it('zoom buttons adjust the preview scale', async () => {
    vi.mocked(getSession).mockResolvedValue(ADMIN_SESSION);
    vi.mocked(getPage).mockResolvedValue({
      path: 'index.html',
      content: FIXTURE,
      sha: 'sha-1',
      updatedAt: null,
    });

    const { container } = renderEditor('/repositories/octocat/site/editor/index.html');

    await waitFor(() => expect(container.querySelector('iframe')).not.toBeNull());

    // jsdom has no layout: clientWidth is 0 → fit scale 1.
    const scope = within(container);
    expect(scope.getByText('100%')).not.toBeNull();

    fireEvent.click(scope.getByLabelText('Zoom in'));
    expect(scope.getByText('125%')).not.toBeNull();
    expect((container.querySelector('iframe') as HTMLIFrameElement).style.transform).toBe(
      'scale(1.25)',
    );

    const fit = scope.getByRole('button', { name: 'Fit' }) as HTMLButtonElement;
    fireEvent.click(fit);
    expect(scope.getByText('100%')).not.toBeNull();
    expect(fit.disabled).toBe(true);
  });

  it('asks for confirmation before leaving a dirty editor, and stays on reject', async () => {
    vi.mocked(getSession).mockResolvedValue(ADMIN_SESSION);
    vi.mocked(getPage).mockResolvedValue({
      path: 'index.html',
      content: EDITABLE_FIXTURE,
      sha: 'sha-1',
      updatedAt: null,
    });

    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const router = createMemoryRouter(
      [
        {
          path: '/repositories/:owner/:repo/editor/:path',
          element: (
            <I18nProvider>
              <AuthProvider>
                <EditorPage />
              </AuthProvider>
            </I18nProvider>
          ),
        },
        { path: '/pages', element: <div>pages</div> },
      ],
      { initialEntries: ['/repositories/octocat/site/editor/index.html'] },
    );
    const { container } = render(<RouterProvider router={router} />);
    await waitFor(() => expect(container.querySelector('iframe')).not.toBeNull());

    // Make an edit: the document becomes dirty.
    fireEvent.change(container.querySelector('textarea')!, {
      target: { value: 'Changed text' },
    });
    await waitFor(() => {
      expect(container.querySelector('.editor-page__unsaved')).not.toBeNull();
    });

    // Leave: the blocker fires and confirm() rejects — we stay. The
    // confirm runs in an effect after the navigation is blocked.
    await router.navigate('/pages');
    await waitFor(() => {
      expect(confirmSpy).toHaveBeenCalled();
    });
    expect(container.querySelector('textarea')).not.toBeNull();
  });

  it('navigates away when the user accepts the unsaved-changes prompt', async () => {
    vi.mocked(getSession).mockResolvedValue(ADMIN_SESSION);
    vi.mocked(getPage).mockResolvedValue({
      path: 'index.html',
      content: EDITABLE_FIXTURE,
      sha: 'sha-1',
      updatedAt: null,
    });

    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const router = createMemoryRouter(
      [
        {
          path: '/repositories/:owner/:repo/editor/:path',
          element: (
            <I18nProvider>
              <AuthProvider>
                <EditorPage />
              </AuthProvider>
            </I18nProvider>
          ),
        },
        { path: '/pages', element: <div>pages</div> },
      ],
      { initialEntries: ['/repositories/octocat/site/editor/index.html'] },
    );
    const { container } = render(<RouterProvider router={router} />);
    await waitFor(() => expect(container.querySelector('iframe')).not.toBeNull());

    fireEvent.change(container.querySelector('textarea')!, {
      target: { value: 'Changed text' },
    });
    await waitFor(() => {
      expect(container.querySelector('.editor-page__unsaved')).not.toBeNull();
    });

    await router.navigate('/pages');
    await waitFor(() => {
      expect(container.textContent).toContain('pages');
    });
  });

  it('keeps unsaved edits when the UI language is toggled', async () => {
    vi.mocked(getSession).mockResolvedValue(ADMIN_SESSION);
    vi.mocked(getPage).mockResolvedValue({
      path: 'index.html',
      content: EDITABLE_FIXTURE,
      sha: 'sha-1',
      updatedAt: null,
    });

    // A locale probe captures the I18nProvider's setLocale so the test can
    // flip the locale (changing the messages object identity) while the
    // editor stays mounted — exactly what the header's toggle does.
    let i18nSetLocale: (l: 'en' | 'fr') => void = () => {};
    function LocaleProbe() {
      const { setLocale } = useI18n();
      i18nSetLocale = setLocale;
      return null;
    }

    const router = createMemoryRouter(
      [
        {
          path: '/repositories/:owner/:repo/editor/:path',
          element: (
            <I18nProvider>
              <AuthProvider>
                <LocaleProbe />
                <EditorPage />
              </AuthProvider>
            </I18nProvider>
          ),
        },
      ],
      { initialEntries: ['/repositories/octocat/site/editor/index.html'] },
    );
    const { container } = render(<RouterProvider router={router} />);
    await waitFor(() => expect(container.querySelector('iframe')).not.toBeNull());

    fireEvent.change(container.querySelector('textarea')!, {
      target: { value: 'Texte modifié' },
    });
    await waitFor(() => {
      expect(container.querySelector('.editor-page__unsaved')).not.toBeNull();
    });

    const callsBefore = vi.mocked(getPage).mock.calls.length;
    i18nSetLocale('fr');
    // ES2022 lib: executor form (Promise.withResolvers is ES2024).
    const settle = new Promise<void>((resolve) => {
      setTimeout(resolve, 50);
    });
    await settle;

    // The load effect must not have re-run: no new getPage call, edits kept.
    expect(vi.mocked(getPage).mock.calls.length).toBe(callsBefore);
    const textarea = container.querySelector('textarea');
    expect(textarea?.textContent ?? '').toContain('Texte modifié');
  });
});
