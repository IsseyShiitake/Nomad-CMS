import { apiRequest } from './client';
import { encodePath } from '@cms/shared';
import type {
  GetPageResponse,
  ListPagesResponse,
  ListRepositoriesResponse,
  Page,
  PageSummary,
  Repository,
  RepositoryFile,
  SavePageResponse,
  SavePageResult,
} from '@cms/shared';

/**
 * Repository API endpoints.
 *
 * All GitHub interactions are proxied through the backend so the frontend
 * never holds GitHub credentials. Authentication is via the HttpOnly session
 * cookie (sent automatically); no token is passed explicitly.
 */

/** Lists repositories the authenticated user can access. */
export async function listRepositories(): Promise<Repository[]> {
  return apiRequest<ListRepositoriesResponse>('/api/repositories', {});
}

/** Fetches a single repository's metadata. */
export async function getRepository(owner: string, repo: string): Promise<Repository> {
  return apiRequest<Repository>(`/api/repositories/${owner}/${repo}`, {});
}

/** Lists files and directories at a repository path. */
export async function listContents(
  owner: string,
  repo: string,
  path: string,
): Promise<RepositoryFile[]> {
  const suffix = path ? `/${encodePath(path)}` : '';
  return apiRequest<RepositoryFile[]>(`/api/repositories/${owner}/${repo}/contents${suffix}`, {});
}

/** Discovers all HTML files in a repository. */
export async function listPages(owner: string, repo: string): Promise<PageSummary[]> {
  return apiRequest<ListPagesResponse>(`/api/repositories/${owner}/${repo}/pages`, {});
}

/** Fetches a single page's raw HTML. */
export async function getPage(owner: string, repo: string, path: string): Promise<Page> {
  return apiRequest<GetPageResponse>(
    `/api/repositories/${owner}/${repo}/pages/${encodePath(path)}`,
    {},
  );
}

/**
 * Saves (commits) a page's HTML back to the repository.
 */
export async function savePage(
  owner: string,
  repo: string,
  path: string,
  content: string,
  sha: string | null,
): Promise<SavePageResult> {
  return apiRequest<SavePageResponse>(
    `/api/repositories/${owner}/${repo}/pages/${encodePath(path)}`,
    {
      method: 'PUT',
      body: JSON.stringify({ content, sha }),
    },
  );
}
