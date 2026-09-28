import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import { Link, Navigate } from 'react-router';
import type { PageSummary, Repository } from '@cms/shared';
import { listPages, ApiClientError } from '@/api';
import { PublishPanel } from '@/features/publish/PublishPanel';
import { useAuth } from '@/services/auth';
import { fmt, useI18n } from '@/i18n';
import { ErrorBanner } from '@/ui/components/ErrorBanner';
import { Spinner } from '@/ui/components/Spinner';
import { RepoTile } from '@/ui/components/RepoTile';
import './ClientPages.css';

/**
 * Client workspace: the page list of the single repository the client
 * session is locked to. Owner/repo always come from the session's
 * repoLock — never from the URL — and the backend enforces the same
 * lock on every request.
 *
 * Flow: while closed, the locked repository is presented as a
 * full-viewport hero — a giant miniature-capture tile of the live
 * site. Selecting it shrinks the repo into a compact banner and the
 * page list slides up from beneath it.
 */
export function ClientPagesPage() {
  const { m } = useI18n();
  const { isLoading: authLoading, isAuthenticated, isClient, repoLock, user } = useAuth();

  const [pages, setPages] = useState<PageSummary[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pagesOpen, setPagesOpen] = useState(false);

  const owner = repoLock?.owner ?? '';
  const repo = repoLock?.repo ?? '';

  const load = useCallback(async () => {
    if (!isClient || !owner || !repo) return;
    setIsLoading(true);
    setError(null);
    try {
      setPages(await listPages(owner, repo));
    } catch (err) {
      setError(
        err instanceof ApiClientError && err.code === 'backing_token_invalid'
          ? m.client.backingTokenInvalid
          : m.pages.loadFailed,
      );
    } finally {
      setIsLoading(false);
    }
  }, [isClient, owner, repo, m]);

  useEffect(() => {
    void load();
  }, [load]);

  if (authLoading) return <Spinner />;
  if (!isAuthenticated) return <Navigate to="/login" replace />;
  if (!isClient) return <Navigate to="/repositories" replace />;

  // The session's repoLock expressed as a Repository-shaped object so
  // it can be rendered through the shared RepoTile component.
  const lockedRepo: Repository = {
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

  if (!pagesOpen) {
    return (
      <section className="page client-pages">
        <div className="client-pages__hero">
          <p className="client-pages__kicker">{m.client.expandHint}</p>
          <h2 className="client-pages__guide">
            {fmt(m.client.welcome, { label: user?.login ?? '' })}
          </h2>
          <RepoTile
            repo={lockedRepo}
            size="tile"
            className="client-pages__hero-tile"
            onSelect={() => setPagesOpen(true)}
          />
          {error && <ErrorBanner onDismiss={() => setError(null)}>{error}</ErrorBanner>}
          {isLoading && <Spinner />}
        </div>
      </section>
    );
  }

  return (
    <section className="page client-pages client-pages--open">
      <div className="client-pages__banner">
        <RepoTile repo={lockedRepo} size="banner" className="client-pages__banner-tile" />
        <div className="client-pages__banner-text">
          <p className="client-pages__kicker">{m.client.myPagesTitle}</p>
          <h2 className="client-pages__repo">{repo}</h2>
        </div>
      </div>

      <div className="client-pages__drawer client-pages__drawer--open">
        <div className="client-pages__drawer-head">
          <h3 className="client-pages__guide client-pages__guide--sub">{m.pages.selectGuide}</h3>
          <button
            type="button"
            className="btn client-pages__back"
            onClick={() => setPagesOpen(false)}
          >
            {m.client.backToPages}
          </button>
        </div>

        {error && <ErrorBanner onDismiss={() => setError(null)}>{error}</ErrorBanner>}

        {isLoading ? (
          <Spinner />
        ) : pages.length === 0 ? (
          <p className="page-status">{m.pages.empty}</p>
        ) : (
          <ul className="page-list client-pages__list">
            {pages.map((page, index) => (
              <li
                key={page.path}
                className="client-pages__card"
                style={{ '--i': index } as CSSProperties}
              >
                <Link to={`/client/editor/${encodeURIComponent(page.path)}`}>
                  <span className="page-list__item">
                    <span className="page-list__path">{page.path}</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}

        <PublishPanel owner={owner} repo={repo} />
      </div>
    </section>
  );
}
