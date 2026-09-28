/**
 * GitHub API client.
 *
 * Server-side wrapper around the GitHub REST API. The Worker is
 * the only component that holds GitHub tokens; this client is
 * instantiated per-request with the user's stored token.
 *
 * SECURITY: tokens are passed in the Authorization header and
 * never logged or returned to the frontend.
 */

import { encodePath } from '@cms/shared';
import type {
  ImageAsset,
  Repository,
  RepositoryFile,
  UserProfile,
} from '@cms/shared';

/** GitHub user object from the API. */
interface GitHubUser {
  id: number;
  login: string;
  name: string | null;
  avatar_url: string | null;
}

/** GitHub repository object from the API. */
interface GitHubRepo {
  id: number;
  name: string;
  owner: { login: string; avatar_url: string | null };
  full_name: string;
  default_branch: string;
  description: string | null;
  private: boolean;
  homepage?: string | null;
  html_url: string;
  updated_at: string;
}

/** GitHub contents entry from the API. */
interface GitHubContentEntry {
  name: string;
  path: string;
  type: 'file' | 'dir';
  size: number;
  sha: string;
}

/** GitHub file object from the contents API. */
interface GitHubFile {
  name: string;
  path: string;
  sha: string;
  size: number;
  encoding: string;
  content: string;
  type: 'file';
}

/** Git tree item from the trees API. */
interface GitHubTreeItem {
  path: string;
  type: 'blob' | 'tree';
  sha: string;
  size?: number;
}

/** Git tree response. */
interface GitHubTree {
  tree: GitHubTreeItem[];
  truncated: boolean;
}

/** Response from the contents write API. */
interface GitHubWriteResponse {
  content: {
    name: string;
    path: string;
    sha: string;
    size: number;
  };
}

/** Upper bound on upstream API latency before the request is aborted. */
const REQUEST_TIMEOUT_MS = 30_000;

/** Valid characters for a GitHub owner or repository name segment. */
const OWNER_REPO_RE = /^[A-Za-z0-9_.-]+$/;

/** True when owner/repo are safe to interpolate into GitHub API URLs. */
export function isValidOwnerRepo(owner: string, repo: string): boolean {
  return OWNER_REPO_RE.test(owner) && OWNER_REPO_RE.test(repo);
}

/** A decoded file read from a repository. */
export interface ReadFileResult {
  path: string;
  content: string;
  sha: string | null;
}

/**
 * Thrown when a write fails because the file changed on the remote
 * since it was read (GitHub returns HTTP 409). The caller should
 * surface this to the user as a merge conflict.
 */
export class MergeConflictError extends Error {
  constructor(message = 'The file was modified on the remote.') {
    super(message);
    this.name = 'MergeConflictError';
  }
}

/** A GitHub REST API error carrying the upstream HTTP status. */
export class GitHubError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'GitHubError';
  }
}

/** GitHub rate limit (HTTP 429, or 403 with X-RateLimit-Remaining: 0). */
export class RateLimitError extends GitHubError {
  readonly retryAfter: number | null;
  constructor(retryAfter: number | null) {
    super(429, 'GitHub rate limit exceeded');
    this.name = 'RateLimitError';
    this.retryAfter = retryAfter;
  }
}

/** Thrown when the recursive git tree is truncated (the repo is too large to enumerate fully). */
export class TreeTruncatedError extends Error {
  constructor(message = 'Repository tree is truncated; some files are omitted.') {
    super(message);
    this.name = 'TreeTruncatedError';
  }
}

/** GitHub API client bound to a single user token. */
export class GitHubClient {
  private static readonly API_BASE = 'https://api.github.com';

  /** User-Agent sent with every GitHub API request.
   *
   * GitHub rejects requests that omit a User-Agent header (HTTP 403
   * "Request forbidden by administrative rules"). A stable, unique
   * app identifier is the recommended value — not a browser string. */
  private static readonly USER_AGENT = 'static-site-cms';

  constructor(private readonly token: string) {}

  /** Performs a JSON request against the GitHub API. */
  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`${GitHubClient.API_BASE}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': GitHubClient.USER_AGENT,
        ...(init.headers ?? {}),
      },
      // Bounded latency: a hung upstream surfaces as an error instead of
      // pinning the request (and the frontend's own 30s abort) forever.
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      // A 409 from the contents API means the file's sha no longer matches
      // the remote — a merge conflict.
      if (response.status === 409) {
        throw new MergeConflictError();
      }
      // GitHub signals rate limiting with HTTP 429, or 403 plus
      // X-RateLimit-Remaining: 0 (primary limit) / a Retry-After header
      // (secondary limit). Surface these distinctly so the route can
      // return 429 with Retry-After instead of a generic 502.
      if (response.status === 429 || response.headers.get('X-RateLimit-Remaining') === '0') {
        const retryHeader = response.headers.get('Retry-After');
        const parsed = retryHeader ? Number.parseInt(retryHeader, 10) : NaN;
        throw new RateLimitError(Number.isFinite(parsed) ? parsed : null);
      }
      const body = await response.text();
      throw new GitHubError(response.status, `GitHub API ${response.status}: ${body.slice(0, 300)}`);
    }
    return (await response.json()) as T;
  }

  /** Fetches the authenticated user's public profile. */
  async getUser(): Promise<UserProfile> {
    const user: GitHubUser = await this.request('/user');
    return {
      id: user.id,
      login: user.login,
      name: user.name,
      avatarUrl: user.avatar_url,
    };
  }

  /** Lists repositories the user can access.
   *
   * Pages through the full listing (a single per_page=100 call silently
   * truncates at 100 repos); a short page ends the loop. The 20-page bound
   * guards against a misbehaving endpoint, matching the platform clients. */
  async listRepositories(perPage = 100): Promise<Repository[]> {
    const out: GitHubRepo[] = [];
    for (let page = 1; page <= 20; page += 1) {
      const batch = await this.request<GitHubRepo[]>(
        `/user/repos?per_page=${perPage}&page=${page}&sort=updated&affiliation=owner,collaborator`,
      );
      out.push(...batch);
      if (batch.length < perPage) break;
    }
    return out.map((repo) => this.mapRepository(repo));
  }

  /** Fetches a single repository's metadata. */
  async getRepository(owner: string, repo: string): Promise<Repository> {
    const data: GitHubRepo = await this.request(`/repos/${owner}/${repo}`);
    return this.mapRepository(data);
  }

  /** Recursively lists every file in a repository's default branch. */
  async listTree(owner: string, repo: string, branch: string): Promise<GitHubTreeItem[]> {
    const data: GitHubTree = await this.request(
      `/repos/${owner}/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
    );
    if (data.truncated) {
      throw new TreeTruncatedError();
    }
    return data.tree;
  }

  /** Whether the repository's default branch contains any HTML file.
   *
   * One recursive-tree request against the fixed HEAD ref. A truncated
   * tree that already shows an HTML blob is a definite yes; truncated
   * with no hit is inconclusive, so it still reports yes (a repo is
   * never hidden on a technicality). GitHub answers HTTP 409 for an
   * empty repository — request() shapes that as MergeConflictError —
   * which is a definite no. */
  async hasHtmlFiles(owner: string, repo: string): Promise<boolean> {
    let data: GitHubTree;
    try {
      data = await this.request<GitHubTree>(
        `/repos/${owner}/${repo}/git/trees/HEAD?recursive=1`,
      );
    } catch (error) {
      if (error instanceof MergeConflictError) {
        return false;
      }
      throw error;
    }
    const hasHtml = data.tree.some(
      (item) => item.type === 'blob' && /\.html?$/i.test(item.path),
    );
    return hasHtml || data.truncated;
  }

  /** Lists files and directories at a repository path. */
  async listContents(owner: string, repo: string, path: string): Promise<RepositoryFile[]> {
    const encodedPath = path ? `/${encodePath(path)}` : '';
    const data: GitHubContentEntry[] = await this.request(
      `/repos/${owner}/${repo}/contents${encodedPath}`,
    );
    return data.map((entry) => ({
      path: entry.path,
      name: entry.name,
      type: entry.type,
      size: entry.size,
      sha: entry.sha,
    }));
  }

  /** Reads a file's raw decoded content from a repository. */
  async readFile(owner: string, repo: string, path: string): Promise<ReadFileResult> {
    const data: GitHubFile = await this.request(
      `/repos/${owner}/${repo}/contents/${encodePath(path)}`,
    );

    // GitHub's contents API returns HTTP 200 with an EMPTY content string
    // for files between 1 MB and 100 MB (only the raw media type carries
    // the bytes). Serving that empty string would make the editor load the
    // page as blank — and a save would commit the blank over the real
    // file. Fall back to the raw host in that case.
    if (data.size > 0 && !data.content) {
      const response = await fetch(
        `https://raw.githubusercontent.com/${owner}/${repo}/HEAD/${encodePath(path)}`,
        {
          headers: {
            Authorization: `Bearer ${this.token}`,
            'User-Agent': GitHubClient.USER_AGENT,
          },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        },
      );
      if (!response.ok) {
        throw new GitHubError(response.status, `raw fetch ${response.status}`);
      }
      const content = new TextDecoder().decode(await response.arrayBuffer());
      return { path: data.path, content, sha: data.sha };
    }

    const content = this.decodeBase64(data.content);
    return { path: data.path, content, sha: data.sha };
  }

  /**
   * Reads a repository file as raw bytes from its default branch.
   *
   * Unlike `readFile` this returns binary content untouched (no base64
   * round-trip, no UTF-8 decode), so it serves images, fonts, and any
   * other asset the editor preview needs. Token auth makes it work for
   * private repositories too. The fixed ref "HEAD" resolves to the
   * repository's default branch without a prior metadata request.
   */
  async readRawFile(owner: string, repo: string, path: string): Promise<Uint8Array> {
    const response = await fetch(
      `https://raw.githubusercontent.com/${owner}/${repo}/HEAD/${encodePath(path)}`,
      {
        headers: {
          Authorization: `Bearer ${this.token}`,
          'User-Agent': GitHubClient.USER_AGENT,
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
    );
    if (!response.ok) {
      throw new GitHubError(response.status, `raw fetch ${response.status}`);
    }
    return new Uint8Array(await response.arrayBuffer());
  }
  /**
   * Writes (creates or updates) a text file in a repository.
   *
   * Uses the GitHub contents API. When `sha` is provided the write
   * is optimistic: GitHub rejects it with a 409 (surfaced as a
   * MergeConflictError) if the remote file has changed.
   */
  async writeFile(
    owner: string,
    repo: string,
    path: string,
    content: string,
    sha: string | null,
    message: string,
  ): Promise<{ path: string; sha: string }> {
    const body: Record<string, string> = {
      message,
      content: this.encodeBase64(content),
    };
    if (sha) {
      body.sha = sha;
    }

    const data: GitHubWriteResponse = await this.request(
      `/repos/${owner}/${repo}/contents/${encodePath(path)}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
    );

    return { path: data.content.path, sha: data.content.sha };
  }

  /**
   * Uploads a binary image to a repository.
   *
   * The image bytes are base64-encoded and committed via the
   * contents API. When `existingSha` carries the current blob's sha
   * (the images listing provides it) the upload REPLACES the file; without
   * it GitHub answers 422 once the path exists. A stale sha surfaces as a
   * 409 merge conflict, same as page saves.
   */
  async uploadImage(
    owner: string,
    repo: string,
    path: string,
    bytes: Uint8Array,
    mimeType: string,
    message: string,
    existingSha: string | null = null,
  ): Promise<ImageAsset> {
    const body: Record<string, string> = {
      message,
      content: this.encodeBase64Bytes(bytes),
    };
    if (existingSha) {
      body.sha = existingSha;
    }

    const data: GitHubWriteResponse = await this.request(
      `/repos/${owner}/${repo}/contents/${encodePath(path)}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
    );

    return {
      path: data.content.path,
      name: data.content.name,
      size: data.content.size,
      mimeType,
      sha: data.content.sha,
      updatedAt: null,
    };
  }
  /** Maps a GitHub repo object to the shared Repository type. */
  private mapRepository(repo: GitHubRepo): Repository {
    return {
      id: repo.id,
      name: repo.name,
      owner: repo.owner.login,
      fullName: repo.full_name,
      defaultBranch: repo.default_branch,
      description: repo.description,
      isPrivate: repo.private,
      homepage: repo.homepage ?? null,
      htmlUrl: repo.html_url,
      updatedAt: repo.updated_at,
    };
  }

  /** Decodes GitHub's base64 file content into a UTF-8 string. */
  private decodeBase64(value: string): string {
    const clean = value.replace(/\s/g, '');
    const binary = atob(clean);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  }

  /** Encodes a UTF-8 string to base64 for the contents API. */
  private encodeBase64(value: string): string {
    const bytes = new TextEncoder().encode(value);
    return this.encodeBase64Bytes(bytes);
  }

  /** Encodes raw bytes to base64 for the contents API.
   *
   * Builds the binary string in 32 KiB chunks (same pattern as the session
   * store) instead of concatenating one character per byte — a 10 MiB image
   * would otherwise perform 10 million string concatenations. */
  private encodeBase64Bytes(bytes: Uint8Array): string {
    const chunkSize = 0x8000;
    let binary = '';
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
  }
}