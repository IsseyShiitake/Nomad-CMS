import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { Link, useParams } from 'react-router';
import type { PageSummary, Repository, RepositoryFile } from '@cms/shared';
import { listContents, listPages } from '@/api';
import { PublishPanel } from '@/features/publish/PublishPanel';
import { useAuth } from '@/services/auth';
import { fmt, useI18n } from '@/i18n';
import { Card } from '@/ui/components/Card';
import { ErrorBanner } from '@/ui/components/ErrorBanner';
import { Spinner } from '@/ui/components/Spinner';
import { RepoTile } from '@/ui/components/RepoTile';
import './Pages.css';

/** Navigation state for this route. */
type NavState = {
  owner: string;
  repo: string;
};

/** HTML files are listed in the Website Pages box, not the contents card. */
function isHtmlFileName(name: string): boolean {
  return /\.html?$/i.test(name);
}

/**
 * Pages page.
 *
 * Lists HTML files discovered in a repository and supports browsing the
 * repository's other contents (non-HTML files) via the contents API.
 *
 * Presentation: a compact kicker/guide header row, then two matched
 * columns — the Website Pages box on the left (the live-site miniature
 * fills it as a backdrop, content floats above as glass) and, on the
 * right, repository contents stacked above the publish panel. Both
 * columns share one height and absorb long lists through internal
 * scrolling.
 */
export function PagesPage() {
  const { m } = useI18n();
  const { owner = '', repo = '' } = useParams<NavState>();
  const { isAuthenticated, isLoading: authLoading, login } = useAuth();

  const [htmlFiles, setHtmlFiles] = useState<PageSummary[]>([]);
  const [contents, setContents] = useState<RepositoryFile[]>([]);
  const [currentPath, setCurrentPath] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Search filtering.
  const [searchQuery, setSearchQuery] = useState('');

  // The route's owner/repo expressed as a Repository-shaped object so
  // it can be rendered through the shared RepoTile miniature.
  const bannerRepo: Repository = {
    id: 0,
    name: repo,
    owner,
    fullName: `${owner}/${repo}`,
    defaultBranch: 'main',
    description: null,
    isPrivate: false,
    htmlUrl: '',
    updatedAt: '',
  };

  // Load discovered HTML files for the repository. Drives the page-level
  // loading state so the spinner reflects a real load.
  const loadPages = useCallback(async () => {
    if (!isAuthenticated) return;
    setIsLoading(true);
    setError(null);
    try {
      setHtmlFiles(await listPages(owner, repo));
    } catch {
      setError(m.pages.loadFailed);
    } finally {
      setIsLoading(false);
    }
  }, [owner, repo, isAuthenticated, m]);

  // Load directory contents at the current path. Re-runs on directory
  // navigation without toggling the page-level spinner.
  const loadContents = useCallback(async () => {
    if (!isAuthenticated) return;
    try {
      setContents(await listContents(owner, repo, currentPath));
    } catch {
      setError(m.pages.contentsFailed);
    }
  }, [owner, repo, currentPath, isAuthenticated, m]);

  useEffect(() => {
    void loadPages();
  }, [loadPages]);

  useEffect(() => {
    void loadContents();
  }, [loadContents]);

  /** Navigates into a directory. */
  const enterDirectory = (path: string) => {
    setCurrentPath(path);
    setError(null);
  };

  /** Navigates to the parent directory. */
  const goUp = () => {
    const parts = currentPath.split('/').filter(Boolean);
    parts.pop();
    setCurrentPath(parts.join('/'));
    setError(null);
  };

  const directories = contents.filter((file) => file.type === 'dir');
  const showFiles = contents.filter(
    (file) => file.type === 'file' && !isHtmlFileName(file.name),
  );

  /** HTML files matching the current search query. */
  const visibleHtmlFiles = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return htmlFiles;
    return htmlFiles.filter((page) => page.path.toLowerCase().includes(query));
  }, [htmlFiles, searchQuery]);

  if (authLoading) return <Spinner />;
  if (!isAuthenticated) {
    return (
      <section className="auth-card">
        <h2>{m.auth.signInToBrowseTitle}</h2>
        <p>{m.auth.signInToBrowseBody}</p>
        <button type="button" className="btn btn--primary" onClick={login}>
          {m.header.signInGithub}
        </button>
        <Link className="auth-card__client-link" to="/login">
          {m.auth.clientLink}
        </Link>
      </section>
    );
  }
  if (isLoading) return <Spinner />;

  return (
    <section className="page pages">
      <div className="pages-banner">
        <div className="pages-banner__text">
          <p className="pages-banner__kicker">
            {fmt(m.pages.title, { repo: `${owner}/${repo}` })}
          </p>
          <h2 className="pages-banner__guide">{m.pages.selectGuide}</h2>
        </div>
        <Link to="/repositories" className="btn pages-banner__back">
          {m.pages.breadcrumb}
        </Link>
      </div>

      {error && <ErrorBanner onDismiss={() => setError(null)}>{error}</ErrorBanner>}

      <div className="pages-columns">
        <Card className="pages-card pages-webpages">
          {/* The live-site capture fills the box as its background — cover-fit
              (never stretched), clipped to the card's rounded corners. It is
              pure decoration: no pointer events, hidden from AT. */}
          <div className="pages-webpages__capture" aria-hidden="true">
            <RepoTile repo={bannerRepo} size="tile" className="pages-webpages__capture-tile" />
          </div>

          <div className="pages-webpages__content">
            <div className="pages-drawer__head">
              <h3 className="pages-drawer__sub">{m.pages.htmlFiles}</h3>
              {htmlFiles.length > 0 && (
                <div className="pages-drawer__search">
                  <input
                    type="search"
                    className="pages-toolbar__search"
                    placeholder={m.pages.searchPlaceholder}
                    aria-label={m.pages.searchAria}
                    value={searchQuery}
                    onChange={(event) => setSearchQuery(event.target.value)}
                  />
                </div>
              )}
            </div>

            {htmlFiles.length === 0 ? (
              <p className="page-status pages-webpages__status">{m.pages.empty}</p>
            ) : visibleHtmlFiles.length === 0 ? (
              <p className="page-status pages-webpages__status">{m.pages.noMatch}</p>
            ) : (
              <ul
              className={
                'page-list pages-webpages__list' +
                (visibleHtmlFiles.length > 3 ? ' pages-webpages__list--multi' : '')
              }
            >
                {visibleHtmlFiles.map((page, index) => (
                  <li key={page.path} style={{ '--i': index } as CSSProperties}>
                    <Link to={`/repositories/${owner}/${repo}/editor/${encodeURIComponent(page.path)}`}>
                      <span className="page-list__item">
                        <span className="page-list__path">{page.path}</span>
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Card>

        <div className="pages-side">
          <Card className="pages-card pages-contents">
            <h3 className="pages-contents__title">{m.pages.repoContents}</h3>

            <div className="pages-contents__body">
              <div className="file-nav">
                {currentPath && (
                  <button type="button" className="file-nav__up" onClick={goUp}>
                    {m.pages.parentDir}
                  </button>
                )}
                <p className="file-nav__path">/{currentPath || ''}</p>
              </div>

              {directories.length > 0 && (
                <>
                  <h4>{m.pages.directories}</h4>
                  <ul className="page-list">
                    {directories.map((dir) => (
                      <li key={dir.path}>
                        <button type="button" className="file-nav__dir" onClick={() => enterDirectory(dir.path)}>
                          📁 {dir.name}
                        </button>
                      </li>
                    ))}
                  </ul>
                </>
              )}

              {showFiles.length > 0 && (
                <>
                  <h4>{m.pages.files}</h4>
                  <ul className="page-list">
                    {showFiles.map((file) => (
                      <li key={file.path}>{file.name}</li>
                    ))}
                  </ul>
                </>
              )}

              {contents.length === 0 ? (
                <p className="page-status">{m.pages.emptyRepo}</p>
              ) : directories.length === 0 && showFiles.length === 0 ? (
                <p className="page-status">{m.pages.onlyPages}</p>
              ) : null}
            </div>
          </Card>

          <PublishPanel owner={owner} repo={repo} />
        </div>
      </div>
    </section>
  );
}
