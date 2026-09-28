import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { Link, useNavigate } from 'react-router';
import type { Repository } from '@cms/shared';
import { listDeployProjects, listRepositories } from '@/api';
import { useAuth } from '@/services/auth';
import { useI18n } from '@/i18n';
import { ErrorBanner } from '@/ui/components/ErrorBanner';
import { Spinner } from '@/ui/components/Spinner';
import { RepoTile } from '@/ui/components/RepoTile';
import './Repositories.css';

/** Repository visibility filter options. */
type VisibilityFilter = 'all' | 'public' | 'private';
/**
 * Repositories page.
 *
 * Presents the user's repositories as full-bleed miniature captures of
 * their live sites in a two-column grid (single column on small screens).
 * Selecting one navigates to its pages (HTML file discovery).
 */
export function RepositoriesPage() {
  const { m } = useI18n();
  const { isAuthenticated, isLoading: authLoading, login } = useAuth();
  const navigate = useNavigate();
  const [repositories, setRepositories] = useState<Repository[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Platform live URLs per repository (Cloudflare/Vercel projects linked to
  // the repo). Best-effort: the grid works without them.
  const [liveUrlByRepo, setLiveUrlByRepo] = useState<Map<string, string>>(new Map());

  // Search and filtering.
  const [searchQuery, setSearchQuery] = useState('');
  const [visibility, setVisibility] = useState<VisibilityFilter>('all');

  // Auth is via the HttpOnly session cookie (sent automatically by the
  // client). Load only once the session is restored.
  const load = useCallback(async () => {
    if (!isAuthenticated) {
      return;
    }

    setIsLoading(true);
    try {
      // Repositories and platform projects are independent — fetch both at
      // once (the projects lookup is best-effort on top of the settled
      // repo list either way).
      const [repoList, projectList] = await Promise.allSettled([
        listRepositories(),
        listDeployProjects(),
      ]);
      if (repoList.status === 'fulfilled') {
        setRepositories(repoList.value);
      } else {
        setError(m.repositories.loadFailed);
      }
      if (projectList.status === 'fulfilled') {
        const byRepo = new Map<string, string>();
        for (const project of projectList.value) {
          if (project.repo && project.url && !byRepo.has(project.repo)) {
            byRepo.set(project.repo, project.url);
          }
        }
        setLiveUrlByRepo(byRepo);
      }
      // Projects rejected: not connected / not admin — silently keep the
      // conventional GitHub URLs.
    } finally {
      setIsLoading(false);
    }
  }, [isAuthenticated, m]);

  useEffect(() => {
    if (isAuthenticated) {
      void load();
    }
  }, [isAuthenticated, load]);

  /** Repositories matching the current search query and visibility filter.
   *
   * Repositories the backend checked as HTML-less (hasHtml === false) are
   * omitted entirely — the CMS cannot edit them; unknown/null stays. */
  const visibleRepositories = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    return repositories.filter((repo) => {
      if (repo.hasHtml === false) return false;
      const matchesVisibility =
        visibility === 'all' ||
        (visibility === 'public' && !repo.isPrivate) ||
        (visibility === 'private' && repo.isPrivate);

      if (!query) return matchesVisibility;

      const haystack = `${repo.fullName} ${repo.description ?? ''}`.toLowerCase();
      return matchesVisibility && haystack.includes(query);
    });
  }, [repositories, searchQuery, visibility]);

  if (authLoading) {
    return <Spinner label={m.common.loadingSession} />;
  }

  if (!isAuthenticated) {
    return (
      <section className="auth-card">
        <h2>{m.auth.signInToStartTitle}</h2>
        <p>{m.auth.signInToStartBody}</p>
        <button type="button" className="btn btn--primary" onClick={login}>
          {m.header.signInGithub}
        </button>
        <Link className="auth-card__client-link" to="/login">
          {m.auth.clientLink}
        </Link>
      </section>
    );
  }

  const filterLabels: Record<VisibilityFilter, string> = {
    all: m.repositories.filterAll,
    public: m.repositories.filterPublic,
    private: m.repositories.filterPrivate,
  };

  return (
    <section className="page repositories">
      <div className="repositories__guide">
        <p className="repositories__kicker">{m.repositories.title}</p>
        <h2 className="repositories__title">{m.repositories.selectGuide}</h2>
      </div>

      {error && <ErrorBanner onDismiss={() => setError(null)}>{error}</ErrorBanner>}

      <div className="repositories-toolbar">
        <div className="repo-toolbar">
          <input
            type="search"
            className="repo-toolbar__search"
            placeholder={m.repositories.searchPlaceholder}
            aria-label={m.repositories.searchAria}
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
          />
          <div className="repo-toolbar__filters" role="group" aria-label={m.repositories.filterAria}>
            {(['all', 'public', 'private'] as const).map((option) => (
              <button
                key={option}
                type="button"
                className={`repo-toolbar__filter${visibility === option ? ' repo-toolbar__filter--active' : ''}`}
                onClick={() => setVisibility(option)}
              >
                {filterLabels[option]}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="btn repositories-toolbar__refresh"
            onClick={() => void load()}
            disabled={isLoading}
          >
            {m.common.refresh}
          </button>
        </div>
      </div>

      {isLoading ? (
        <ul className="repositories-grid" aria-hidden="true">
          <li className="repo-tile--shimmer" />
          <li className="repo-tile--shimmer" />
          <li className="repo-tile--shimmer" />
          <li className="repo-tile--shimmer" />
        </ul>
      ) : repositories.length === 0 ? (
        <p className="page-status">{m.repositories.empty}</p>
      ) : visibleRepositories.length === 0 ? (
        <p className="page-status">{m.repositories.noMatch}</p>
      ) : (
        <ul className="repositories-grid">
          {visibleRepositories.map((repo, index) => (
            <li key={repo.fullName} style={{ '--i': index } as CSSProperties}>
              <RepoTile
                repo={repo}
                size="tile"
                onSelect={() => navigate(`/repositories/${repo.owner}/${repo.name}/pages`)}
                liveUrls={
                  liveUrlByRepo.get(repo.fullName)
                    ? [liveUrlByRepo.get(repo.fullName)!]
                    : []
                }
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
